/**
 * Pure chunk action transitions.
 *
 * Chunk loading and eviction coordinate piece ordering, line-index caches,
 * UTF-8/CRLF boundary handling, and immutable chunk metadata. Keeping those
 * transitions here leaves the document reducer as an action router and gives
 * the chunk lifecycle a focused test boundary.
 */

import type { DocumentState, LineIndexState, PieceNode } from "../../types/state.js";
import { pstackSize } from "../../types/state.js";
import type {
  DeclareChunkMetadataAction,
  EvictChunkAction,
  EvictChunksAction,
  LoadChunkAction,
  LoadChunksAction,
} from "../../types/actions.js";
import { isValidChunkMetadata } from "../../types/actions.js";
import type { ByteOffset } from "../../types/branded.js";
import { byteOffset, pieceID } from "../../types/branded.js";
import { withUnloadedLineCounts, withState } from "../core/state.js";
import {
  insertChunkPieceAt,
  isChunkByteLengthValid,
  pieceTableDelete,
} from "../core/piece-table.js";
import { hasAttentionForPiece } from "../core/attention.js";
import { deriveLoadedChunks, keySpan } from "../core/chunk-anchor.js";
import {
  carrySelectionAcrossChunks,
  historyForEviction,
  historyLossForEviction,
  totalLoss,
  type EvictionHistoryLoss,
} from "./history-anchor.js";
import { createFewestLossQueue } from "./fewest-loss-queue.js";
import { repairChunkLines } from "../core/chunk-line-repair.js";
import { summarizeBytes } from "../core/decoded-metrics.js";
import { PersistentMap, PersistentSet } from "../core/persistent-map.js";
import { asReadonlyMap, asReadonlySet, asReadonlyUint8Array } from "../core/runtime-readonly.js";

interface ChunkSummary {
  min: number;
  max: number;
  hasAdd: boolean;
}
const chunkSummaries = new WeakMap<PieceNode, ChunkSummary>();
const emptySummary: ChunkSummary = {
  min: Infinity,
  max: -Infinity,
  hasAdd: false,
};

// Immutable subtrees share their summaries across edits and viewport changes.
function summarizeChunks(root: PieceNode | null): ChunkSummary {
  if (!root) return emptySummary;
  const cached = chunkSummaries.get(root);
  if (cached) return cached;
  const left = summarizeChunks(root.left),
    right = summarizeChunks(root.right);
  const chunk = root.bufferType === "chunk" ? root.chunkIndex : undefined;
  const summary = {
    min: Math.min(left.min, right.min, chunk ?? Infinity),
    max: Math.max(left.max, right.max, chunk ?? -Infinity),
    hasAdd: left.hasAdd || right.hasAdd || root.bufferType === "add",
  };
  chunkSummaries.set(root, summary);
  return summary;
}

function visitChunk(
  root: PieceNode | null,
  chunkIndex: number,
  visit: (node: PieceNode, offset: number) => boolean | void,
  offset = 0,
): boolean {
  if (!root) return false;
  const summary = summarizeChunks(root);
  if (chunkIndex < summary.min || chunkIndex > summary.max) return false;
  const ownStart = offset + (root.left?.subtreeLength ?? 0);
  return (
    visitChunk(root.left, chunkIndex, visit, offset) ||
    (root.bufferType === "chunk" &&
      root.chunkIndex === chunkIndex &&
      visit(root, ownStart) === true) ||
    visitChunk(root.right, chunkIndex, visit, ownStart + root.length)
  );
}

function findPristineChunkRange(
  root: PieceNode | null,
  chunkIndex: number,
  chunkByteLength: number,
): { start: ByteOffset; end: ByteOffset } | null {
  let start = -1,
    end = -1,
    expectedChunkOffset = 0;
  const invalid = visitChunk(root, chunkIndex, (node, offset) => {
    if (start < 0) start = offset;
    else if (offset !== end) return true;
    if (node.start !== expectedChunkOffset || expectedChunkOffset + node.length > chunkByteLength)
      return true;
    expectedChunkOffset += node.length;
    end = offset + node.length;
  });
  return invalid || start < 0 || expectedChunkOffset !== chunkByteLength
    ? null
    : { start: byteOffset(start), end: byteOffset(end) };
}

