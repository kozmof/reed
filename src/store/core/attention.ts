/**
 * Attention Layer — piece-attached boundary reference system for mutable text.
 *
 * Reed owns three independent layers:
 *   Piece Tree  → content
 *   Line Index  → navigation
 *   Attention   → references   ← this module
 *
 * An Attention is a (start: AttentionPoint, end: AttentionPoint) pair where
 * each point is pinned to a piece boundary rather than a document offset.
 * Because the piece's ID is stable across tree rotations and rebalancing,
 * the reference survives those structural changes without any update.
 *
 * When an insert causes a piece to split, call `migrateSplits` to heal any
 * AttentionPoints that fell on the right half of the split.
 */

import type { PieceNode, PieceTableState } from "../../types/state.js";
import type { ByteOffset, PieceID, AttentionID } from "../../types/branded.js";
import { byteOffset, attentionID } from "../../types/branded.js";
import type { SplitRecord } from "./piece-table.js";
import {
  pieceTableInsert,
  findPieceAtPosition,
  getText,
  inOrderPieces,
  pieceTableInOrder,
} from "./piece-table.js";

// =============================================================================
// Types
// =============================================================================

// `PieceID` and `AttentionID` are branded string identities defined in branded.ts.
// Re-exported here so the Attention Layer's public surface stays self-contained.
export type { PieceID, AttentionID } from "../../types/branded.js";

/**
 * A position anchored to a piece rather than to a document offset.
 * `boundary` is the byte count from the piece's start to this position,
 * i.e. the gap *before* byte `boundary` and *after* byte `boundary - 1`.
 * Valid range: 0 (before first byte) to piece.length (after last byte).
 */
export interface AttentionPoint {
  readonly pieceID: PieceID;
  readonly boundary: number;
}

/**
 * A reference into mutable text.
 * Covers all bytes whose piece-relative position falls in [start, end).
 *
 * Reed stores only the two boundary points.
 * Structure (groups, trees, ASTs) is the caller's responsibility.
 */
export interface Attention {
  readonly id: AttentionID;
  readonly start: AttentionPoint;
  readonly end: AttentionPoint;
}

/**
 * Immutable Attention Layer state.
 * Lives alongside the piece table and line index as the third Reed layer.
 */
export interface AttentionLayerState {
  readonly attentions: ReadonlyMap<AttentionID, Attention>;
}

// =============================================================================
// Helpers
// =============================================================================

let _nextAttentionID = 0;
function generateAttentionID(): AttentionID {
  return attentionID(`a${_nextAttentionID++}`);
}

/** Empty AttentionLayerState — use as the initial value. */
export const emptyAttentionLayerState: AttentionLayerState = Object.freeze({
  attentions: new Map<AttentionID, Attention>(),
});

// =============================================================================
// Point API
// =============================================================================

/**
 * Create an AttentionPoint anchored to the piece that contains `offset`.
 * Returns null for an empty tree or an out-of-range offset.
 *
 * The boundary within the piece equals `offset - pieceStartOffset`, so the
 * point tracks the *same character gap* even when later inserts shift the
 * piece's absolute position.
 *
 * O(log n).
 */
export function createPoint(root: PieceNode | null, offset: ByteOffset): AttentionPoint | null {
  if (root === null) return null;

  // Clamp to the end of the document (boundary after last byte).
  const totalLength = root.subtreeLength;
  const clampedOffset = Math.min(offset, totalLength);

  if (clampedOffset < 0) return null;

  // At document end: find the last piece and attach to its right boundary.
  if (clampedOffset === totalLength) {
    // Walk to the rightmost piece.
    let node: PieceNode = root;
    let nodeStart = 0;
    while (true) {
      const leftLen = node.left?.subtreeLength ?? 0;
      const pieceStart = nodeStart + leftLen;
      if (node.right !== null) {
        nodeStart = pieceStart + node.length;
        node = node.right;
      } else {
        return { pieceID: node.id, boundary: node.length };
      }
    }
  }

  const location = findPieceAtPosition(root, byteOffset(clampedOffset));
  if (location === null) return null;

  return {
    pieceID: location.node.id,
    boundary: location.offsetInPiece,
  };
}

/**
 * Resolve an AttentionPoint to its current document byte offset.
 * Returns null when the piece ID is not found (dangling reference).
 *
 * O(n) — walks the piece tree in document order to find the piece.
 */
