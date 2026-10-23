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
import type { ByteOffset } from "../../types/branded.js";
import { byteOffset, pieceID } from "../../types/branded.js";
import { withUnloadedLineCounts, withState } from "../core/state.js";
import {
  insertChunkPieceAt,
  isChunkByteLengthValid,
  pieceTableDelete,
} from "../core/piece-table.js";
import { hasAttentionForPiece } from "../core/attention.js";
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
const emptySummary: ChunkSummary = { min: Infinity, max: -Infinity, hasAdd: false };

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

function findReloadInsertionPos(root: PieceNode | null, targetChunkIndex: number): number {
  function find(node: PieceNode | null, offset: number): number | null {
    if (!node || summarizeChunks(node).max <= targetChunkIndex) return null;
    const ownStart = offset + (node.left?.subtreeLength ?? 0);
    const left = find(node.left, offset);
    if (left !== null) return left;
    if (node.bufferType === "chunk" && node.chunkIndex > targetChunkIndex) return ownStart;
    return find(node.right, ownStart + node.length);
  }
  return find(root, 0) ?? root?.subtreeLength ?? 0;
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

function hasAttentionAnchoredToChunk(state: DocumentState, chunkIndex: number): boolean {
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
