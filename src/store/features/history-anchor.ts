/**
 * Anchored history positions.
 *
 * History stores positions as (afterChunk, position) pairs that survive chunk
 * loading and eviction. See `HistoryAnchor` in `types/state.ts` and
 * `core/chunk-anchor.ts` for the coordinate system.
 */

import type {
  HistoryAnchor,
  HistoryChange,
  HistoryEntry,
  HistorySelectionRange,
  HistorySelectionState,
  HistoryState,
  PieceTableState,
  SelectionRange,
  SelectionState,
} from "../../types/state.js";
import type { NonEmptyReadonlyArray } from "../../types/utils.js";
import { pstackSize, pstackTrimToSize } from "../../types/state.js";
import type { ByteOffset } from "../../types/branded.js";
import { byteOffset } from "../../types/branded.js";
import {
  NO_CHUNK,
  gapKey,
  keySpan,
  toAnchoredOffset,
  toResidentOffset,
} from "../core/chunk-anchor.js";
import {
  forEachHistoryChange,
  someHistoryChange,
  someHistoryChangeBackward,
} from "./history-entry.js";

/** Anchor resident `offset` using placement key `key`. */
export function anchorAt(pieceTable: PieceTableState, key: number, offset: number): HistoryAnchor {
  return { position: toAnchoredOffset(pieceTable, key, offset), afterChunk: key };
}

/** Resident offset of an anchored position in `pieceTable`. */
export function residentOffset(pieceTable: PieceTableState, anchor: HistoryAnchor): ByteOffset {
  return byteOffset(toResidentOffset(pieceTable, anchor.afterChunk, anchor.position));
}

/**
 * Freeze already-frozen `ranges` into a selection. `ranges` comes from mapping
 * a non-empty selection, so it is non-empty.
 */
function freezeSelection<R extends SelectionRange | HistorySelectionRange>(
  ranges: readonly R[],
  primaryIndex: number,
): { readonly ranges: NonEmptyReadonlyArray<R>; readonly primaryIndex: number } {
  return Object.freeze({
    ranges: Object.freeze(ranges) as unknown as NonEmptyReadonlyArray<R>,
    primaryIndex,
  });
}

// Before any chunk loads, every key is NO_CHUNK and an anchored position equals
// its offset, so the anchored form depends only on the selection. Selections
// are immutable, so cache it per selection object and share it across edits.
const unchunkedCache = new WeakMap<SelectionState, HistorySelectionState>();

function anchorUnchunked(selection: SelectionState): HistorySelectionState {
  const cached = unchunkedCache.get(selection);
  if (cached !== undefined) return cached;
  const anchored = freezeSelection(
    selection.ranges.map(
      (range): HistorySelectionRange =>
        Object.freeze({
          anchor: range.anchor,
          head: range.head,
          anchorAfterChunk: NO_CHUNK,
          headAfterChunk: NO_CHUNK,
        }),
    ),
    selection.primaryIndex,
  );
  unchunkedCache.set(selection, anchored);
  return anchored;
}

/**
 * Anchor a live selection, giving each gap the key new text would receive there.
 *
 * `shift`, when given, returns an amount to add to the anchored value of each
 * offset. An edit uses it when the document that undo rebuilds differs in
 * length from the one the selection was made in.
 */
export function anchorSelection(
  pieceTable: PieceTableState,
  selection: SelectionState,
  shift?: (offset: number) => number,
): HistorySelectionState {
  const unchunked = pieceTable.nextExpectedChunk === 0;
  if (unchunked && shift === undefined) return anchorUnchunked(selection);
  const root = pieceTable.root;
  const keyAt = (offset: number): number => (unchunked ? NO_CHUNK : gapKey(root, offset));
  const anchored = (key: number, offset: number): number =>
    toAnchoredOffset(pieceTable, key, offset) + (shift?.(offset) ?? 0);
  const ranges = selection.ranges.map((range): HistorySelectionRange => {
    const anchorKey = keyAt(range.anchor);
    const headKey = range.head === range.anchor ? anchorKey : keyAt(range.head);
    return Object.freeze({
      anchor: anchored(anchorKey, range.anchor),
      head: anchored(headKey, range.head),
      anchorAfterChunk: anchorKey,
      headAfterChunk: headKey,
    });
  });
  return freezeSelection(ranges, selection.primaryIndex);
}

/** A history selection holding one cursor at anchored `position` with key `key`. */
export function anchoredCursor(key: number, position: number): HistorySelectionState {
  return freezeSelection(
    [
      Object.freeze({
        anchor: position,
        head: position,
        anchorAfterChunk: key,
        headAfterChunk: key,
      }),
    ],
    0,
  );
}

/**
 * Resolve a history selection to resident offsets.
 *
 * Selections do not block eviction, so a cursor may have pointed inside a chunk
 * that is no longer loaded. Its resident offset would then land in whatever
 * follows that chunk. Each position is instead clamped to the span of gaps that
 * share its placement key, which puts it where the evicted chunk was, as
 * `evictChunk` does for the live selection.
 */
