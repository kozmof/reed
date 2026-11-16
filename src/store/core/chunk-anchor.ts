/**
 * Chunk placement keys and anchored positions.
 *
 * In chunk mode only some chunks are resident, so a resident byte offset does
 * not identify a place in the file: loading or evicting a chunk shifts every
 * offset after it. This module gives positions a coordinate that survives that.
 *
 * Placement key (K) of a resident byte: every chunk with index <= K lies wholly
 * before the byte, and every higher chunk lies after it.
 * - A byte of chunk `i` has key `i - 1`.
 * - A byte of an add piece has the key stored on the piece (`afterChunk`).
 * - A byte of the original buffer has key `-1`.
 * Keys never decrease in document order. `findReloadInsertionPos` relies on that
 * to place a loaded chunk `c` before the first piece whose key is >= c.
 *
 * Anchored position: the pair (K, n) with
 *   n = residentOffset - (sum of original lengths of loaded chunks with index <= K).
 * Loading or evicting a chunk `c <= K` changes both terms by the chunk length,
 * and a chunk `c > K` changes neither, so the pair stays valid while chunks
 * come and go. History stores positions this way.
 */

import type { PieceNode, PieceTableState } from "../../types/state.js";
import type { ReadonlyUint8Array } from "../../types/branded.js";

/** Key for positions before every chunk, and for every position without chunking. */
export const NO_CHUNK = -1;

/** Placement key of the bytes in `piece` (constant across the piece). */
export function pieceKey(piece: PieceNode): number {
  switch (piece.bufferType) {
    case "chunk":
      return piece.chunkIndex - 1;
    case "add":
      return piece.afterChunk;
    case "original":
      return NO_CHUNK;
  }
}

/**
 * Key just after the last byte of a piece with key `key`, when nothing follows
 * it. `chunkIndex` is the chunk of a chunk piece and null otherwise: after a
 * chunk piece, that whole chunk lies before the position.
 */
function endGapKey(key: number, chunkIndex: number | null): number {
  return chunkIndex ?? key;
}

function keyAfterPiece(piece: PieceNode): number {
  return endGapKey(pieceKey(piece), piece.bufferType === "chunk" ? piece.chunkIndex : null);
}

/** The piece holding resident byte `offset`, or null when `offset` is out of range. */
function pieceAtByte(root: PieceNode | null, offset: number): PieceNode | null {
  let node = root;
  let remaining = offset;
  while (node !== null) {
    const leftLength = node.left?.subtreeLength ?? 0;
    if (remaining < leftLength) {
      node = node.left;
    } else if (remaining < leftLength + node.length) {
      return node;
    } else {
      remaining -= leftLength + node.length;
      node = node.right;
    }
  }
  return null;
}

function lastPiece(root: PieceNode | null): PieceNode | null {
  let node = root;
  while (node?.right) node = node.right;
  return node;
}

/** Placement key of the resident byte at `offset` (`offset < totalLength`). */
export function byteKey(root: PieceNode | null, offset: number): number {
  const piece = pieceAtByte(root, offset);
  return piece === null ? gapKey(root, offset) : pieceKey(piece);
}

/**
 * Placement key for the gap at resident `offset`, which is the key new text
 * inserted there receives.
 *
 * Text attaches to the content after it: when chunks that are not resident sit
 * between the bytes on either side, the text goes after those chunks. At the
 * end of the document, it attaches to the content before it instead, so text
 * typed at the end of a partially streamed file stays before later chunks.
 */
export function gapKey(root: PieceNode | null, offset: number): number {
  if (root === null) return NO_CHUNK;
  if (offset < root.subtreeLength) return pieceKey(pieceAtByte(root, offset)!);
  return keyAfterPiece(lastPiece(root)!);
}

/** One piece of an in-order piece list, for callers without a piece tree. */
export interface FlatPiece {
  readonly length: number;
  /** Placement key of the piece's bytes (see `pieceKey`). */
  readonly key: number;
  /** Chunk of a chunk piece, or null for other pieces. */
  readonly chunkIndex: number | null;
}

/**
 * `gapKey` over an in-order piece list instead of a piece tree, with the same
 * rules. The v1 checkpoint migration uses it on wire data, before any tree
 * exists. Building the lookup is O(n), and each call is O(log n).
 */
export function flatGapKey(pieces: readonly FlatPiece[]): (offset: number) => number {
  const starts: number[] = [];
  const keys: number[] = [];
  let total = 0;
  let endKey = NO_CHUNK;
  for (const piece of pieces) {
    if (piece.length <= 0) continue;
    starts.push(total);
    keys.push(piece.key);
    total += piece.length;
    endKey = endGapKey(piece.key, piece.chunkIndex);
  }
  return (offset) => {
    if (offset >= total) return endKey;
    // The last piece starting at or before `offset` holds that byte.
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return keys[lo]!;
  };
}

/** Total length of the pieces whose placement key is at most `key`. O(log n). */
function lengthWithKeyAtMost(root: PieceNode | null, key: number): number {
  // Keys never decrease in document order, so the pieces with key <= `key`
  // form a prefix of the document.
  let node = root;
  let length = 0;
  while (node !== null) {
    if (pieceKey(node) <= key) {
      length += (node.left?.subtreeLength ?? 0) + node.length;
      node = node.right;
    } else {
      node = node.left;
    }
  }
  return length;
}

/**
 * Resident span [start, end] of the gaps whose key is `key`.
 *
 * Every resident position recorded with key `key` lies in this span. A position
 * that resolves outside it pointed into a chunk that has since been evicted;
 * clamping it to the span puts it where that chunk was. O(log n).
 */