function hasAddPieceTouchingRange(
  root: PieceNode | null,
  rangeStart: ByteOffset,
  rangeEnd: ByteOffset,
  offset = 0,
): boolean {
  if (
    !root ||
    offset > rangeEnd ||
    offset + root.subtreeLength < rangeStart ||
    !summarizeChunks(root).hasAdd
  )
    return false;
  const ownStart = offset + (root.left?.subtreeLength ?? 0);
  return (
    (root.bufferType === "add" && ownStart <= rangeEnd && ownStart + root.length >= rangeStart) ||
    hasAddPieceTouchingRange(root.left, rangeStart, rangeEnd, offset) ||
    hasAddPieceTouchingRange(root.right, rangeStart, rangeEnd, ownStart + root.length)
  );
}

export function hasAttentionAnchoredToChunk(state: DocumentState, chunkIndex: number): boolean {
  if (state.attention.attentions.size === 0) return false;
  return visitChunk(state.pieceTable.root, chunkIndex, (node) =>
    hasAttentionForPiece(state.attention, node.id),
  );
}

export function declareChunkMetadata(
  state: DocumentState,
  action: DeclareChunkMetadataAction,
): DocumentState {
  if (state.pieceTable.chunkSize === 0 || !action.metadata.every(isValidChunkMetadata)) {
    return state;
  }

  const { chunkSize, totalFileSize } = state.pieceTable;
  const expectedChunkCount = totalFileSize > 0 ? Math.ceil(totalFileSize / chunkSize) : undefined;
  const entriesByIndex = new Map<number, (typeof action.metadata)[number]>();

  // Validate the complete declaration before changing either side-cache. The
  // reducer is the final invariant boundary because callers may dispatch the
  // public action directly instead of going through StreamingDocumentLoader.
  for (const entry of action.metadata) {
    if (entry.byteLength === 0 || entry.byteLength > chunkSize) return state;
    if (expectedChunkCount !== undefined) {
      if (entry.chunkIndex >= expectedChunkCount) return state;
      const expectedByteLength = Math.min(chunkSize, totalFileSize - entry.chunkIndex * chunkSize);
      if (entry.byteLength !== expectedByteLength) return state;
    }

    const priorInAction = entriesByIndex.get(entry.chunkIndex);
    if (
      priorInAction !== undefined &&
      (priorInAction.byteLength !== entry.byteLength || priorInAction.lineCount !== entry.lineCount)
    ) {
      return state;
    }
    entriesByIndex.set(entry.chunkIndex, entry);

    const prior = state.pieceTable.chunkMetadata.get(entry.chunkIndex);
    if (
      prior !== undefined &&
      (prior.byteLength !== entry.byteLength || prior.lineCount !== entry.lineCount)
    ) {
      return state;
    }
  }

  const metadata = new Map(state.pieceTable.chunkMetadata);
  const unloadedCounts = new Map(state.lineIndex.unloadedLineCountsByChunk);
  let changed = false;
  for (const entry of entriesByIndex.values()) {
    if (state.pieceTable.loadedChunks.has(entry.chunkIndex)) continue;
    if (metadata.has(entry.chunkIndex)) continue;
    metadata.set(entry.chunkIndex, entry);
    unloadedCounts.set(entry.chunkIndex, entry.lineCount);
    changed = true;
  }
  if (!changed) return state;

  return withState(state, {
    pieceTable: Object.freeze({ ...state.pieceTable, chunkMetadata: metadata }),
    lineIndex: withUnloadedLineCounts(
      state.lineIndex,
      unloadedCounts,
      state.lineIndex.unloadedLineCount +
        [...entriesByIndex.values()].reduce(
          (sum, entry) =>
            sum +
            (!state.pieceTable.loadedChunks.has(entry.chunkIndex) &&
            !state.pieceTable.chunkMetadata.has(entry.chunkIndex)
              ? entry.lineCount
              : 0),
          0,
        ),
    ),
  });
}

