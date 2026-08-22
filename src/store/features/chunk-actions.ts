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
} from "../../types/actions.js";
import { isValidChunkMetadata } from "../../types/actions.js";
import type { ByteOffset, PieceID } from "../../types/branded.js";
import { byteLength, byteOffset, pieceID } from "../../types/branded.js";
import {
  createChunkPieceNode,
  withLineIndexState,
  withPieceNode,
  withState,
} from "../core/state.js";
import { appendToRightmost } from "../core/rb-tree.js";
import {
  insertChunkPieceAt,
  isChunkByteLengthValid,
  pieceTableInOrder,
} from "../core/piece-table.js";
import { rebuildLineIndexFromPieceTableState } from "./edit.js";

function appendChunkPiece(
  root: PieceNode | null,
  chunkIndex: number,
  chunkByteLength: number,
  id: PieceID,
): PieceNode {
  const leaf = createChunkPieceNode(
    chunkIndex,
    byteOffset(0),
    byteLength(chunkByteLength),
    "red",
    null,
    null,
    id,
  );
  return appendToRightmost(root, leaf, withPieceNode);
}

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

function buildBalancedPieceTree(
  pieces: readonly PieceNode[],
  lo: number,
  hi: number,
  depth = 0,
  deepestDepth = Math.floor(Math.log2(pieces.length)),
): PieceNode | null {
  if (lo > hi) return null;
  const count = hi - lo + 1;
  const height = Math.floor(Math.log2(count));
  const nodesAboveLast = 2 ** height - 1;
  const lastLevelNodes = count - nodesAboveLast;
  const leftCapacity = height === 0 ? 0 : 2 ** (height - 1);
  const leftSize = (height === 0 ? 0 : leftCapacity - 1) + Math.min(lastLevelNodes, leftCapacity);
  const mid = lo + leftSize;
  const source = pieces[mid]!;
  const left = buildBalancedPieceTree(pieces, lo, mid - 1, depth + 1, deepestDepth);
  const right = buildBalancedPieceTree(pieces, mid + 1, hi, depth + 1, deepestDepth);
  return Object.freeze({
    ...source,
    color: depth > 0 && depth === deepestDepth ? "red" : "black",
    left,
    right,
    subtreeLength: source.length + (left?.subtreeLength ?? 0) + (right?.subtreeLength ?? 0),
    subtreeAddLength:
      (source.bufferType === "add" ? source.length : 0) +
      (left?.subtreeAddLength ?? 0) +
      (right?.subtreeAddLength ?? 0),
  });
}

function removeChunkPiecesFromTree(
  root: PieceNode | null,
  targetChunk: number,
): { newRoot: PieceNode | null; removedLength: number } {
  const survivors: PieceNode[] = [];
  let removedLength = 0;
  pieceTableInOrder(root, (node) => {
    if (node.bufferType === "chunk" && node.chunkIndex === targetChunk) {
      removedLength += node.length;
    } else {
      survivors.push(node);
    }
  });
  return {
    newRoot:
      survivors.length === 0 ? null : buildBalancedPieceTree(survivors, 0, survivors.length - 1),
    removedLength,
  };
}

function rebalancePieceTree(root: PieceNode | null): PieceNode | null {
  const pieces: PieceNode[] = [];
  pieceTableInOrder(root, (node) => {
    pieces.push(node);
  });
  return pieces.length === 0 ? null : buildBalancedPieceTree(pieces, 0, pieces.length - 1);
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
    lineIndex: withLineIndexState(state.lineIndex, {
      unloadedLineCountsByChunk: unloadedCounts,
    }),
  });
}

