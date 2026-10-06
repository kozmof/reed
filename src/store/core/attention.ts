import { IntervalIndex, type Interval } from "./interval-index.js";
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

import { PersistentMap } from "./persistent-map.js";
import { resolvePieceIdentity } from "./piece-identity-index.js";

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
  $beginCost,
  $proveCtx,
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
export { emptyAttentionLayerState } from "./attention-state.js";

function isValidAttentionBoundary(boundary: number): boolean {
  return Number.isSafeInteger(boundary) && boundary >= 0;
}

function assertValidAttentionBoundary(boundary: number, what: string): void {
  if (!isValidAttentionBoundary(boundary)) {
    throw new RangeError(`${what} boundary must be a non-negative safe integer`);
  }
}

function freezeAttentionPoint(point: AttentionPoint): AttentionPoint {
  return Object.freeze({ pieceID: point.pieceID, boundary: point.boundary });
}

function freezeAttentionState(
  attentions: PersistentMap<AttentionID, Attention>,
  nextID: number,
): AttentionLayerState {
  return Object.freeze({ attentions, nextID });
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
      $beginCost("O(log n)"),
      freezeAttentionPoint({ pieceID: last.node.id, boundary: last.offsetInPiece }),
    );
  }

  const location = findPieceAtPosition(root, byteOffset(clampedOffset));
  if (location === null) return null;

  return $proveCtx(
    $beginCost("O(log n)"),
    freezeAttentionPoint({ pieceID: location.node.id, boundary: location.offsetInPiece }),
  );
}

/**
 * Resolve an AttentionPoint to its current document byte offset.
 * Returns null for a dangling reference: the piece ID is no longer in the tree,
 * or the boundary now exceeds the piece's length (e.g. the piece was cut by a
 * delete). Failing closed avoids returning a silently-wrong offset.
 *
 * Expected O(P) on the first lookup and O(log P) with a cached identity index,
 * for bounded-length IDs with well-distributed hashes.
 * Insert/delete carry that index across structurally shared tree versions.
 */
export function resolvePoint(
  root: PieceNode | null,
  point: AttentionPoint,
): NLogNCost<ByteOffset> | null {
  if (root === null) return null;
  const entry = resolvePieceIdentity(root, point.pieceID);
  const offset =
    entry && isValidAttentionBoundary(point.boundary) && point.boundary <= entry.length
      ? byteOffset(entry.offset + point.boundary)
      : null;
  if (offset === null) return null;
  return $proveCtx($beginCost("O(n log n)"), offset);
}

// =============================================================================
// Attention API
// =============================================================================

/**
 * Create a new Attention spanning [start, end) and add it to the layer.
 * Returns [newState, id].
 *
 * `start` and `end` boundaries must be non-negative safe integers. The points
 * are otherwise stored as given, and the caller owns the `start <= end`
 * invariant. An inverted or zero-width span simply resolves to an empty range
 * (`getTextForAttention` returns "").
 *
 * O(log A) for native layers. External maps are indexed once in O(A log A).
 */
export function createAttention(
  state: AttentionLayerState,
  start: AttentionPoint,
  end: AttentionPoint,
): NLogNCost<[AttentionLayerState, AttentionID]> {
  assertValidAttentionBoundary(start.boundary, "start");
  assertValidAttentionBoundary(end.boundary, "end");
  const id = attentionID(`a${state.nextID}`);
  const attention: Attention = Object.freeze({
    id,
    start: freezeAttentionPoint(start),
    end: freezeAttentionPoint(end),
  });
  const next = persistentAttentions(state).with(id, attention);
  const result: [AttentionLayerState, AttentionID] = [
    updateAttentionState(state, next, state.nextID + 1, [id]),
    id,
  ];
  return $proveCtx($beginCost("O(n log n)"), result);
}

/**
 * Remove an Attention from the layer. No-op if the ID is unknown.
 *
 * O(log A) for native layers. External maps are indexed once in O(A log A).
 */
export function deleteAttention(
  state: AttentionLayerState,
  id: AttentionID,
): NLogNCost<AttentionLayerState> {
  if (!state.attentions.has(id)) return $proveCtx($beginCost("O(n log n)"), state);
  const next = persistentAttentions(state).without(id);
  return $proveCtx($beginCost("O(n log n)"), updateAttentionState(state, next, state.nextID, [id]));
}

/**
 * Look up an Attention by ID.
 *
 * O(log A).
 */
