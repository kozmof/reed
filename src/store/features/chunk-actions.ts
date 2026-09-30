/**
 * Pure chunk action transitions.
 *
 * Chunk loading and eviction coordinate piece ordering, line-index caches,
 * UTF-8/CRLF boundary handling, and immutable chunk metadata. Keeping those
 * transitions here leaves the document reducer as an action router and gives
 * the chunk lifecycle a focused test boundary.
 */

import type { DocumentState, LineIndexState, PieceNode } from "../../types/state.js";
import type {
  DeclareChunkMetadataAction,
  EvictChunkAction,
  LoadChunkAction,
  LoadChunksAction,
} from "../../types/actions.js";
import { isValidChunkMetadata } from "../../types/actions.js";
import type { ByteOffset, PieceID } from "../../types/branded.js";
import { byteOffset, pieceID } from "../../types/branded.js";
import { withUnloadedLineCounts, withState } from "../core/state.js";
import {
  insertChunkPieceAt,
  isChunkByteLengthValid,
  pieceTableInOrder,
  pieceTableDelete,
} from "../core/piece-table.js";
import { repairChunkLines } from "../core/chunk-line-repair.js";
import { summarizeBytes } from "../core/decoded-metrics.js";
import { PersistentMap, PersistentSet } from "../core/persistent-map.js";
import { asReadonlyMap, asReadonlySet, asReadonlyUint8Array } from "../core/runtime-readonly.js";

function findReloadInsertionPos(root: PieceNode | null, targetChunkIndex: number): number {
  if (root === null) return 0;
  let result = root.subtreeLength;
  pieceTableInOrder(root, (node, pieceStart) => {
    if (node.bufferType === "chunk" && node.chunkIndex > targetChunkIndex) {
      result = pieceStart;
      return true;
    }
  });
  return result;
}

function findPristineChunkRange(
  root: PieceNode | null,
  chunkIndex: number,
  chunkByteLength: number,
): { start: ByteOffset; end: ByteOffset } | null {
  if (root === null) return null;

  let rangeStart = -1;
  let rangeEnd = -1;
  let expectedChunkOffset = 0;
  let started = false;
  let complete = false;
  let invalid = false;

  pieceTableInOrder(root, (node, pieceStart) => {
    const isTarget = node.bufferType === "chunk" && node.chunkIndex === chunkIndex;
    if (!started) {
      if (!isTarget) return;
      started = true;
      rangeStart = pieceStart;
    } else if (complete) {
      if (isTarget) {
        invalid = true;
        return true;
      }
      return;
    }

    if (!isTarget) {
      invalid = true;
      return true;
    }
    if (node.start !== expectedChunkOffset || expectedChunkOffset + node.length > chunkByteLength) {
      invalid = true;
      return true;
    }

    expectedChunkOffset += node.length;
    rangeEnd = pieceStart + node.length;
    complete = expectedChunkOffset === chunkByteLength;
  });

  return invalid || !started || !complete || expectedChunkOffset !== chunkByteLength
    ? null
    : { start: byteOffset(rangeStart), end: byteOffset(rangeEnd) };
}

function hasAddPieceTouchingRange(
  root: PieceNode | null,
  rangeStart: ByteOffset,
  rangeEnd: ByteOffset,
): boolean {
  let found = false;
  pieceTableInOrder(root, (node, pieceStart) => {
    if (
      node.bufferType === "add" &&
      pieceStart <= rangeEnd &&
      pieceStart + node.length >= rangeStart
    ) {
      found = true;
      return true;
    }
  });
  return found;
}

/**
 * Return true when removing `chunkIndex` would delete a piece identity used by
 * an attention point. Offsets before/after other chunks resolve through the
 * current tree automatically; only removal of the anchored piece can dangle a
 * point, so eviction is refused just as it is for overlapping user edits.
 */
function hasAttentionAnchoredToChunk(state: DocumentState, chunkIndex: number): boolean {
  if (state.attention.attentions.size === 0) return false;

  const anchoredPieceIDs = new Set<PieceID>();
  for (const attention of state.attention.attentions.values()) {
    anchoredPieceIDs.add(attention.start.pieceID);
    anchoredPieceIDs.add(attention.end.pieceID);
  }

  let found = false;
  pieceTableInOrder(state.pieceTable.root, (node) => {
    if (
      node.bufferType === "chunk" &&
      node.chunkIndex === chunkIndex &&
      anchoredPieceIDs.has(node.id)
    ) {
      found = true;
      return true;
    }
  });
  return found;
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
    const isFirstLoad = !loadedChunks.has(chunk.chunkIndex);
    const isSequentialFirst = isFirstLoad && chunk.chunkIndex === nextExpectedChunk;
    const insertionPos = isSequentialFirst
      ? byteOffset(totalLength)
      : byteOffset(findReloadInsertionPos(root, chunk.chunkIndex));
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
      pieceTable,
      next,
      insertionPos,
      insertionPos,
      chunk.data.length,
      state.revision + prepared.length,
    );
    pieceTable = next;
  }
  lineIndex = withUnloadedLineCounts(lineIndex, asReadonlyMap(unloadedCounts), unloadedLineCount);

  return withState(state, {
    revision: state.revision + prepared.length,
    pieceTable,
    lineIndex,
  });
}

export function evictChunk(state: DocumentState, action: EvictChunkAction): DocumentState {
  const { chunkIndex } = action;
  const chunkBytes = state.pieceTable.chunkMap.get(chunkIndex);
  if (chunkBytes === undefined) return state;
  if (hasAttentionAnchoredToChunk(state, chunkIndex)) return state;

  const range = findPristineChunkRange(state.pieceTable.root, chunkIndex, chunkBytes.length);
  if (range === null || hasAddPieceTouchingRange(state.pieceTable.root, range.start, range.end)) {
    return state;
  }

  const deleted = pieceTableDelete(state.pieceTable, range.start, range.end);
  const nextChunkMap = PersistentMap.from(state.pieceTable.chunkMap).without(chunkIndex);
  const nextPieceTable = Object.freeze({ ...deleted, chunkMap: asReadonlyMap(nextChunkMap) });
  const nextRevision = state.revision + 1;
  let lineIndex: LineIndexState = repairChunkLines(
    state.lineIndex,
    state.pieceTable,
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
  });
}
