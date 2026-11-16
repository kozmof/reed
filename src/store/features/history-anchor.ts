/**
 * Anchored history positions.
 *
 * History stores positions as (afterChunk, position) pairs that survive chunk
 * loading and eviction. See `HistoryAnchor` in `types/state.ts` and
 * `core/chunk-anchor.ts` for the coordinate system.
 */

import type {
  HistoryAnchor,
  HistoryEntry,
  HistorySelectionRange,
  HistorySelectionState,
  HistoryState,
  PieceTableState,
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
  loadedLengthAtOrBelow,
  toAnchoredOffset,
  toResidentOffset,
} from "../core/chunk-anchor.js";
import { forEachHistoryChange, someHistoryChange } from "./history-entry.js";

/** Anchor resident `offset` using placement key `key`. */
export function anchorAt(pieceTable: PieceTableState, key: number, offset: number): HistoryAnchor {
  return { position: toAnchoredOffset(pieceTable, key, offset), afterChunk: key };
}

/** Resident offset of an anchored position in `pieceTable`. */
export function residentOffset(pieceTable: PieceTableState, anchor: HistoryAnchor): ByteOffset {
  return byteOffset(toResidentOffset(pieceTable, anchor.afterChunk, anchor.position));
}

// Before any chunk loads, every key is NO_CHUNK and an anchored position equals
// its offset, so the anchored form depends only on the selection. Selections
// are immutable, so cache it per selection object and share it across edits.
const unchunkedCache = new WeakMap<SelectionState, HistorySelectionState>();

function anchorUnchunked(selection: SelectionState): HistorySelectionState {
  const cached = unchunkedCache.get(selection);
  if (cached !== undefined) return cached;
  const ranges = selection.ranges.map(
    (range): HistorySelectionRange =>
      Object.freeze({
        anchor: range.anchor,
        head: range.head,
        anchorAfterChunk: NO_CHUNK,
        headAfterChunk: NO_CHUNK,
      }),
  );
  const anchored: HistorySelectionState = Object.freeze({
    ranges: Object.freeze(ranges) as unknown as NonEmptyReadonlyArray<HistorySelectionRange>,
    primaryIndex: selection.primaryIndex,
  });
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
  return Object.freeze({
    ranges: Object.freeze(ranges) as unknown as NonEmptyReadonlyArray<HistorySelectionRange>,
    primaryIndex: selection.primaryIndex,
  });
}

/** A history selection holding one cursor at anchored `position` with key `key`. */
export function anchoredCursor(key: number, position: number): HistorySelectionState {
  return Object.freeze({
    ranges: Object.freeze([
      Object.freeze({
        anchor: position,
        head: position,
        anchorAfterChunk: key,
        headAfterChunk: key,
      }),
    ]) as unknown as NonEmptyReadonlyArray<HistorySelectionRange>,
    primaryIndex: 0,
  });
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
  return Object.freeze({
    ranges: Object.freeze(
      selection.ranges.map((range) =>
        Object.freeze({
          anchor: clamp(range.anchorAfterChunk, range.anchor),
          head: clamp(range.headAfterChunk, range.head),
        }),
      ),
    ) as unknown as SelectionState["ranges"],
    primaryIndex: selection.primaryIndex,
  });
}

// =============================================================================
// Live selection across chunk loads and evictions
// =============================================================================

/**
 * Anchored form of a live selection, valid while the piece tree is `root`. A
 * gap next to an unloaded chunk has two sides, and its resident offset cannot
 * say which one the cursor is on. Keeping the anchor from the last load or
 * eviction keeps the cursor on its side when the chunk loads again.
 */
interface LiveAnchors {
  readonly root: PieceTableState["root"];
  readonly anchored: HistorySelectionState;
}

// Selections and piece trees are immutable, so an entry stays valid until
// either changes. Every edit, load, and eviction replaces the tree, and every
// selection change replaces the selection. The piece table object itself is
// copied on each state update, so it cannot serve as the key.
const liveAnchors = new WeakMap<SelectionState, LiveAnchors>();

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
    cached !== undefined && cached.root === before.root
      ? cached.anchored
      : anchorSelection(before, selection);
  const resolved = resolveSelection(after, anchored);
  const unchanged = resolved.ranges.every(
    (range, i) =>
      range.anchor === selection.ranges[i]!.anchor && range.head === selection.ranges[i]!.head,
  );
  const result = unchanged ? selection : resolved;
  // Re-anchor with the same keys, so a clamped offset records where it is now.
  const reanchored: HistorySelectionState = Object.freeze({
    ranges: Object.freeze(
      anchored.ranges.map((range, i) =>
        Object.freeze({
          ...range,
          anchor: toAnchoredOffset(after, range.anchorAfterChunk, result.ranges[i]!.anchor),
          head: toAnchoredOffset(after, range.headAfterChunk, result.ranges[i]!.head),
        }),
      ),
    ) as unknown as NonEmptyReadonlyArray<HistorySelectionRange>,
    primaryIndex: anchored.primaryIndex,
  });
  liveAnchors.set(result, { root: after.root, anchored: reanchored });
  return result;
}