export function getAttention(
  state: AttentionLayerState,
  id: AttentionID,
): LogCost<Attention> | null {
  const attention = state.attentions.get(id);
  if (attention === undefined) return null;
  return $proveCtx($beginCost("O(log n)"), attention);
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

const pieceOffsetIndexCache = new WeakMap<PieceNode, PieceOffsetIndex>();
const emptyPieceOffsetIndex: PieceOffsetIndex = new Map();

type AttentionIDsByPiece = PersistentMap<PieceID, PersistentMap<AttentionID, true>>;
const attentionIDsByPieceCache = new WeakMap<AttentionLayerState, AttentionIDsByPiece>();

function buildAttentionIDsByPiece(state: AttentionLayerState): AttentionIDsByPiece {
  const cached = attentionIDsByPieceCache.get(state);
  if (cached !== undefined) return cached;

  let index = PersistentMap.empty<PieceID, PersistentMap<AttentionID, true>>();
  for (const [id, attention] of state.attentions) {
    for (const piece of new Set([attention.start.pieceID, attention.end.pieceID])) {
      index = index.with(
        piece,
        (index.get(piece) ?? PersistentMap.empty<AttentionID, true>()).with(id, true),
      );
    }
  }
  attentionIDsByPieceCache.set(state, index);
  return index;
}

const persistentAttentionCache = new WeakMap<
  AttentionLayerState,
  PersistentMap<AttentionID, Attention>
>();
function persistentAttentions(state: AttentionLayerState): PersistentMap<AttentionID, Attention> {
  let result = persistentAttentionCache.get(state);
  if (!result) {
    result = PersistentMap.from(state.attentions);
    persistentAttentionCache.set(state, result);
  }
  return result;
}

function updateAttentionState(
  state: AttentionLayerState,
  next: PersistentMap<AttentionID, Attention>,
  nextID: number,
  changed: Iterable<AttentionID>,
): AttentionLayerState {
  let index = buildAttentionIDsByPiece(state);
  for (const id of changed) {
    const old = state.attentions.get(id);
    const current = next.get(id);
    const oldPieces = new Set(old ? [old.start.pieceID, old.end.pieceID] : []);
    const newPieces = new Set(current ? [current.start.pieceID, current.end.pieceID] : []);
    for (const piece of oldPieces) {
      if (newPieces.has(piece)) continue;
      const ids = index.get(piece)!.without(id);
      index = ids.size ? index.with(piece, ids) : index.without(piece);
    }
    for (const piece of newPieces) {
      if (oldPieces.has(piece)) continue;
      index = index.with(
        piece,
        (index.get(piece) ?? PersistentMap.empty<AttentionID, true>()).with(id, true),
      );
    }
  }
  const result = freezeAttentionState(next, nextID);
  attentionIDsByPieceCache.set(result, index);
  return result;
}

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
  if (root === null) return emptyPieceOffsetIndex;
  const cached = pieceOffsetIndexCache.get(root);
  if (cached !== undefined) return cached;

  const index = new Map<PieceID, PieceOffsetEntry>();
  for (const { piece, docOffset } of inOrderPieces(root)) {
    index.set(piece.id, { offset: docOffset, length: piece.length });
  }
  pieceOffsetIndexCache.set(root, index);
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
  if (!isValidAttentionBoundary(point.boundary) || point.boundary > entry.length) return null;
  return byteOffset(entry.offset + point.boundary);
}

/**
 * Resolve an Attention against a prebuilt index.
 * Returns null when a point is dangling.
 */