export function loadChunk(state: DocumentState, action: LoadChunkAction): DocumentState {
  return loadChunks(state, {
    type: "LOAD_CHUNKS",
    chunks: [action],
  });
}

export function loadChunks(state: DocumentState, action: LoadChunksAction): DocumentState {
  if (state.pieceTable.chunkSize === 0 || action.chunks.length === 0) return state;

  const prepared: Array<{ chunkIndex: number; data: Uint8Array }> = [];
  const seen = new Set<number>();
  for (const chunk of action.chunks) {
    if (seen.has(chunk.chunkIndex) || state.pieceTable.chunkMap.has(chunk.chunkIndex)) continue;
    seen.add(chunk.chunkIndex);
    const data = new Uint8Array(chunk.data);
    if (
      data.length === 0 ||
      !isChunkByteLengthValid(state.pieceTable, chunk.chunkIndex, data.length)
    ) {
      return state;
    }
    prepared.push({ chunkIndex: chunk.chunkIndex, data });
  }
  if (prepared.length === 0) return state;
  prepared.sort((a, b) => a.chunkIndex - b.chunkIndex);

  let root = state.pieceTable.root;
  let totalLength = state.pieceTable.totalLength;
  let nextPieceID = state.pieceTable.nextPieceID;
  let nextExpectedChunk = state.pieceTable.nextExpectedChunk;
  let chunkMap = PersistentMap.from(state.pieceTable.chunkMap);
  let loadedChunks = PersistentSet.from(state.pieceTable.loadedChunks);
  let unloadedCounts = PersistentMap.from(state.lineIndex.unloadedLineCountsByChunk);
  let pieceTable = state.pieceTable;
  let lineIndex = state.lineIndex;
  let unloadedLineCount = state.lineIndex.unloadedLineCount;

  for (const chunk of prepared) {
    // Before the first piece whose key is >= the chunk index: the first piece
    // of a higher chunk, or text recorded as lying after the chunk. For the
    // next chunk in order every key is below it, so that is the end.
    const insertionPos = byteOffset(keySpan(root, chunk.chunkIndex).start);
    const id = pieceID(`p${nextPieceID++}`);
    root = insertChunkPieceAt(root, insertionPos, chunk.chunkIndex, chunk.data.length, id);
    summarizeBytes(chunk.data); // Prepare reusable decoder summaries once during loading.
    chunkMap = chunkMap.with(chunk.chunkIndex, asReadonlyUint8Array(chunk.data));
    loadedChunks = loadedChunks.with(chunk.chunkIndex);
    totalLength += chunk.data.length;
    nextExpectedChunk = Math.max(nextExpectedChunk, chunk.chunkIndex + 1);

    const declaredLineCount = unloadedCounts.get(chunk.chunkIndex);
    if (declaredLineCount !== undefined) {
      unloadedCounts = unloadedCounts.without(chunk.chunkIndex);
      unloadedLineCount -= declaredLineCount;
    }
    const next = Object.freeze({
      ...pieceTable,
      root,
      chunkMap: asReadonlyMap(chunkMap),
      loadedChunks: asReadonlySet(loadedChunks),
      totalLength,
      nextPieceID,
      nextExpectedChunk,
    });
    lineIndex = repairChunkLines(
      lineIndex,
      next,
      insertionPos,
      insertionPos,
      chunk.data.length,
      state.revision + prepared.length,
    );
    pieceTable = next;
  }
  lineIndex = withUnloadedLineCounts(lineIndex, asReadonlyMap(unloadedCounts), unloadedLineCount);
  // Extend the loaded-chunk lengths instead of rebuilding them for the new map.
  deriveLoadedChunks(
    state.pieceTable.chunkMap,
    pieceTable.chunkMap,
    prepared.map((chunk) => [chunk.chunkIndex, chunk.data.length] as const),
    [],
  );

  return withState(state, {
    revision: state.revision + prepared.length,
    pieceTable,
    lineIndex,
    // Keep the cursor on the same text, as history positions are kept.
    selection: carrySelectionAcrossChunks(state.pieceTable, pieceTable, state.selection),
  });
}