export function keySpan(root: PieceNode | null, key: number): { start: number; end: number } {
  return { start: lengthWithKeyAtMost(root, key - 1), end: lengthWithKeyAtMost(root, key) };
}

// =============================================================================
// Loaded-chunk prefix sums
// =============================================================================

export interface LoadedPrefix {
  /** Loaded chunk indices, ascending. */
  readonly indices: readonly number[];
  /** prefix[i] = total original length of indices[0..i). */
  readonly prefix: readonly number[];
}

/**
 * Build the prefix table from (chunk index, length) pairs in any order.
 * Shared with the v1 checkpoint migration, which reads lengths from wire data.
 */
export function buildLoadedPrefix(chunks: Iterable<readonly [number, number]>): LoadedPrefix {
  const sorted = [...chunks].sort((a, b) => a[0] - b[0]);
  const indices = sorted.map(([index]) => index);
  const prefix = [0];
  for (const [, length] of sorted) prefix.push(prefix[prefix.length - 1]! + length);
  return { indices, prefix };
}

/** Total length of the chunks in `table` with index <= key. O(log L). */
export function prefixLengthAtOrBelow(table: LoadedPrefix, key: number): number {
  return table.prefix[loadedCountAtOrBelow(table, key)]!;
}

// chunkMap is replaced, never mutated, so each snapshot builds its table once.
const loadedPrefixCache = new WeakMap<ReadonlyMap<number, ReadonlyUint8Array>, LoadedPrefix>();

function loadedPrefixTable(chunkMap: ReadonlyMap<number, ReadonlyUint8Array>): LoadedPrefix {
  const cached = loadedPrefixCache.get(chunkMap);
  if (cached) return cached;
  const table = buildLoadedPrefix(
    Array.from(chunkMap, ([index, bytes]): [number, number] => [index, bytes.length]),
  );
  loadedPrefixCache.set(chunkMap, table);
  return table;
}

/** Number of loaded chunks with index <= key. */
function loadedCountAtOrBelow(table: LoadedPrefix, key: number): number {
  let lo = 0;
  let hi = table.indices.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (table.indices[mid]! <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Total original length of the loaded chunks with index <= key. O(log L). */
export function loadedLengthAtOrBelow(pieceTable: PieceTableState, key: number): number {
  if (key < 0 || pieceTable.chunkMap.size === 0) return 0;
  return prefixLengthAtOrBelow(loadedPrefixTable(pieceTable.chunkMap), key);
}

/** True when some chunk with index in (low, high] is not loaded. */
export function hasUnloadedChunkBetween(
  pieceTable: PieceTableState,
  low: number,
  high: number,
): boolean {
  if (high <= low) return false;
  const table = loadedPrefixTable(pieceTable.chunkMap);
  const loaded =
    loadedCountAtOrBelow(table, high) - loadedCountAtOrBelow(table, Math.max(low, NO_CHUNK));
  return loaded < high - Math.max(low, NO_CHUNK);
}

// =============================================================================
// Anchored positions
// =============================================================================

/** Convert a resident offset with placement key `key` to its anchored value. */
export function toAnchoredOffset(pieceTable: PieceTableState, key: number, offset: number): number {
  return offset - loadedLengthAtOrBelow(pieceTable, key);
}

/** Convert an anchored value with placement key `key` back to a resident offset. */
export function toResidentOffset(
  pieceTable: PieceTableState,
  key: number,
  anchored: number,
): number {
  return anchored + loadedLengthAtOrBelow(pieceTable, key);
}

/** One run of resident bytes that share a placement key. */
export interface KeyRun {
  readonly start: number;
  readonly end: number;
  readonly key: number;
}

/**
 * Split the resident range [start, end) where text on either side of a split
 * would land on different sides of a chunk that is not loaded.
 *
 * Re-inserting deleted text with a single key would move part of it across
 * such a chunk. Runs with different keys but no unloaded chunk between them
 * stay merged, because no load can separate them.
 */
export function placementRuns(pieceTable: PieceTableState, start: number, end: number): KeyRun[] {
  const runs: KeyRun[] = [];
  if (end <= start) return runs;
  // Before any chunk has loaded, every key is NO_CHUNK and nothing can split.
  if (pieceTable.nextExpectedChunk === 0) return [{ start, end, key: NO_CHUNK }];
  const firstKey = byteKey(pieceTable.root, start);
  // Keys never decrease, so every split needs an unloaded chunk between the
  // first and last keys. Without one the range is a single run: O(log n).
  if (!hasUnloadedChunkBetween(pieceTable, firstKey, byteKey(pieceTable.root, end - 1))) {
    return [{ start, end, key: firstKey }];
  }
  let runStart = start;
  let runKey = firstKey;
  let previousKey = firstKey;
  // In-order walk of the pieces that start inside (start, end). Subtrees that
  // end before `start` or begin at or after `end` are skipped.
  const visit = (node: PieceNode | null, base: number): void => {
    if (node === null) return;
    const nodeStart = base + (node.left?.subtreeLength ?? 0);
    const nodeEnd = nodeStart + node.length;
    if (start < nodeStart) visit(node.left, base);
    if (nodeStart > start && nodeStart < end) {
      const key = pieceKey(node);
      if (key !== previousKey && hasUnloadedChunkBetween(pieceTable, previousKey, key)) {
        runs.push({ start: runStart, end: nodeStart, key: runKey });
        runStart = nodeStart;
        runKey = key;
      }
      previousKey = key;
    }
    if (nodeEnd < end) visit(node.right, nodeEnd);
  };
  visit(pieceTable.root, 0);
  runs.push({ start: runStart, end, key: runKey });
  return runs;
}
