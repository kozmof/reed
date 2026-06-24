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
 *
 * Deletes are different: the split–join delete strategy hands surviving
 * fragments fresh piece IDs that no `SplitRecord` describes, so points on a
 * cut piece cannot be healed by ID rewriting. Use `deleteWithAttention`, which
 * resolves each point against the pre-delete tree and re-anchors it against the
 * new one (trailing points shift left, points inside the deleted span collapse
 * to its start). Resolution is fail-closed everywhere: a point whose piece was
 * cut away (or whose boundary now exceeds its piece) resolves to `null` rather
 * than to a corrupt offset.
 */

import type { PieceNode, PieceTableState } from "../../types/state.js";
import type { ByteOffset, PieceID, AttentionID } from "../../types/branded.js";
import { byteOffset, attentionID } from "../../types/branded.js";
import type { SplitRecord } from "./piece-table.js";
import {
  pieceTableInsert,
  pieceTableDelete,
  findPieceAtPosition,
  findLastPiece,
  getText,
  inOrderPieces,
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
  /**
   * Monotonic counter for minting fresh AttentionIDs, scoped to this layer's
   * history rather than the process. Keeps IDs deterministic across runs and
   * stable for serialization. Carried forward by every state-returning op.
   */
  readonly nextID: number;
}

/** A resolved Attention's current document span, half-open `[startOffset, endOffset)`. */
export interface ResolvedRange {
  readonly startOffset: ByteOffset;
  readonly endOffset: ByteOffset;
}

// =============================================================================
// Helpers
// =============================================================================