function resolveAttentionWithIndex(
  index: PieceOffsetIndex,
  attention: Attention,
): ResolvedRange | null {
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
 * Expected O(P + log A) cold and O(log P + log A) with a cached identity index,
 * for bounded-length IDs with well-distributed hashes.
 */
export function resolveAttention(
  root: PieceNode | null,
  state: AttentionLayerState,
  id: AttentionID,
): NLogNCost<ResolvedRange> | null {
  const attention = state.attentions.get(id);
  if (attention === undefined) return null;
  const startOffset = resolvePoint(root, attention.start);
  const endOffset = resolvePoint(root, attention.end);
  if (startOffset === null || endOffset === null) return null;
  const range = { startOffset, endOffset };
  return $proveCtx($beginCost("O(n log n)"), range);
}

/**
 * Resolve every live attention with one shared piece-offset index.
 *
 * Dangling attentions are omitted, matching the fail-closed behavior of
 * `resolveAttention`. This is intended for bulk consumers such as normalized
 * checkpoint capture, avoiding a separate tree-path lookup for each point.
 *
 * O(P + A), where P is the piece count and A is the attention count.
 */
export function resolveAllAttentions(
  root: PieceNode | null,
  state: AttentionLayerState,
): LinearCost<ReadonlyMap<AttentionID, ResolvedRange>> {
  const index = buildPieceOffsetIndex(root);
  const resolved = new Map<AttentionID, ResolvedRange>();
  for (const [id, attention] of state.attentions) {
    const range = resolveAttentionWithIndex(index, attention);
    if (range !== null) resolved.set(id, range);
  }
  return $proveCtx($beginCost("O(n)"), asReadonlyMap(resolved));
}

// =============================================================================
// Text API
// =============================================================================

/**
 * Extract the text covered by an Attention.
 * Returns null when the Attention ID is unknown or a point is dangling.
 *
 * Identity lookup plus the bytes read. Cold indexing is expected O(P) for
 * bounded-length IDs with well-distributed hashes.
 */
export function getTextForAttention(
  pieceTableState: PieceTableState,
  attentionState: AttentionLayerState,
  id: AttentionID,
): NLogNCost<string> | null {
  const offsets = resolveAttention(pieceTableState.root, attentionState, id);
  if (offsets === null) return null;
  if (offsets.startOffset >= offsets.endOffset) return $proveCtx($beginCost("O(n log n)"), "");
  return $proveCtx(
    $beginCost("O(n log n)"),
    getText(pieceTableState, offsets.startOffset, offsets.endOffset) as string,
  );
}

// =============================================================================
// Query API
// =============================================================================

interface IndexedAttention {
  id: AttentionID;
  order: number;
  start: number;
  end: number;
}
const rangeIndexes = new WeakMap<
  AttentionLayerState,
  WeakMap<PieceNode, IntervalIndex<IndexedAttention>>
>();

function attentionRangeIndex(
  state: AttentionLayerState,
  root: PieceNode,
): IntervalIndex<IndexedAttention> {
  let roots = rangeIndexes.get(state);
  if (!roots) rangeIndexes.set(state, (roots = new WeakMap()));
  const cached = roots.get(root);
  if (cached) return cached;
  const pieces = buildPieceOffsetIndex(root);
  const intervals: Interval<IndexedAttention>[] = [];
  let order = 0;
  for (const [id, attention] of state.attentions) {
    const offsets = resolveAttentionWithIndex(pieces, attention);
    if (offsets) {
      intervals.push({
        start: Math.min(offsets.startOffset, offsets.endOffset),
        end: Math.max(offsets.startOffset, offsets.endOffset),
        value: { id, order, start: offsets.startOffset, end: offsets.endOffset },
      });
    }
    order++;
  }
  const index = new IntervalIndex(intervals);
  roots.set(root, index);
  return index;
}

function queryAttentions(
  state: AttentionLayerState,
  root: PieceNode | null,
  start: number,
  end: number,
  point: boolean,
): AttentionID[] {
  if (!root || state.attentions.size === 0) return [];
  // Restore map iteration order without scanning unrelated annotations.
  return attentionRangeIndex(state, root)
    .query(start, end, point)
    .filter((entry) => entry.end > start && (point ? entry.start <= end : entry.start < end))
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.id);
}

/**
 * IDs containing offset. A snapshot builds its interval index lazily in
 * O(P + A log A); warm queries visit matching intervals and boundary paths.
 * Ordering the K results to preserve map iteration order costs O(K log K).
 */
export function findAttentionsAt(
  state: AttentionLayerState,
  root: PieceNode | null,
  offset: number,
): NLogNCost<AttentionID[]> {
  return $proveCtx($beginCost("O(n log n)"), queryAttentions(state, root, offset, offset, true));
}