export function resolveSelection(
  pieceTable: PieceTableState,
  selection: HistorySelectionState,
): SelectionState {
  const clamp = (key: number, anchored: number) => {
    const { start, end } = keySpan(pieceTable.root, key);
    const offset = toResidentOffset(pieceTable, key, anchored);
    return byteOffset(Math.max(start, Math.min(offset, end)));
  };
  return freezeSelection(
    selection.ranges.map(
      (range): SelectionRange =>
        Object.freeze({
          anchor: clamp(range.anchorAfterChunk, range.anchor),
          head: clamp(range.headAfterChunk, range.head),
        }),
    ),
    selection.primaryIndex,
  );
}

// =============================================================================
// Live selection across chunk loads and evictions
// =============================================================================

/**
 * Anchored form of a live selection, valid while the piece tree is the one
 * `root` refers to. A gap next to an unloaded chunk has two sides, and its
 * resident offset cannot say which one the cursor is on. Keeping the anchor
 * from the last load or eviction keeps the cursor on its side when the chunk
 * loads again.
 *
 * `root` is weak so that a selection that outlives many edits does not keep an
 * old piece tree alive. It is null for an empty document.
 */
interface LiveAnchors {
  readonly root: WeakRef<NonNullable<PieceTableState["root"]>> | null;
  readonly anchored: HistorySelectionState;
}

// Selections and piece trees are immutable, so an entry stays valid until
// either changes. Every edit, load, and eviction replaces the tree, and every
// selection change replaces the selection. The piece table object itself is
// copied on each state update, so it cannot serve as the key.
const liveAnchors = new WeakMap<SelectionState, LiveAnchors>();

function isLiveRoot(cached: LiveAnchors, root: PieceTableState["root"]): boolean {
  return cached.root === null ? root === null : cached.root.deref() === root;
}

/**
 * Move the live selection from `before` to `after`, two documents that differ
 * only by loaded or evicted chunks.
 *
 * Each offset is anchored in `before` and resolved in `after`, the same way
 * history selections are. An offset inside an evicted chunk lands where the
 * chunk was, and keeps that chunk's key, so evicting and re-loading a chunk
 * leaves the cursor where it was. Returns `selection` itself when no offset
 * moves.
 */
export function carrySelectionAcrossChunks(
  before: PieceTableState,
  after: PieceTableState,
  selection: SelectionState,
): SelectionState {
  const cached = liveAnchors.get(selection);
  const anchored =
    cached !== undefined && isLiveRoot(cached, before.root)
      ? cached.anchored
      : anchorSelection(before, selection);
  const resolved = resolveSelection(after, anchored);
  const unchanged = resolved.ranges.every(
    (range, i) =>
      range.anchor === selection.ranges[i]!.anchor && range.head === selection.ranges[i]!.head,
  );
  const result = unchanged ? selection : resolved;
  // Re-anchor with the same keys, so a clamped offset records where it is now.
  const reanchored = freezeSelection(
    anchored.ranges.map(
      (range, i): HistorySelectionRange =>
        Object.freeze({
          ...range,
          anchor: toAnchoredOffset(after, range.anchorAfterChunk, result.ranges[i]!.anchor),
          head: toAnchoredOffset(after, range.headAfterChunk, result.ranges[i]!.head),
        }),
    ),
    anchored.primaryIndex,
  );
  liveAnchors.set(result, {
    root: after.root === null ? null : new WeakRef(after.root),
    anchored: reanchored,
  });
  return result;
}

// =============================================================================
// Eviction guard
// =============================================================================

/**
 * Key range and length change of some history changes, for skipping whole
 * stack subtrees. `delta` is the net number of bytes the changes add when
 * applied forward.
 */
interface ChangeSummary {
  readonly minKey: number;
  readonly maxKey: number;
  readonly delta: number;
}

type StackNode = NonNullable<HistoryState["undoStack"]>;

const EMPTY_SUMMARY: ChangeSummary = { minKey: Infinity, maxKey: -Infinity, delta: 0 };
const entrySummaryCache = new WeakMap<HistoryEntry, ChangeSummary>();
// Stack nodes are shared between successive stacks, so a push or pop computes
// summaries only for the O(log H) nodes it creates, each in O(1).
const nodeSummaryCache = new WeakMap<StackNode, ChangeSummary>();

/** Bytes `change` adds to the document when applied forward. */
function changeDelta(change: HistoryChange): number {
  switch (change.type) {
    case "insert":
      return change.byteLength;
    case "delete":
      return -change.byteLength;
    case "replace":
      return change.byteLength - change.oldByteLength;
  }
}

function combineSummaries(a: ChangeSummary, b: ChangeSummary): ChangeSummary {
  return {
    minKey: Math.min(a.minKey, b.minKey),
    maxKey: Math.max(a.maxKey, b.maxKey),
    delta: a.delta + b.delta,
  };
}

