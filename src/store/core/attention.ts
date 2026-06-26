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
import type {
  AttentionPoint,
  Attention,
  AttentionLayerState,
  ResolvedRange,
} from "../../types/attention.js";
import type { SplitRecord } from "./piece-table.js";
import {
  pieceTableInsert,
  pieceTableDelete,
  findPieceAtPosition,
  findLastPiece,
  getText,
  inOrderPieces,
} from "./piece-table.js";
import {
  $proveCtx,
  $lift,
  type ConstCost,
  type LogCost,
  type LinearCost,
  type NLogNCost,
} from "../../types/cost-doc.js";
import { asReadonlyMap } from "./runtime-readonly.js";

// =============================================================================
// Types
// =============================================================================

// The Attention Layer's data types live in `types/attention.ts` (dependency-light,
// so `DocumentState` can carry an `AttentionLayerState` without an import cycle).
// They are re-exported here so this module's public surface stays self-contained.
export type { PieceID, AttentionID } from "../../types/branded.js";
export type {
  AttentionPoint,
  Attention,
  AttentionLayerState,
  ResolvedRange,
} from "../../types/attention.js";

// =============================================================================
// Helpers
// =============================================================================

/** Empty AttentionLayerState — use as the initial value. */
export const emptyAttentionLayerState: AttentionLayerState = Object.freeze({
  attentions: asReadonlyMap(new Map<AttentionID, Attention>()),
  nextID: 0,
});

function freezeAttentionPoint(point: AttentionPoint): AttentionPoint {
  return Object.freeze({ pieceID: point.pieceID, boundary: point.boundary });
}