type EvictableRange = { readonly start: ByteOffset; readonly end: ByteOffset } | null;

/**
 * The resident range of `chunkIndex` when only history could keep it from
 * being evicted, else null: it is not loaded, an attention is anchored to it,
 * or edits have split or touched it.
 */
function evictableRange(state: DocumentState, chunkIndex: number): EvictableRange {
  // The map lookup first: a chunk not loaded skips the attention walk.
  if (!state.pieceTable.chunkMap.has(chunkIndex)) return null;
  if (hasAttentionAnchoredToChunk(state, chunkIndex)) return null;
  return uneditedRange(state, chunkIndex);
}

/**
 * The resident range of `chunkIndex` when no edit has split or touched it,
 * else null, attentions aside.
 */
function uneditedRange(state: DocumentState, chunkIndex: number): EvictableRange {
  const chunkBytes = state.pieceTable.chunkMap.get(chunkIndex);
  if (chunkBytes === undefined) return null;
  const range = findPristineChunkRange(state.pieceTable.root, chunkIndex, chunkBytes.length);
  if (range === null || hasAddPieceTouchingRange(state.pieceTable.root, range.start, range.end)) {
    return null;
  }
  return range;
}

/**
 * What would keep the loaded chunk `chunkIndex` resident even with no
 * attention anchored to it: `"edits"` when edits have split or touched it,
 * `"history"` when history points inside it under `"pin"`, else null. Under
 * the other policies an over-limit eviction pass discards such history.
 */
export function chunkHoldReason(
  state: DocumentState,
  chunkIndex: number,
): "edits" | "history" | null {
  if (!state.pieceTable.chunkMap.has(chunkIndex)) return null;
  const range = uneditedRange(state, chunkIndex);
  if (range === null) return "edits";
  return state.history.evictionPolicy === "pin" &&
    totalLoss(historyLossForEviction(state.pieceTable, state.history, chunkIndex, range.start)) > 0
    ? "history"
    : null;
}

/**
 * The resident range of `chunkIndex` and how many undo and redo entries
 * evicting it discards when the policy lets it drop history (`"drop"`, or
 * `"pin-bounded"` with `overLimit`), or null when it cannot be evicted
 * whatever happens to history (see `evictableRange`). Under `"pin"`, only a
 * chunk with no loss evicts.
 */
export function evictionCandidate(
  state: DocumentState,
  chunkIndex: number,
): { readonly range: NonNullable<EvictableRange>; readonly loss: EvictionHistoryLoss } | null {
  const range = evictableRange(state, chunkIndex);
  if (range === null) return null;
  const loss = historyLossForEviction(state.pieceTable, state.history, chunkIndex, range.start);
  return { range, loss };
}

type ChunkMap = DocumentState["pieceTable"]["chunkMap"];

/**
 * The resident chunks of `chunkMap` whose standing against edits may differ
 * from when `previous` was the chunk map, history and attention unchanged.
 *
 * What keeps a chunk resident is history pointing inside it, an attention
 * anchored to it, or edits splitting or touching it (see
 * `evictionCandidate` and `chunkHoldReason`). Every edit, undo, redo, and history clear replaces
 * the history object, and every attention change the attention object. So
 * while both are unchanged, the text has changed only by chunks loaded or
 * evicted, which leave what history points inside a chunk, and the
 * attentions anchored to it, as they were. Evicting a chunk only brings text
 * together, and a chunk no edit touches has no add piece beside it to bring
 * to its neighbours. Loading one puts its text between the loaded chunks on
 * either side, which can part one of them from an add piece that touched it.
 * So the chunks returned are each chunk loaded since and the nearest resident
 * chunk below and above it.
 *
 * It lives beside `evictionCandidate` because it holds only while the rules
 * there do: a new reason to keep a chunk resident must keep it true, or callers
 * that cache which chunks cannot go (ChunkManager) miss chunks freed since.
 *
 * `previous` can be just the indices of the chunks then resident, which keeps
 * no chunk bytes in memory. Every load and eviction replaces the chunk map, so
 * when `previous` is `chunkMap` itself this costs O(1). Otherwise finding the
 * chunks loaded since costs O(L) for L resident chunks, and finding their
 * neighbours O(L log k) more for k of them.
 */