/** Empty AttentionLayerState — use as the initial value. */
export const emptyAttentionLayerState: AttentionLayerState = Object.freeze({
  attentions: new Map<AttentionID, Attention>(),
  nextID: 0,
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

  // At document end: attach to the rightmost piece's right boundary.
  if (clampedOffset === totalLength) {
    const last = findLastPiece(root);
    if (last === null) return null;
    return { pieceID: last.node.id, boundary: last.offsetInPiece };
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
 * Returns null for a dangling reference: the piece ID is no longer in the tree,
 * or the boundary now exceeds the piece's length (e.g. the piece was cut by a
 * delete). Failing closed avoids returning a silently-wrong offset.
 *
 * O(n) — builds the piece-offset index in one in-order pass. Callers resolving
 * many points against the same tree should build the index once (via
 * `resolveAttention`) instead of calling this per point.
 */
export function resolvePoint(root: PieceNode | null, point: AttentionPoint): ByteOffset | null {
  if (root === null) return null;
  return resolvePointWithIndex(buildPieceOffsetIndex(root), point);
}

// =============================================================================
// Attention API
// =============================================================================

/**
 * Create a new Attention spanning [start, end) and add it to the layer.
 * Returns [newState, id].
 *
 * `start` and `end` are stored as given; the caller owns the `start <= end`
 * invariant. An inverted or zero-width span simply resolves to an empty range
 * (`getTextForAttention` returns "").
 *
 * O(1).
 */
export function createAttention(
  state: AttentionLayerState,
  start: AttentionPoint,
  end: AttentionPoint,
): [AttentionLayerState, AttentionID] {
  const id = attentionID(`a${state.nextID}`);
  const attention: Attention = Object.freeze({ id, start, end });
  const next = new Map(state.attentions);
  next.set(id, attention);
  return [Object.freeze({ attentions: next, nextID: state.nextID + 1 }), id];
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
  return Object.freeze({ attentions: next, nextID: state.nextID });
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

/** A live piece's current document start offset and its byte length. */
interface PieceOffsetEntry {
  readonly offset: number;
  readonly length: number;
}

/** Maps each live piece ID to its current document position and length. */
type PieceOffsetIndex = ReadonlyMap<PieceID, PieceOffsetEntry>;

/**
 * Build a piece-ID → {offset, length} index in a single in-order pass.
 *
 * Amortizes resolution: once built, each point resolves in O(1) instead of
 * walking the tree. Callers that resolve many points against the same tree
 * (e.g. `findAttentionsAt`) should build this once and reuse it.
 *
 * O(n).
 */
function buildPieceOffsetIndex(root: PieceNode | null): PieceOffsetIndex {
  const index = new Map<PieceID, PieceOffsetEntry>();
  if (root === null) return index;
  for (const { piece, docOffset } of inOrderPieces(root)) {
    index.set(piece.id, { offset: docOffset, length: piece.length });
  }
  return index;
}

/**
 * Resolve a single point against a prebuilt index.
 * Returns null for a dangling reference: the piece ID is absent, or the boundary
 * exceeds the piece's length (failing closed instead of returning a corrupt
 * offset).
 */
function resolvePointWithIndex(index: PieceOffsetIndex, point: AttentionPoint): ByteOffset | null {
  const entry = index.get(point.pieceID);
  if (entry === undefined) return null;
  if (point.boundary > entry.length) return null;
  return byteOffset(entry.offset + point.boundary);
}

/**
 * Resolve an Attention against a prebuilt index.
 * Returns null when the Attention ID is unknown or a point is dangling.
 */
function resolveAttentionWithIndex(
  index: PieceOffsetIndex,
  state: AttentionLayerState,
  id: AttentionID,
): ResolvedRange | null {
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
): ResolvedRange | null {
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

  // originalID → SplitRecord lookup. The common case is a single split (one
  // insert splits at most one piece), so skip the Map allocation there.
  let lookup: (pieceID: PieceID) => SplitRecord | undefined;
  if (splits.length === 1) {
    const only = splits[0];
    lookup = (pieceID) => (pieceID === only.originalID ? only : undefined);
  } else {
    const splitMap = new Map<PieceID, SplitRecord>();
    for (const s of splits) {
      splitMap.set(s.originalID, s);
    }
    lookup = (pieceID) => splitMap.get(pieceID);
  }

  let changed = false;
  const next = new Map(state.attentions);

  for (const [id, attention] of next) {
    const migratedStart = migratePoint(attention.start, lookup);
    const migratedEnd = migratePoint(attention.end, lookup);

    if (migratedStart !== attention.start || migratedEnd !== attention.end) {
      next.set(id, Object.freeze({ ...attention, start: migratedStart, end: migratedEnd }));
      changed = true;
    }
  }

  return changed ? Object.freeze({ attentions: next, nextID: state.nextID }) : state;
}

function migratePoint(
  point: AttentionPoint,
  lookup: (pieceID: PieceID) => SplitRecord | undefined,
): AttentionPoint {
  const split = lookup(point.pieceID);
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

/** Result of an attention-aware delete: both layers advanced together. */
export interface DeleteWithAttentionResult {
  readonly pieceTableState: PieceTableState;
  readonly attentionState: AttentionLayerState;
  readonly deletedByteLength: number;
}

/**
 * Re-anchor one AttentionPoint across a delete of the clamped span [start, end).
 *
 * Points at or before `start` are unaffected (their piece keeps its ID).
 * Points after `end` shift left by the deleted length. Points strictly inside
 * the span collapse to `start`. Already-dangling points (and boundary overflows)
 * are left untouched — they stay dangling rather than re-anchoring to garbage.
 */
function migratePointForDelete(
  point: AttentionPoint,
  oldIndex: PieceOffsetIndex,
  newRoot: PieceNode | null,
  start: number,
  end: number,
  deletedLength: number,
): AttentionPoint {
  const entry = oldIndex.get(point.pieceID);
  if (entry === undefined || point.boundary > entry.length) return point; // dangling: leave as-is

  const offset = entry.offset + point.boundary;
  if (offset <= start) return point; // before the cut — piece + boundary still valid

  const newOffset = offset >= end ? offset - deletedLength : start;
  // Re-anchor against the post-delete tree. A null result (empty document) leaves
  // the old point, which then resolves to null — still fail-closed.
  return createPoint(newRoot, byteOffset(newOffset)) ?? point;
}

/**
 * Delete [start, end) and migrate the Attention Layer in one step.
 *
 * The split–join delete gives surviving fragments fresh piece IDs that no
 * `SplitRecord` captures, so ID rewriting (as `migrateSplits` does for inserts)
 * cannot heal points on a cut piece. Instead this resolves each point against
 * the pre-delete tree and re-anchors it against the new one. The Attention Layer
 * stays caller-owned — pass the current `attentionState` in and store the
 * returned one.
 *
 * O(n + A·log n) — the delete and pre-delete indexing are O(n); each affected
 * point re-anchors in O(log n).
 */
export function deleteWithAttention(
  pieceTableState: PieceTableState,
  attentionState: AttentionLayerState,
  start: ByteOffset,
  end: ByteOffset,
): DeleteWithAttentionResult {
  const total = pieceTableState.totalLength;
  const clampedStart = Math.max(0, Math.min(start, total));
  const clampedEnd = Math.max(0, Math.min(end, total));

  const oldIndex = buildPieceOffsetIndex(pieceTableState.root);
  const newPieceTableState = pieceTableDelete(pieceTableState, start, end);

  if (clampedStart >= clampedEnd) {
    return { pieceTableState: newPieceTableState, attentionState, deletedByteLength: 0 };
  }

  const deletedLength = clampedEnd - clampedStart;
  const newRoot = newPieceTableState.root;

  let changed = false;
  const next = new Map(attentionState.attentions);
  for (const [id, attention] of next) {
    const migratedStart = migratePointForDelete(
      attention.start,
      oldIndex,
      newRoot,
      clampedStart,
      clampedEnd,
      deletedLength,
    );
    const migratedEnd = migratePointForDelete(
      attention.end,
      oldIndex,
      newRoot,
      clampedStart,
      clampedEnd,
      deletedLength,
    );
    if (migratedStart !== attention.start || migratedEnd !== attention.end) {
      next.set(id, Object.freeze({ ...attention, start: migratedStart, end: migratedEnd }));
      changed = true;
    }
  }

  return {
    pieceTableState: newPieceTableState,
    attentionState: changed
      ? Object.freeze({ attentions: next, nextID: attentionState.nextID })
      : attentionState,
    deletedByteLength: deletedLength,
  };
}