function freezeAttentionState(
  attentions: Map<AttentionID, Attention>,
  nextID: number,
): AttentionLayerState {
  return Object.freeze({ attentions: asReadonlyMap(attentions), nextID });
}

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
export function createPoint(
  root: PieceNode | null,
  offset: ByteOffset,
): LogCost<AttentionPoint> | null {
  if (root === null) return null;

  // Clamp to the end of the document (boundary after last byte).
  const totalLength = root.subtreeLength;
  const clampedOffset = Math.min(offset, totalLength);

  if (clampedOffset < 0) return null;

  // At document end: attach to the rightmost piece's right boundary.
  if (clampedOffset === totalLength) {
    const last = findLastPiece(root);
    if (last === null) return null;
    return $proveCtx(
      "O(log n)",
      $lift(
        "O(log n)",
        freezeAttentionPoint({ pieceID: last.node.id, boundary: last.offsetInPiece }),
      ),
    );
  }

  const location = findPieceAtPosition(root, byteOffset(clampedOffset));
  if (location === null) return null;

  return $proveCtx(
    "O(log n)",
    $lift(
      "O(log n)",
      freezeAttentionPoint({ pieceID: location.node.id, boundary: location.offsetInPiece }),
    ),
  );
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
export function resolvePoint(
  root: PieceNode | null,
  point: AttentionPoint,
): LinearCost<ByteOffset> | null {
  if (root === null) return null;
  const offset = resolvePointWithIndex(buildPieceOffsetIndex(root), point);
  if (offset === null) return null;
  return $proveCtx("O(n)", $lift("O(n)", offset));
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
): ConstCost<[AttentionLayerState, AttentionID]> {
  const id = attentionID(`a${state.nextID}`);
  const attention: Attention = Object.freeze({
    id,
    start: freezeAttentionPoint(start),
    end: freezeAttentionPoint(end),
  });
  const next = new Map(state.attentions);
  next.set(id, attention);
  const result: [AttentionLayerState, AttentionID] = [
    freezeAttentionState(next, state.nextID + 1),
    id,
  ];
  return $proveCtx("O(1)", $lift("O(1)", result));
}

/**
 * Remove an Attention from the layer. No-op if the ID is unknown.
 *
 * O(1).
 */
export function deleteAttention(
  state: AttentionLayerState,
  id: AttentionID,
): ConstCost<AttentionLayerState> {
  if (!state.attentions.has(id)) return $proveCtx("O(1)", $lift("O(1)", state));
  const next = new Map(state.attentions);
  next.delete(id);
  return $proveCtx("O(1)", $lift("O(1)", freezeAttentionState(next, state.nextID)));
}

/**
 * Look up an Attention by ID.
 *
 * O(1).
 */
export function getAttention(
  state: AttentionLayerState,
  id: AttentionID,
): ConstCost<Attention> | null {
  const attention = state.attentions.get(id);
  if (attention === undefined) return null;
  return $proveCtx("O(1)", $lift("O(1)", attention));
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
  // Fail closed on a corrupt boundary in either direction: a negative boundary
  // would produce an offset before the piece, an over-length one past it.
  if (point.boundary < 0 || point.boundary > entry.length) return null;
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
): LinearCost<ResolvedRange> | null {
  if (state.attentions.get(id) === undefined) return null;
  const range = resolveAttentionWithIndex(buildPieceOffsetIndex(root), state, id);
  if (range === null) return null;
  return $proveCtx("O(n)", $lift("O(n)", range));
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
): LinearCost<string> | null {
  const offsets = resolveAttention(pieceTableState.root, attentionState, id);
  if (offsets === null) return null;
  if (offsets.startOffset >= offsets.endOffset) return $proveCtx("O(n)", $lift("O(n)", ""));
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
): LinearCost<AttentionID[]> {
  const index = buildPieceOffsetIndex(root);
  const results: AttentionID[] = [];
  for (const [id] of state.attentions) {
    const offsets = resolveAttentionWithIndex(index, state, id);
    if (offsets === null) continue;
    if (offset >= offsets.startOffset && offset < offsets.endOffset) {
      results.push(id);
    }
  }
  return $proveCtx("O(n)", $lift("O(n)", results));
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
): LinearCost<AttentionID[]> {
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
  return $proveCtx("O(n)", $lift("O(n)", results));
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
): LinearCost<AttentionLayerState> {
  if (splits.length === 0) return $proveCtx("O(n)", $lift("O(n)", state));

  // originalID → SplitRecord lookup. The common case is a single split (one
  // insert splits at most one piece), so skip the Map allocation there.
  let lookup: (pieceID: PieceID) => SplitRecord | undefined;
  if (splits.length === 1) {
    const only = splits[0]!;
    lookup = (pieceID) => (pieceID === only.originalID ? only : undefined);
  } else {
    const splitMap = new Map<PieceID, SplitRecord>();
    for (const s of splits) {
      splitMap.set(s.originalID, s);
    }
    lookup = (pieceID) => splitMap.get(pieceID);
  }

  // Copy-on-write: only clone the map once a point actually migrates. The common
  // case (no attention references a split piece) returns the input untouched.
  let next: Map<AttentionID, Attention> | null = null;

  for (const [id, attention] of state.attentions) {
    const migratedStart = migratePoint(attention.start, lookup);
    const migratedEnd = migratePoint(attention.end, lookup);

    if (migratedStart !== attention.start || migratedEnd !== attention.end) {
      if (next === null) next = new Map(state.attentions);
      next.set(id, Object.freeze({ ...attention, start: migratedStart, end: migratedEnd }));
    }
  }

  const migrated = next === null ? state : freezeAttentionState(next, state.nextID);
  return $proveCtx("O(n)", $lift("O(n)", migrated));
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
): LinearCost<InsertWithAttentionResult> {
  const result = pieceTableInsert(pieceTableState, position, text);
  return $proveCtx(
    "O(n)",
    $lift("O(n)", {
      pieceTableState: result.state,
      attentionState: migrateSplits(attentionState, result.splits),
      insertedByteLength: result.insertedByteLength,
    }),
  );
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
 * Points strictly before `start` are unaffected (their piece keeps its ID).
 * Points after `end` shift left by the deleted length. Points inside the span —
 * and points exactly at `start` — collapse to `start`. Collapsing (rather than
 * keeping) the `start`-boundary case is what saves a point anchored at boundary 0
 * of a fully-deleted interior piece: that piece is dropped entirely (no fragment
 * inherits its ID), so leaving the point as-is would dangle it; re-anchoring to
 * `start` keeps it live at the same document position. Already-dangling points
 * (and boundary overflows) are left untouched — they stay dangling rather than
 * re-anchoring to garbage.
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
  if (offset < start) return point; // strictly before the cut — piece + boundary still valid

  const newOffset = offset >= end ? offset - deletedLength : start;
  // Re-anchor against the post-delete tree. A null result (empty document) leaves
  // the old point, which then resolves to null — still fail-closed.
  return createPoint(newRoot, byteOffset(newOffset)) ?? point;
}

/**
 * Re-anchor every AttentionPoint across a delete, given the trees before and
 * after the cut. Lower-level hook used both by `deleteWithAttention` and by the
 * store dispatch path (which performs the piece-table delete itself).
 *
 * The split–join delete gives surviving fragments fresh piece IDs that no
 * `SplitRecord` captures, so ID rewriting (as `migrateSplits` does for inserts)
 * cannot heal points on a cut piece. Instead this resolves each point against
 * `oldRoot` and re-anchors it against `newRoot`. `start` and `end` must already
 * be clamped to `[0, oldTotalLength]`; an empty or inverted span is a no-op.
 *
 * Copy-on-write: the input state is returned untouched when no point moves.
 *
 * O(n + A·log n) — pre-delete indexing is O(n); each affected point re-anchors
 * in O(log n).
 */
export function migrateDelete(
  state: AttentionLayerState,
  oldRoot: PieceNode | null,
  newRoot: PieceNode | null,
  start: number,
  end: number,
): NLogNCost<AttentionLayerState> {
  if (start >= end) return $proveCtx("O(n log n)", $lift("O(n log n)", state));

  const oldIndex = buildPieceOffsetIndex(oldRoot);
  const deletedLength = end - start;

  // Copy-on-write: only clone the map once a point actually re-anchors.
  let next: Map<AttentionID, Attention> | null = null;
  for (const [id, attention] of state.attentions) {
    const migratedStart = migratePointForDelete(
      attention.start,
      oldIndex,
      newRoot,
      start,
      end,
      deletedLength,
    );
    const migratedEnd = migratePointForDelete(
      attention.end,
      oldIndex,
      newRoot,
      start,
      end,
      deletedLength,
    );
    if (migratedStart !== attention.start || migratedEnd !== attention.end) {
      if (next === null) next = new Map(state.attentions);
      next.set(id, Object.freeze({ ...attention, start: migratedStart, end: migratedEnd }));
    }
  }

  const migrated = next === null ? state : freezeAttentionState(next, state.nextID);
  return $proveCtx("O(n log n)", $lift("O(n log n)", migrated));
}

/**
 * Delete [start, end) and migrate the Attention Layer in one step.
 *
 * The Attention Layer stays caller-owned — pass the current `attentionState` in
 * and store the returned one. Re-anchoring is delegated to `migrateDelete`.
 *
 * O(n + A·log n).
 */
export function deleteWithAttention(
  pieceTableState: PieceTableState,
  attentionState: AttentionLayerState,
  start: ByteOffset,
  end: ByteOffset,
): NLogNCost<DeleteWithAttentionResult> {
  const total = pieceTableState.totalLength;
  const clampedStart = Math.max(0, Math.min(start, total));
  const clampedEnd = Math.max(0, Math.min(end, total));

  const oldRoot = pieceTableState.root;
  const newPieceTableState = pieceTableDelete(pieceTableState, start, end);

  return $proveCtx(
    "O(n log n)",
    $lift("O(n log n)", {
      pieceTableState: newPieceTableState,
      attentionState: migrateDelete(
        attentionState,
        oldRoot,
        newPieceTableState.root,
        clampedStart,
        clampedEnd,
      ),
      deletedByteLength: clampedStart >= clampedEnd ? 0 : clampedEnd - clampedStart,
    }),
  );
}