export function chunksMovedByLoads(
  previous: ChunkMap | ReadonlySet<number>,
  chunkMap: ChunkMap,
): ReadonlySet<number> {
  const moved = new Set<number>();
  if (chunkMap === previous) return moved;
  const loaded: number[] = [];
  for (const chunk of chunkMap.keys()) if (!previous.has(chunk)) loaded.push(chunk);
  if (loaded.length === 0) return moved;
  loaded.sort((a, b) => a - b);
  // The nearest resident chunk below and above each one loaded since. A chunk
  // with one loaded since between it and another is not the other's nearest.
  const below = loaded.map(() => -Infinity);
  const above = loaded.map(() => Infinity);
  for (const chunk of chunkMap.keys()) {
    // The first chunk loaded since that lies above `chunk`.
    let lo = 0;
    let hi = loaded.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (loaded[mid]! > chunk) hi = mid;
      else lo = mid + 1;
    }
    if (lo < loaded.length) below[lo] = Math.max(below[lo]!, chunk);
    const under = loaded[lo - 1] === chunk ? lo - 2 : lo - 1;
    if (under >= 0) above[under] = Math.min(above[under]!, chunk);
  }
  for (const chunk of loaded) moved.add(chunk);
  for (const chunk of below) if (chunk !== -Infinity) moved.add(chunk);
  for (const chunk of above) if (chunk !== Infinity) moved.add(chunk);
  return moved;
}

export function evictChunk(state: DocumentState, action: EvictChunkAction): DocumentState {
  const next = tryEvict(state, action.chunkIndex, action.overLimit === true);
  return next === null ? state : withSelectionCarried(state, next);
}

/**
 * `next`, which evicted chunks from `state`, with the selection of `state`
 * carried across: an offset inside an evicted chunk lands where the chunk was.
 * Carrying it once for a whole batch gives the selection carrying it across
 * each eviction would, since each endpoint keeps its chunk key.
 */
function withSelectionCarried(state: DocumentState, next: DocumentState): DocumentState {
  if (next === state) return state;
  const selection = carrySelectionAcrossChunks(state.pieceTable, next.pieceTable, state.selection);
  return selection === next.selection ? next : withState(next, { selection });
}

/**
 * Evict `chunkIndex` as EVICT_CHUNK does, or return null when it is refused:
 * the chunk cannot be evicted (see `evictableRange`), or history points
 * inside it and the policy keeps it (see `historyForEviction`).
 */
function tryEvict(state: DocumentState, chunkIndex: number, overLimit: boolean) {
  const range = evictableRange(state, chunkIndex);
  if (range === null) return null;
  // History positions survive eviction except those inside the chunk.
  const history = historyForEviction(
    state.pieceTable,
    state.history,
    chunkIndex,
    range.start,
    overLimit,
  );
  if (history === null) return null;
  return evictRange(state, chunkIndex, range, history);
}

/**
 * Remove `chunkIndex`, which lies at `range`, keeping `history`. The selection
 * is left as it was, for the caller to carry across (see
 * `withSelectionCarried`).
 */
