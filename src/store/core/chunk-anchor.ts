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
 * Key just after the last byte of `piece`, when nothing follows it. After a
 * chunk piece, that whole chunk lies before the position.
 */
function keyAfterPiece(piece: PieceNode): number {
  return piece.bufferType === "chunk" ? piece.chunkIndex : pieceKey(piece);
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
  return piece === null ? gapKey(root, offset, "before") : pieceKey(piece);
}

/**
 * Which resident content a gap position stays with when a chunk that is not
 * loaded, sitting between the bytes on either side, loads:
 *
 * - `"before"`: the content before the gap. The chunk loads after the position.
 * - `"after"`: the content after the gap. The chunk loads before the position.
 */
export type GapSide = "before" | "after";

/**
 * Placement key for the gap at resident `offset`.
 *
 * Inside a piece both sides agree. Between pieces, `side` picks the content
 * the position stays with (see `GapSide`). With no content on that side (the
 * start or end of the document), the position stays with the other side.
 *
 * Inserted text and cursors use `"before"`, so text typed after a chunk stays
 * next to it when an unloaded chunk that follows loads. A selection's start
 * uses `"after"` and its end `"before"`, so a loaded chunk never lands inside
 * a selection that did not cover it.
 */
export function gapKey(root: PieceNode | null, offset: number, side: GapSide): number {
  if (root === null) return NO_CHUNK;
  const after = offset < root.subtreeLength ? pieceAtByte(root, offset) : null;
  if (offset <= 0) return after === null ? NO_CHUNK : pieceKey(after);
  if (after === null) return keyAfterPiece(lastPiece(root)!);
  if (side === "after") return pieceKey(after);
  const before = pieceAtByte(root, offset - 1)!;
  if (before === after) return pieceKey(after);
  // `before` may be a chunk piece followed by a later piece of the same chunk.
  // The smaller key keeps keys in document order.
  return Math.min(keyAfterPiece(before), pieceKey(after));
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
export function flatGapKey(
  pieces: readonly FlatPiece[],
): (offset: number, side: GapSide) => number {
  const starts: number[] = [];
  const keys: number[] = [];
  // As in `keyAfterPiece`: after a chunk piece, that whole chunk lies before.
  const keysAfter: number[] = [];
  let total = 0;
  for (const piece of pieces) {
    if (piece.length <= 0) continue;
    starts.push(total);
    keys.push(piece.key);
    keysAfter.push(piece.chunkIndex ?? piece.key);
    total += piece.length;
  }
  // Index of the piece holding byte `offset`: the last piece starting at or
  // before it.
  const pieceAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return (offset, side) => {
    if (starts.length === 0) return NO_CHUNK;
    if (offset <= 0) return keys[0]!;
    if (offset >= total) return keysAfter[keysAfter.length - 1]!;
    const after = pieceAt(offset);
    if (side === "after") return keys[after]!;
    const before = pieceAt(offset - 1);
    if (before === after) return keys[after]!;
    return Math.min(keysAfter[before]!, keys[after]!);
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
// Loaded-chunk prefix sums for wire data
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

/** Number of entries in `table` with index <= key. */
function prefixCountAtOrBelow(table: LoadedPrefix, key: number): number {
  let lo = 0;
  let hi = table.indices.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (table.indices[mid]! <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Total length of the chunks in `table` with index <= key. O(log L). */
export function prefixLengthAtOrBelow(table: LoadedPrefix, key: number): number {
  return table.prefix[prefixCountAtOrBelow(table, key)]!;
}

// =============================================================================
// Loaded-chunk lengths for live documents
// =============================================================================

/**
 * Persistent AVL tree of the loaded chunks, keyed by chunk index, with the
 * count and total length of each subtree. A load or eviction copies one search
 * path, so streaming a file costs O(log L) per chunk instead of rebuilding a
 * table over every loaded chunk.
 */
interface LoadedNode {
  readonly index: number;
  readonly length: number;
  readonly left: LoadedNode | null;
  readonly right: LoadedNode | null;
  readonly height: number;
  readonly count: number;
  readonly sum: number;
}

function loadedNode(
  index: number,
  length: number,
  left: LoadedNode | null,
  right: LoadedNode | null,
): LoadedNode {
  return {
    index,
    length,
    left,
    right,
    height: 1 + Math.max(left?.height ?? 0, right?.height ?? 0),
    count: 1 + (left?.count ?? 0) + (right?.count ?? 0),
    sum: length + (left?.sum ?? 0) + (right?.sum ?? 0),
  };
}

function balanceLoaded(
  index: number,
  length: number,
  left: LoadedNode | null,
  right: LoadedNode | null,
): LoadedNode {
  const lh = left?.height ?? 0;
  const rh = right?.height ?? 0;
  if (lh > rh + 1) {
    const l = left!;
    if ((l.left?.height ?? 0) >= (l.right?.height ?? 0)) {
      return loadedNode(l.index, l.length, l.left, loadedNode(index, length, l.right, right));
    }
    const m = l.right!;
    return loadedNode(
      m.index,
      m.length,
      loadedNode(l.index, l.length, l.left, m.left),
      loadedNode(index, length, m.right, right),
    );
  }
  if (rh > lh + 1) {
    const r = right!;
    if ((r.right?.height ?? 0) >= (r.left?.height ?? 0)) {
      return loadedNode(r.index, r.length, loadedNode(index, length, left, r.left), r.right);
    }
    const m = r.left!;
    return loadedNode(
      m.index,
      m.length,
      loadedNode(index, length, left, m.left),
      loadedNode(r.index, r.length, m.right, r.right),
    );
  }
  return loadedNode(index, length, left, right);
}

function putLoaded(node: LoadedNode | null, index: number, length: number): LoadedNode {
  if (node === null) return loadedNode(index, length, null, null);
  if (index === node.index) return loadedNode(index, length, node.left, node.right);
  return index < node.index
    ? balanceLoaded(node.index, node.length, putLoaded(node.left, index, length), node.right)
    : balanceLoaded(node.index, node.length, node.left, putLoaded(node.right, index, length));
}

function removeLoaded(node: LoadedNode | null, index: number): LoadedNode | null {
  if (node === null) return null;
  if (index < node.index) {
    return balanceLoaded(node.index, node.length, removeLoaded(node.left, index), node.right);
  }
  if (index > node.index) {
    return balanceLoaded(node.index, node.length, node.left, removeLoaded(node.right, index));
  }
  if (node.left === null) return node.right;
  if (node.right === null) return node.left;
  let successor = node.right;
  while (successor.left !== null) successor = successor.left;
  return balanceLoaded(
    successor.index,
    successor.length,
    node.left,
    removeLoaded(node.right, successor.index),
  );
}

/** Count and total length of the loaded chunks with index <= key. O(log L). */
function loadedAtOrBelow(root: LoadedNode | null, key: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  let node = root;
  while (node !== null) {
    if (node.index <= key) {
      count += 1 + (node.left?.count ?? 0);
      sum += node.length + (node.left?.sum ?? 0);
      node = node.right;
    } else {
      node = node.left;
    }
  }
  return { count, sum };
}

type ChunkMap = PieceTableState["chunkMap"];

// chunkMap is replaced, never mutated, so a tree stays valid for its map.
const loadedTrees = new WeakMap<ChunkMap, LoadedNode | null>();

function loadedTree(chunkMap: ChunkMap): LoadedNode | null {
  const cached = loadedTrees.get(chunkMap);
  if (cached !== undefined) return cached;
  let root: LoadedNode | null = null;
  for (const [index, bytes] of chunkMap) root = putLoaded(root, index, bytes.length);
  loadedTrees.set(chunkMap, root);
  return root;
}

/**
 * Record that `next` is `previous` with chunks `loaded` added and chunks
 * `evicted` removed, so `next` derives its tree from the one for `previous` in
 * O(log L) per chunk. Chunk loading and eviction call this. A map without a
 * recorded tree builds one from scratch on first use.
 */
export function deriveLoadedChunks(
  previous: ChunkMap,
  next: ChunkMap,
  loaded: Iterable<readonly [index: number, length: number]>,
  evicted: Iterable<number>,
): void {
  if (loadedTrees.has(next)) return;
  let root = loadedTree(previous);
  for (const index of evicted) root = removeLoaded(root, index);
  for (const [index, length] of loaded) root = putLoaded(root, index, length);
  loadedTrees.set(next, root);
}

/** Total original length of the loaded chunks with index <= key. O(log L). */
export function loadedLengthAtOrBelow(pieceTable: PieceTableState, key: number): number {
  if (key < 0 || pieceTable.chunkMap.size === 0) return 0;
  return loadedAtOrBelow(loadedTree(pieceTable.chunkMap), key).sum;
}

/** True when some chunk with index in (low, high] is not loaded. */
export function hasUnloadedChunkBetween(
  pieceTable: PieceTableState,
  low: number,
  high: number,
): boolean {
  const from = Math.max(low, NO_CHUNK);
  if (high <= from) return false;
  const root = loadedTree(pieceTable.chunkMap);
  const loaded = loadedAtOrBelow(root, high).count - loadedAtOrBelow(root, from).count;
  return loaded < high - from;
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
