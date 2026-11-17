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
import { lastPiece, pieceAt } from "./piece-search.js";
import { avlHeight, avlPut, avlRemove } from "./persistent-avl.js";

/** Key for positions before every chunk, and for every position without chunking. */
export const NO_CHUNK = -1;

declare const fittedKeyBrand: unique symbol;

/**
 * A placement key derived from a document at an offset where it fits (see
 * `keyFitsAt`). Only the derivations in this module and `insertionKey` produce
 * one, so an insert given a `FittedKey` can skip checking it again. Use it on
 * the document it was derived from, before that document changes near the
 * offset.
 */
export type FittedKey = number & { readonly [fittedKeyBrand]: true };

/** Brand `key`, which the caller derived to fit where it will be used. */
export function asFittedKey(key: number): FittedKey {
  return key as FittedKey;
}

/**
 * The parts of a piece table that placement keys are read from: the piece
 * tree and which chunks have ever loaded. It holds no text, so keeping it
 * does not keep chunk bytes alive.
 */
export type KeyLayout = Pick<PieceTableState, "root" | "totalLength" | "nextExpectedChunk">;

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
  return pieceAt(root, offset)?.node ?? null;
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
  if (after === null) return keyAfterPiece(lastPiece(root)!.node);
  if (side === "after") return pieceKey(after);
  const before = pieceAtByte(root, offset - 1)!;
  if (before === after) return pieceKey(after);
  // `before` may be a chunk piece followed by a later piece of the same chunk.
  // The smaller key keeps keys in document order.
  return Math.min(keyAfterPiece(before), pieceKey(after));
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

/**
 * True when `key` is a placement key text inserted at resident `offset` could
 * take: every byte before the offset has a key at or below it, every byte after
 * has a key at or above it, and it names no chunk that has never loaded. O(log n).
 *
 * This is the one rule for whether a stored key still applies at an offset.
 * Inserted text, selection endpoints, and history anchors all check keys here.
 */
export function keyFitsAt(pieceTable: KeyLayout, offset: number, key: number): boolean {
  // Before any chunk loads, NO_CHUNK is the only key and fits everywhere.
  if (pieceTable.nextExpectedChunk === 0) {
    return key === NO_CHUNK && offset >= 0 && offset <= pieceTable.totalLength;
  }
  if (!Number.isSafeInteger(key) || key < NO_CHUNK || key >= pieceTable.nextExpectedChunk) {
    return false;
  }
  const { start, end } = keySpan(pieceTable.root, key);
  return start <= offset && offset <= end;
}

/**
 * The placement key of a position at resident `offset`: `stored` when it fits
 * there (see `keyFitsAt`), else the key of the gap on `side` (see `gapKey`).
 * Before any chunk loads, every key is NO_CHUNK. O(log n).
 */
export function placementKey(
  pieceTable: KeyLayout,
  offset: number,
  stored: number | undefined,
  side: GapSide,
): FittedKey {
  if (pieceTable.nextExpectedChunk === 0) return asFittedKey(NO_CHUNK);
  if (stored !== undefined && keyFitsAt(pieceTable, offset, stored)) return asFittedKey(stored);
  return asFittedKey(gapKey(pieceTable.root, offset, side));
}

// =============================================================================
// Loaded-chunk lengths
// =============================================================================

/**
 * Persistent AVL tree of the loaded chunks, keyed by chunk index, with the
 * total length of each subtree. A load or eviction copies one search
 * path, so streaming a file costs O(log L) per chunk instead of rebuilding a
 * table over every loaded chunk. Live documents keep one per chunk map, and
 * the v1 checkpoint migration builds one from wire data.
 */
export interface LoadedNode {
  /** Chunk index. */
  readonly key: number;
  /** Original length of the chunk. */
  readonly value: number;
  readonly left: LoadedNode | null;
  readonly right: LoadedNode | null;
  readonly height: number;
  readonly sum: number;
}

function loadedNode(
  index: number,
  length: number,
  left: LoadedNode | null,
  right: LoadedNode | null,
): LoadedNode {
  return {
    key: index,
    value: length,
    left,
    right,
    height: avlHeight(left, right),
    sum: length + (left?.sum ?? 0) + (right?.sum ?? 0),
  };
}