export function resolvePoint(root: PieceNode | null, point: AttentionPoint): ByteOffset | null {
  if (root === null) return null;

  let result: ByteOffset | null = null;

  pieceTableInOrder(root, (node, pieceDocOffset) => {
    if (node.id === point.pieceID) {
      result = byteOffset(pieceDocOffset + point.boundary);
      return true; // stop iteration
    }
  });

  return result;
}

// =============================================================================
// Attention API
// =============================================================================

/**
 * Create a new Attention spanning [start, end) and add it to the layer.
 * Returns [newState, id].
 *
 * O(1).
 */
export function createAttention(
  state: AttentionLayerState,
  start: AttentionPoint,
  end: AttentionPoint,
): [AttentionLayerState, AttentionID] {
  const id = generateAttentionID();
  const attention: Attention = Object.freeze({ id, start, end });
  const next = new Map(state.attentions);
  next.set(id, attention);
  return [Object.freeze({ attentions: next }), id];
}

/**
 * Remove an Attention from the layer. No-op if the ID is unknown.
 *
 * O(1).
 */
export function deleteAttention(state: AttentionLayerState, id: AttentionID): AttentionLayerState {
  if (!state.attentions.has(id)) return state;
  const next = new Map(state.attentions);
  next.delete(id);
  return Object.freeze({ attentions: next });
}

/**
 * Look up an Attention by ID.
 *
 * O(1).
 */
export function getAttention(state: AttentionLayerState, id: AttentionID): Attention | null {
  return state.attentions.get(id) ?? null;
}

// =============================================================================
// Resolution API
// =============================================================================

/** Maps each live piece ID to its current document start offset. */
type PieceOffsetIndex = ReadonlyMap<PieceID, number>;

/**
 * Build a piece-ID → document-start-offset index in a single in-order pass.
 *
 * Amortizes resolution: once built, each point resolves in O(1) instead of
 * walking the tree. Callers that resolve many points against the same tree
 * (e.g. `findAttentionsAt`) should build this once and reuse it.
 *
 * O(n).
 */
function buildPieceOffsetIndex(root: PieceNode | null): PieceOffsetIndex {
  const index = new Map<PieceID, number>();
  if (root === null) return index;
  for (const { piece, docOffset } of inOrderPieces(root)) {
    index.set(piece.id, docOffset);
  }
  return index;
}

/**
 * Resolve a single point against a prebuilt index.
 * Returns null when the piece ID is not present (dangling reference).
 */
function resolvePointWithIndex(index: PieceOffsetIndex, point: AttentionPoint): ByteOffset | null {
  const pieceStart = index.get(point.pieceID);
  if (pieceStart === undefined) return null;
  return byteOffset(pieceStart + point.boundary);
}

/**
 * Resolve an Attention against a prebuilt index.
 * Returns null when the Attention ID is unknown or a point is dangling.
 */
function resolveAttentionWithIndex(
  index: PieceOffsetIndex,
  state: AttentionLayerState,
  id: AttentionID,
): { startOffset: ByteOffset; endOffset: ByteOffset } | null {
  const attention = state.attentions.get(id);
  if (attention === undefined) return null;

  const startOffset = resolvePointWithIndex(index, attention.start);
  if (startOffset === null) return null;

  const endOffset = resolvePointWithIndex(index, attention.end);
  if (endOffset === null) return null;

  return { startOffset, endOffset };
}

/**
 * Resolve an Attention to its current document byte offsets.
 * Returns null when the Attention ID is unknown or a point is dangling.
 *
 * O(n) — a single tree walk resolves both points.
 */
export function resolveAttention(
  root: PieceNode | null,
  state: AttentionLayerState,
  id: AttentionID,
): { startOffset: ByteOffset; endOffset: ByteOffset } | null {
  if (state.attentions.get(id) === undefined) return null;
  return resolveAttentionWithIndex(buildPieceOffsetIndex(root), state, id);
}

// =============================================================================
// Text API
// =============================================================================

/**
 * Extract the text covered by an Attention.
 * Returns null when the Attention ID is unknown or a point is dangling.
 *
 * O(n).
 */
export function getTextForAttention(
  pieceTableState: PieceTableState,
  attentionState: AttentionLayerState,
  id: AttentionID,
): string | null {
  const offsets = resolveAttention(pieceTableState.root, attentionState, id);
  if (offsets === null) return null;
  if (offsets.startOffset >= offsets.endOffset) return "";
  return getText(pieceTableState, offsets.startOffset, offsets.endOffset);
}

// =============================================================================
// Query API
// =============================================================================

/**
 * Return IDs of all Attentions whose resolved range contains `offset`.
 *
 * O(n + A) where A is the number of attentions: one tree walk to index the
 * pieces, then an O(1) resolution per attention.
 */