// =============================================================================
// Eviction guard
// =============================================================================

interface HistoryCuts {
  /** Stack index of the newest undo entry pointing inside the span, or -1. */
  readonly undoCut: number;
  /** Stack index of the newest redo entry pointing inside the span, or -1. */
  readonly redoCut: number;
}

/** Per placement key, the lowest and highest anchored position of some changes. */
type KeyBounds = ReadonlyMap<number, readonly [low: number, high: number]>;

type StackNode = NonNullable<HistoryState["undoStack"]>;

const EMPTY_BOUNDS: KeyBounds = new Map();
const entryBoundsCache = new WeakMap<HistoryEntry, KeyBounds>();
// Stack nodes are shared between successive stacks, so a push or pop computes
// bounds only for the O(log H) nodes it creates.
const nodeBoundsCache = new WeakMap<StackNode, KeyBounds>();

function entryBounds(entry: HistoryEntry): KeyBounds {
  let bounds = entryBoundsCache.get(entry);
  if (bounds !== undefined) return bounds;
  const map = new Map<number, readonly [number, number]>();
  forEachHistoryChange(entry, (change) => {
    const current = map.get(change.afterChunk);
    map.set(
      change.afterChunk,
      current === undefined
        ? [change.position, change.position]
        : [Math.min(current[0], change.position), Math.max(current[1], change.position)],
    );
  });
  bounds = map;
  entryBoundsCache.set(entry, bounds);
  return bounds;
}

function mergeBounds(target: Map<number, readonly [number, number]>, source: KeyBounds): void {
  for (const [key, [low, high]] of source) {
    const current = target.get(key);
    target.set(
      key,
      current === undefined ? [low, high] : [Math.min(current[0], low), Math.max(current[1], high)],
    );
  }
}

/** Bounds of every change in the subtree rooted at `node`. */
function nodeBounds(node: StackNode | null): KeyBounds {
  if (node === null) return EMPTY_BOUNDS;
  let bounds = nodeBoundsCache.get(node);
  if (bounds !== undefined) return bounds;
  const own = entryBounds(node.value);
  if (node.left === null && node.right === null) {
    bounds = own;
  } else {
    const map = new Map(nodeBounds(node.left));
    mergeBounds(map, own);
    mergeBounds(map, nodeBounds(node.right));
    bounds = map;
  }
  nodeBoundsCache.set(node, bounds);
  return bounds;
}

/**
 * Stack index (oldest first) of the newest entry in the subtree with a change
 * keyed `key` strictly inside (low, high), or -1. Subtrees whose bounds for
 * `key` miss the span are skipped, so a stack with nothing inside the span
 * costs O(1) once its bounds are known.
 */
function newestInside(
  node: StackNode | null,
  firstIndex: number,
  key: number,
  low: number,
  high: number,
): number {
  if (node === null) return -1;
  const bounds = nodeBounds(node).get(key);
  if (bounds === undefined || bounds[0] >= high || bounds[1] <= low) return -1;
  const ownIndex = firstIndex + (node.left?.size ?? 0);
  const right = newestInside(node.right, ownIndex + 1, key, low, high);
  if (right >= 0) return right;
  const own = entryBounds(node.value).get(key);
  if (
    own !== undefined &&
    own[0] < high &&
    own[1] > low &&
    someHistoryChange(
      node.value,
      (change) => change.afterChunk === key && change.position > low && change.position < high,
    )
  ) {
    return ownIndex;
  }
  return newestInside(node.left, firstIndex, key, low, high);
}

/**
 * Find the newest entries of each stack with a change keyed `key` whose
 * anchored position lies strictly inside (low, high).
 */
function historyCuts(history: HistoryState, key: number, low: number, high: number): HistoryCuts {
  return {
    undoCut: newestInside(history.undoStack, 0, key, low, high),
    redoCut: newestInside(history.redoStack, 0, key, low, high),
  };
}

/**
 * Apply the history eviction policy before evicting `chunkIndex`, whose
 * resident span is [start, end).
 *
 * A change points strictly inside the chunk when it carries the key
 * `chunkIndex - 1` and resolves inside (start, end). After eviction the chunk's
 * bytes are gone, so such a position can no longer be resolved. The chunk's
 * boundaries are fine: they stay meaningful without its bytes.
 *
 * Entries older than the newest such entry can only be replayed after it, so
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
  end: number,
): HistoryState | null {
  if (history.undoStack === null && history.redoStack === null) return history;
  // Every candidate change shares one key, so compare anchored positions
  // against the chunk span shifted once, instead of resolving each change.
  const key = chunkIndex - 1;
  const shift = loadedLengthAtOrBelow(pieceTable, key);
  const { undoCut, redoCut } = historyCuts(history, key, start - shift, end - shift);
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