function putLoaded(node: LoadedNode | null, index: number, length: number): LoadedNode {
  return avlPut<number, number, LoadedNode>(loadedNode, node, index, length);
}

function removeLoaded(node: LoadedNode | null, index: number): LoadedNode | null {
  return avlRemove<number, number, LoadedNode>(loadedNode, node, index);
}

/**
 * Build the tree from (chunk index, length) pairs in any order. A repeated
 * index keeps its last length.
 */
export function buildLoadedChunks(
  chunks: Iterable<readonly [index: number, length: number]>,
): LoadedNode | null {
  let root: LoadedNode | null = null;
  for (const [index, length] of chunks) root = putLoaded(root, index, length);
  return root;
}

/** Total length of the loaded chunks with index <= key. O(log L). */
export function loadedSumAtOrBelow(root: LoadedNode | null, key: number): number {
  let sum = 0;
  let node = root;
  while (node !== null) {
    if (node.key <= key) {
      sum += node.value + (node.left?.sum ?? 0);
      node = node.right;
    } else {
      node = node.left;
    }
  }
  return sum;
}

type ChunkMap = PieceTableState["chunkMap"];

// chunkMap is replaced, never mutated, so a tree stays valid for its map.
const loadedTrees = new WeakMap<ChunkMap, LoadedNode | null>();

function loadedTree(chunkMap: ChunkMap): LoadedNode | null {
  const cached = loadedTrees.get(chunkMap);
  if (cached !== undefined) return cached;
  const root = buildLoadedChunks(
    Array.from(chunkMap, ([index, bytes]) => [index, bytes.length] as const),
  );
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
  return loadedSumAtOrBelow(loadedTree(pieceTable.chunkMap), key);
}

/**
 * The loaded-chunk lengths of `pieceTable`, for `loadedSumAtOrBelow`. The
 * tree holds only lengths, so keeping it does not keep chunk bytes alive.
 */
export function loadedChunkLengths(pieceTable: PieceTableState): LoadedNode | null {
  return pieceTable.chunkMap.size === 0 ? null : loadedTree(pieceTable.chunkMap);
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
export interface KeyRun<Key extends number = number> {
  readonly start: number;
  readonly end: number;
  readonly key: Key;
}

/**
 * Split the resident range [start, end) into runs of bytes that share a
 * placement key.
 *
 * Undo re-inserts each run with its own key, so every byte gets back the key
 * it had. Re-inserting runs with different keys under one key would give the
 * later bytes a smaller key, and an older change replayed among them would
 * then leave keys decreasing in document order. Usually there is one run.
 */
export function placementRuns(
  pieceTable: PieceTableState,
  start: number,
  end: number,
): KeyRun<FittedKey>[] {
  const runs: KeyRun<FittedKey>[] = [];
  if (end <= start) return runs;
  // Before any chunk has loaded, every key is NO_CHUNK and nothing can split.
  if (pieceTable.nextExpectedChunk === 0) return [{ start, end, key: asFittedKey(NO_CHUNK) }];
  // A run's key is the key of its own bytes, so it fits anywhere in the run.
  const firstKey = asFittedKey(byteKey(pieceTable.root, start));
  // Keys never decrease, so equal first and last keys mean one run: O(log n).
  if (firstKey === byteKey(pieceTable.root, end - 1)) return [{ start, end, key: firstKey }];
  let runStart = start;
  let runKey = firstKey;
  // In-order walk of the pieces that start inside (start, end). Subtrees that
  // end before `start` or begin at or after `end` are skipped.
  const visit = (node: PieceNode | null, base: number): void => {
    if (node === null) return;
    const nodeStart = base + (node.left?.subtreeLength ?? 0);
    const nodeEnd = nodeStart + node.length;
    if (start < nodeStart) visit(node.left, base);
    if (nodeStart > start && nodeStart < end) {
      const key = asFittedKey(pieceKey(node));
      if (key !== runKey) {
        runs.push({ start: runStart, end: nodeStart, key: runKey });
        runStart = nodeStart;
        runKey = key;
      }
    }
    if (nodeEnd < end) visit(node.right, nodeEnd);
  };
  visit(pieceTable.root, 0);
  runs.push({ start: runStart, end, key: runKey });
  return runs;
}