export function findAttentionsAt(
  state: AttentionLayerState,
  root: PieceNode | null,
  offset: number,
): AttentionID[] {
  const index = buildPieceOffsetIndex(root);
  const results: AttentionID[] = [];
  for (const [id] of state.attentions) {
    const offsets = resolveAttentionWithIndex(index, state, id);
    if (offsets === null) continue;
    if (offset >= offsets.startOffset && offset < offsets.endOffset) {
      results.push(id);
    }
  }
  return results;
}

/**
 * Return IDs of all Attentions that overlap the range [start, end).
 * Two ranges overlap when one starts before the other ends.
 *
 * O(n + A) where A is the number of attentions: one tree walk to index the
 * pieces, then an O(1) resolution per attention.
 */
export function findAttentionsOverlapping(
  state: AttentionLayerState,
  root: PieceNode | null,
  start: number,
  end: number,
): AttentionID[] {
  const index = buildPieceOffsetIndex(root);
  const results: AttentionID[] = [];
  for (const [id] of state.attentions) {
    const offsets = resolveAttentionWithIndex(index, state, id);
    if (offsets === null) continue;
    // Overlap: not (attention ends before range OR attention starts after range)
    if (offsets.endOffset > start && offsets.startOffset < end) {
      results.push(id);
    }
  }
  return results;
}

// =============================================================================
// Edit Support
// =============================================================================

/**
 * Migrate AttentionPoints after one or more piece splits.
 *
 * When `pieceTableInsert` splits a piece, the left half keeps the original ID
 * and the right half gets a new ID. Any AttentionPoint that referenced the
 * original piece with `boundary > splitOffset` must be updated to reference
 * the right half with an adjusted boundary.
 *
 * Call this after every `pieceTableInsert` that returns a non-empty `splits`.
 *
 * O(A · S) where A is the number of AttentionPoints (2× attentions) and
 * S is the number of splits (almost always 0 or 1).
 */
export function migrateSplits(
  state: AttentionLayerState,
  splits: readonly SplitRecord[],
): AttentionLayerState {
  if (splits.length === 0) return state;

  // Build a fast lookup: originalID → SplitRecord
  const splitMap = new Map<PieceID, SplitRecord>();
  for (const s of splits) {
    splitMap.set(s.originalID, s);
  }

  let changed = false;
  const next = new Map(state.attentions);

  for (const [id, attention] of next) {
    const migratedStart = migratePoint(attention.start, splitMap);
    const migratedEnd = migratePoint(attention.end, splitMap);

    if (migratedStart !== attention.start || migratedEnd !== attention.end) {
      next.set(id, Object.freeze({ ...attention, start: migratedStart, end: migratedEnd }));
      changed = true;
    }
  }

  return changed ? Object.freeze({ attentions: next }) : state;
}

function migratePoint(
  point: AttentionPoint,
  splitMap: ReadonlyMap<PieceID, SplitRecord>,
): AttentionPoint {
  const split = splitMap.get(point.pieceID);
  if (split === undefined) return point;

  if (point.boundary <= split.splitOffset) {
    // Falls in the left half — pieceID is already correct (the left half keeps originalID).
    return point;
  }

  // Falls in the right half — rewrite to the new right piece with adjusted boundary.
  return Object.freeze({
    pieceID: split.rightID,
    boundary: point.boundary - split.splitOffset,
  });
}

/** Result of an attention-aware insert: both layers advanced together. */
export interface InsertWithAttentionResult {
  readonly pieceTableState: PieceTableState;
  readonly attentionState: AttentionLayerState;
  readonly insertedByteLength: number;
}

/**
 * Insert `text` at `position` and migrate the Attention Layer in one step.
 *
 * `pieceTableInsert` followed by `migrateSplits` is a two-step protocol: a
 * forgotten `migrateSplits` silently corrupts any AttentionPoint that fell on
 * the right half of a split. This helper couples the two so callers cannot
 * desync the layers. The Attention Layer stays caller-owned — pass the current
 * `attentionState` in and store the returned one.
 *
 * O(n) — dominated by the piece-table insert and the per-attention migration.
 */
export function insertWithAttention(
  pieceTableState: PieceTableState,
  attentionState: AttentionLayerState,
  position: ByteOffset,
  text: string,
): InsertWithAttentionResult {
  const result = pieceTableInsert(pieceTableState, position, text);
  return {
    pieceTableState: result.state,
    attentionState: migrateSplits(attentionState, result.splits),
    insertedByteLength: result.insertedByteLength,
  };
}