function evictRange(
  state: DocumentState,
  chunkIndex: number,
  range: { readonly start: ByteOffset; readonly end: ByteOffset },
  history: DocumentState["history"],
): DocumentState {
  const deleted = pieceTableDelete(state.pieceTable, range.start, range.end);
  const nextChunkMap = PersistentMap.from(state.pieceTable.chunkMap).without(chunkIndex);
  const nextPieceTable = Object.freeze({ ...deleted, chunkMap: asReadonlyMap(nextChunkMap) });
  deriveLoadedChunks(state.pieceTable.chunkMap, nextPieceTable.chunkMap, [], [chunkIndex]);
  const nextRevision = state.revision + 1;
  let lineIndex: LineIndexState = repairChunkLines(
    state.lineIndex,
    nextPieceTable,
    range.start,
    range.end,
    0,
    nextRevision,
  );

  const metadata = state.pieceTable.chunkMetadata.get(chunkIndex);
  if (metadata !== undefined) {
    const counts = PersistentMap.from(lineIndex.unloadedLineCountsByChunk).with(
      chunkIndex,
      metadata.lineCount,
    );
    lineIndex = withUnloadedLineCounts(
      lineIndex,
      asReadonlyMap(counts),
      lineIndex.unloadedLineCount + metadata.lineCount,
    );
  }

  return withState(state, {
    revision: nextRevision,
    pieceTable: nextPieceTable,
    lineIndex,
    history,
  });
}

/**
 * Evict chunks from `chunkIndices` until at most `maxLoaded` chunks stay
 * loaded (see `EvictChunksAction`).
 *
 * First every candidate whose eviction discards no history, in the order
 * given, whatever the policy. A candidate that edits or an attention keep is
 * skipped. Only if that is not enough does history decide the rest, and never
 * under `"pin"`: `"drop"` takes them in the order given, and `"pin-bounded"`
 * takes the one that discards the fewest entries each time, which keeps as
 * much undo as the limit allows, with ties going to the earlier candidate
 * (see `createFewestLossQueue`). With `keepHistory`, it stops after the first
 * pass.
 *
 * Each candidate's loss is measured once, and the selection is carried across
 * once, after the last eviction. `reduceDocument` reports the history it
 * discarded (see `DocumentTransition`), and the store that commits it warns.
 */
export function evictChunks(state: DocumentState, action: EvictChunksAction): DocumentState {
  const { maxLoaded } = action;
  let next = state;
  const overLimit = () => next.pieceTable.chunkMap.size > maxLoaded;
  const lossy: { readonly chunk: number; readonly loss: EvictionHistoryLoss }[] = [];
  for (const chunk of new Set(action.chunkIndices)) {
    if (!overLimit()) break;
    const candidate = evictionCandidate(next, chunk);
    if (candidate === null) continue;
    const { range, loss } = candidate;
    if (totalLoss(loss) === 0) next = evictRange(next, chunk, range, next.history);
    else lossy.push({ chunk, loss });
  }

  const policy = next.history.evictionPolicy;
  if (action.keepHistory !== true && policy !== "pin" && lossy.length > 0) {
    // Evicting other chunks moved each candidate, so tryEvict reads its range
    // again. They cannot have made it unevictable: eviction adds no edits or
    // attention. Should it be refused anyway, no history was dropped, so the
    // other losses stay as measured.
    if (policy === "drop") {
      for (const { chunk } of lossy) {
        if (!overLimit()) break;
        next = tryEvict(next, chunk, true) ?? next;
      }
    } else {
      // Anything other than "drop" here gets the default "pin-bounded".
      const queue = createFewestLossQueue(lossy.map(({ loss }) => loss));
      while (overLimit()) {
        const pick = queue.take();
        if (pick === undefined) break;
        const evicted = tryEvict(next, lossy[pick.index]!.chunk, true);
        if (evicted === null) continue;
        // Report what the eviction dropped, not the predicted loss, so the
        // queue stays exact even if a prediction is off.
        const before = next.history;
        next = evicted;
        queue.dropped({
          undo: pstackSize(before.undoStack) - pstackSize(next.history.undoStack),
          redo: pstackSize(before.redoStack) - pstackSize(next.history.redoStack),
        });
      }
    }
  }
  return withSelectionCarried(state, next);
}