function entrySummary(entry: HistoryEntry): ChangeSummary {
  let summary = entrySummaryCache.get(entry);
  if (summary !== undefined) return summary;
  let minKey = Infinity;
  let maxKey = -Infinity;
  let delta = 0;
  forEachHistoryChange(entry, (change) => {
    minKey = Math.min(minKey, change.afterChunk);
    maxKey = Math.max(maxKey, change.afterChunk);
    delta += changeDelta(change);
  });
  summary = { minKey, maxKey, delta };
  entrySummaryCache.set(entry, summary);
  return summary;
}

/** Summary of every change in the subtree rooted at `node`. */
function nodeSummary(node: StackNode | null): ChangeSummary {
  if (node === null) return EMPTY_SUMMARY;
  let summary = nodeSummaryCache.get(node);
  if (summary !== undefined) return summary;
  summary = combineSummaries(
    combineSummaries(nodeSummary(node.left), entrySummary(node.value)),
    nodeSummary(node.right),
  );
  nodeSummaryCache.set(node, summary);
  return summary;
}

/**
 * The chunk being evicted, followed back through one history stack. `start` is
 * the anchored position, with key `key`, of the chunk's first byte in the
 * document the next visited change applies to. `direction` is -1 on the undo
 * stack, whose changes are undone, and 1 on the redo stack.
 */
interface ChunkTrack {
  readonly key: number;
  readonly direction: 1 | -1;
  start: number;
}

/**
 * True when `change` points inside the tracked chunk in the document it
 * applies to. Otherwise moves the chunk's start past the change.
 *
 * A change keyed below `key` lies wholly before the chunk, and one keyed above
 * it wholly after. A change keyed `key` lies before the chunk when its position
 * is at or before the chunk's start. Past that start it resolves by counting
 * the chunk's bytes, which eviction removes.
 */
function changeInsideChunk(change: HistoryChange, track: ChunkTrack): boolean {
  if (change.afterChunk > track.key) return false;
  if (change.afterChunk === track.key && change.position > track.start) return true;
  track.start += track.direction * changeDelta(change);
  return false;
}

/**
 * Stack index (oldest first) of the first entry, in the order the stack is
 * replayed (newest first), with a change inside the tracked chunk, or -1.
 * Subtrees whose changes all lie on one side of the chunk are skipped in O(1).
 */
function firstInside(node: StackNode | null, firstIndex: number, track: ChunkTrack): number {
  if (node === null) return -1;
  const summary = nodeSummary(node);
  if (summary.minKey > track.key) return -1;
  if (summary.maxKey < track.key) {
    track.start += track.direction * summary.delta;
    return -1;
  }
  const ownIndex = firstIndex + (node.left?.size ?? 0);
  const right = firstInside(node.right, ownIndex + 1, track);
  if (right >= 0) return right;
  // Undo applies an entry's changes last to first, and redo first to last.
  const visit = (change: HistoryChange) => changeInsideChunk(change, track);
  const inside =
    track.direction < 0
      ? someHistoryChangeBackward(node.value, visit)
      : someHistoryChange(node.value, visit);
  if (inside) return ownIndex;
  return firstInside(node.left, firstIndex, track);
}

/**
 * Apply the history eviction policy before evicting `chunkIndex`, whose first
 * resident byte is at `start`.
 *
 * A change points inside the chunk when it carries the key `chunkIndex - 1`
 * and lies past the chunk's start in the document it applies to. Such a
 * position resolves by counting the chunk's bytes, so it cannot be resolved
 * once they are gone. The chunk's start is fine: it stays meaningful without
 * the chunk's bytes.
 *
 * Each change records its position in the document it applies to, not in the
 * current one, and edits before the chunk move the chunk. The guard therefore
 * follows the chunk's start back through each stack, one change at a time.
 *
 * Entries older than the first such entry can only be replayed after it, so
 * dropping it means dropping all of them.
 *
 * Returns the history to keep, or `null` when the eviction must be refused
 * (policy `"pin"` with history pointing inside the chunk). Returns the same
 * history object when nothing points inside the chunk.
 */
export function historyForEviction(
  pieceTable: PieceTableState,
  history: HistoryState,
  chunkIndex: number,
  start: number,
): HistoryState | null {
  if (history.undoStack === null && history.redoStack === null) return history;
  const key = chunkIndex - 1;
  const anchoredStart = toAnchoredOffset(pieceTable, key, start);
  const cut = (stack: HistoryState["undoStack"], direction: 1 | -1) =>
    firstInside(stack, 0, { key, direction, start: anchoredStart });
  const undoCut = cut(history.undoStack, -1);
  const redoCut = cut(history.redoStack, 1);
  if (undoCut < 0 && redoCut < 0) return history;
  if (history.evictionPolicy === "pin") return null;
  // Keep only the entries newer than the cut. The split shares structure.
  const keepNewerThan = (stack: HistoryState["undoStack"], cut: number) =>
    cut < 0 ? stack : pstackTrimToSize(stack, pstackSize(stack) - cut - 1);
  return Object.freeze({
    ...history,
    undoStack: keepNewerThan(history.undoStack, undoCut),
    redoStack: keepNewerThan(history.redoStack, redoCut),
  });
}