export function loadChunk(state: DocumentState, action: LoadChunkAction): DocumentState {
  const { chunkIndex, data } = action;
  const { chunkSize, nextExpectedChunk, chunkMap, loadedChunks, totalLength } = state.pieceTable;
  if (chunkSize === 0 || chunkMap.has(chunkIndex)) return state;

  const chunkBytes = new Uint8Array(data);
  if (
    chunkBytes.length === 0 ||
    !isChunkByteLengthValid(state.pieceTable, chunkIndex, chunkBytes.length)
  ) {
    return state;
  }

  const isFirstLoad = !loadedChunks.has(chunkIndex);
  const isSequentialFirst = isFirstLoad && chunkIndex === nextExpectedChunk;
  const insertionPos = isSequentialFirst
    ? byteOffset(totalLength)
    : byteOffset(findReloadInsertionPos(state.pieceTable.root, chunkIndex));
  const nextChunkMap = new Map(chunkMap);
  nextChunkMap.set(chunkIndex, chunkBytes);
  const newPieceID = pieceID(`p${state.pieceTable.nextPieceID}`);
  const insertedRoot = isSequentialFirst
    ? appendChunkPiece(state.pieceTable.root, chunkIndex, chunkBytes.length, newPieceID)
    : insertChunkPieceAt(
        state.pieceTable.root,
        insertionPos,
        chunkIndex,
        chunkBytes.length,
        newPieceID,
      );
  const nextPieceTable = Object.freeze({
    ...state.pieceTable,
    root: rebalancePieceTree(insertedRoot),
    chunkMap: nextChunkMap,
    totalLength: totalLength + chunkBytes.length,
    nextPieceID: state.pieceTable.nextPieceID + 1,
    nextExpectedChunk: Math.max(nextExpectedChunk, chunkIndex + 1),
    loadedChunks: isFirstLoad ? new Set([...loadedChunks, chunkIndex]) : loadedChunks,
  });

  const nextRevision = state.revision + 1;
  let lineIndex = state.lineIndex;
  if (lineIndex.unloadedLineCountsByChunk.has(chunkIndex)) {
    const counts = new Map(lineIndex.unloadedLineCountsByChunk);
    counts.delete(chunkIndex);
    lineIndex = withLineIndexState(lineIndex, { unloadedLineCountsByChunk: counts });
  }

  // Chunk insertion can join arbitrary byte seams. Rebuild from the assembled
  // bytes so UTF-8 decoder state and CRLF pairing are always authoritative.
  const rebuilt = rebuildLineIndexFromPieceTableState(
    withState(state, { pieceTable: nextPieceTable, lineIndex }),
  );
  lineIndex = withLineIndexState(rebuilt.lineIndex, {
    unloadedLineCountsByChunk: lineIndex.unloadedLineCountsByChunk,
  });

  return withState(state, {
    revision: nextRevision,
    pieceTable: nextPieceTable,
    lineIndex,
  });
}

export function evictChunk(state: DocumentState, action: EvictChunkAction): DocumentState {
  const { chunkIndex } = action;
  const chunkBytes = state.pieceTable.chunkMap.get(chunkIndex);
  if (chunkBytes === undefined) return state;

  const range = findPristineChunkRange(state.pieceTable.root, chunkIndex, chunkBytes.length);
  if (range === null || hasAddPieceTouchingRange(state.pieceTable.root, range.start, range.end)) {
    return state;
  }

  const { newRoot, removedLength } = removeChunkPiecesFromTree(state.pieceTable.root, chunkIndex);
  const nextChunkMap = new Map(state.pieceTable.chunkMap);
  nextChunkMap.delete(chunkIndex);
  const nextPieceTable = Object.freeze({
    ...state.pieceTable,
    root: newRoot,
    chunkMap: nextChunkMap,
    totalLength: state.pieceTable.totalLength - removedLength,
  });
  const nextRevision = state.revision + 1;
  // Eviction can join bytes that were never adjacent while resident. Rebuild
  // from the assembled bytes so CRLF and UTF-8 decoder state are authoritative.
  const rebuilt = rebuildLineIndexFromPieceTableState(
    withState(state, { pieceTable: nextPieceTable }),
  );
  let lineIndex: LineIndexState = withLineIndexState(rebuilt.lineIndex, {
    unloadedLineCountsByChunk: state.lineIndex.unloadedLineCountsByChunk,
  });

  const metadata = state.pieceTable.chunkMetadata.get(chunkIndex);
  if (metadata !== undefined) {
    const counts = new Map(lineIndex.unloadedLineCountsByChunk);
    counts.set(chunkIndex, metadata.lineCount);
    lineIndex = withLineIndexState(lineIndex, { unloadedLineCountsByChunk: counts });
  }

  return withState(state, {
    revision: nextRevision,
    pieceTable: nextPieceTable,
    lineIndex,
  });
}
