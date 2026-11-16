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
import { pstackFindNewestIndex, pstackSize, pstackTrimToSize } from "../../types/state.js";
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
import { someHistoryChange } from "./history-entry.js";

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

/** Anchor a live selection, giving each gap the key new text would receive there. */
export function anchorSelection(
  pieceTable: PieceTableState,
  selection: SelectionState,
): HistorySelectionState {
  if (pieceTable.nextExpectedChunk === 0) return anchorUnchunked(selection);
  const root = pieceTable.root;
  const ranges = selection.ranges.map((range): HistorySelectionRange => {
    const anchorKey = gapKey(root, range.anchor);
    const headKey = range.head === range.anchor ? anchorKey : gapKey(root, range.head);
    return Object.freeze({
      anchor: toAnchoredOffset(pieceTable, anchorKey, range.anchor),
      head: toAnchoredOffset(pieceTable, headKey, range.head),
      anchorAfterChunk: anchorKey,
      headAfterChunk: headKey,
    });
  });
  return Object.freeze({
    ranges: Object.freeze(ranges) as unknown as NonEmptyReadonlyArray<HistorySelectionRange>,
    primaryIndex: selection.primaryIndex,
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
// Eviction guard
// =============================================================================

interface HistoryCuts {
  /** Stack index of the newest undo entry pointing inside the span, or -1. */
  readonly undoCut: number;
  /** Stack index of the newest redo entry pointing inside the span, or -1. */
  readonly redoCut: number;
}

// ChunkManager retries every refused eviction candidate on each load. History
// is replaced, never mutated, so the scan for a given chunk span is cached on
// the history object and a retry costs one map lookup.
const cutsCache = new WeakMap<HistoryState, Map<string, HistoryCuts>>();

/**
 * Find the newest entries of each stack with a change keyed `key` whose
 * anchored position lies strictly inside (low, high).
 */
function historyCuts(history: HistoryState, key: number, low: number, high: number): HistoryCuts {
  let bySpan = cutsCache.get(history);
  if (bySpan === undefined) {
    bySpan = new Map();
    cutsCache.set(history, bySpan);
  }
  const span = `${key}:${low}:${high}`;
  const cached = bySpan.get(span);
  if (cached !== undefined) return cached;
  const pointsInside = (entry: HistoryEntry): boolean =>
    someHistoryChange(
      entry,
      (change) => change.afterChunk === key && change.position > low && change.position < high,
    );
  const cuts = {
    undoCut: pstackFindNewestIndex(history.undoStack, pointsInside),
    redoCut: pstackFindNewestIndex(history.redoStack, pointsInside),
  };
  bySpan.set(span, cuts);
  return cuts;
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