/** IDs overlapping [start, end), with the same snapshot index and result order. */
export function findAttentionsOverlapping(
  state: AttentionLayerState,
  root: PieceNode | null,
  start: number,
  end: number,
): NLogNCost<AttentionID[]> {
  return $proveCtx($beginCost("O(n log n)"), queryAttentions(state, root, start, end, false));
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
 * The reverse index is maintained across snapshots. Work depends on the split
 * pieces and their candidate annotations, with logarithmic persistent-map updates.
 * Externally constructed layers pay a one-time O(A log A) indexing cost.
 */
export function migrateSplits(
  state: AttentionLayerState,
  splits: readonly SplitRecord[],
): NLogNCost<AttentionLayerState> {
  if (splits.length === 0) return $proveCtx($beginCost("O(n log n)"), state);

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

  const idsByPiece = buildAttentionIDsByPiece(state);
  const candidates = new Set<AttentionID>();
  for (const split of splits) {
    const ids = idsByPiece.get(split.originalID);
    if (ids !== undefined) for (const id of ids.keys()) candidates.add(id);
  }
  if (candidates.size === 0) return $proveCtx($beginCost("O(n log n)"), state);

  // Allocate persistent search paths only when a point actually migrates.
  let next: PersistentMap<AttentionID, Attention> | null = null;
  for (const id of candidates) {
    const attention = state.attentions.get(id)!;
    const migratedStart = migratePoint(attention.start, lookup);
    const migratedEnd = migratePoint(attention.end, lookup);

    if (migratedStart !== attention.start || migratedEnd !== attention.end) {
      if (next === null) next = persistentAttentions(state);
      next = next.with(id, Object.freeze({ ...attention, start: migratedStart, end: migratedEnd }));
    }
  }

  const migrated =
    next === null ? state : updateAttentionState(state, next, state.nextID, candidates);
  return $proveCtx($beginCost("O(n log n)"), migrated);
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
 * Piece-table insertion plus indexed annotation migration.
 */
export function insertWithAttention(
  pieceTableState: PieceTableState,
  attentionState: AttentionLayerState,
  position: ByteOffset,
  text: string,
): NLogNCost<InsertWithAttentionResult> {
  const result = pieceTableInsert(pieceTableState, position, text);
  return $proveCtx($beginCost("O(n log n)"), {
    pieceTableState: result.state,
    attentionState: migrateSplits(attentionState, result.splits),
    insertedByteLength: result.insertedByteLength,
  });
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
  if (
    entry === undefined ||
    !isValidAttentionBoundary(point.boundary) ||
    point.boundary > entry.length
  ) {
    return point; // dangling: leave as-is
  }

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
 * Visits O(log n + deleted pieces) tree nodes; affected points re-anchor in O(log n).
 * The reverse attention index is cached per attention state.
 */
export function migrateDelete(
  state: AttentionLayerState,
  oldRoot: PieceNode | null,
  newRoot: PieceNode | null,
  start: number,
  end: number,
): NLogNCost<AttentionLayerState> {
  if (start >= end) return $proveCtx($beginCost("O(n log n)"), state);
  // Attention is optional for the common editor path. Avoid an otherwise
  // unnecessary full piece-tree index when there are no points to migrate.
  if (state.attentions.size === 0) return $proveCtx($beginCost("O(n log n)"), state);

  // Only pieces intersecting the cut can lose their identity or length.
  // Prune untouched subtrees instead of indexing both complete trees.
  const oldIndex = new Map<PieceID, PieceOffsetEntry>();
  const idsByPiece = buildAttentionIDsByPiece(state);
  const candidates = new Set<AttentionID>();
  function visit(node: PieceNode | null, base: number): void {
    if (node === null || base >= end || base + node.subtreeLength <= start) return;
    const offset = base + (node.left?.subtreeLength ?? 0);
    visit(node.left, base);
    if (offset < end && offset + node.length > start) {
      oldIndex.set(node.id, { offset, length: node.length });
      const ids = idsByPiece.get(node.id);
      if (ids !== undefined) for (const id of ids.keys()) candidates.add(id);
    }
    visit(node.right, offset + node.length);
  }
  visit(oldRoot, 0);
  if (candidates.size === 0) return $proveCtx($beginCost("O(n log n)"), state);

  const deletedLength = end - start;
  // Allocate persistent search paths only when a point actually re-anchors.
  let next: PersistentMap<AttentionID, Attention> | null = null;
  for (const id of candidates) {
    const attention = state.attentions.get(id)!;
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
      if (next === null) next = persistentAttentions(state);
      next = next.with(id, Object.freeze({ ...attention, start: migratedStart, end: migratedEnd }));
    }
  }

  const migrated =
    next === null ? state : updateAttentionState(state, next, state.nextID, candidates);
  return $proveCtx($beginCost("O(n log n)"), migrated);
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

  return $proveCtx($beginCost("O(n log n)"), {
    pieceTableState: newPieceTableState,
    attentionState: migrateDelete(
      attentionState,
      oldRoot,
      newPieceTableState.root,
      clampedStart,
      clampedEnd,
    ),
    deletedByteLength: clampedStart >= clampedEnd ? 0 : clampedEnd - clampedStart,
  });
}
