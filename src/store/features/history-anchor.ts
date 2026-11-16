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
  SelectionState,
} from "../../types/state.js";
import type { NonEmptyReadonlyArray } from "../../types/utils.js";
import { pstackFromArray, pstackToArray } from "../../types/state.js";
import type { ByteOffset } from "../../types/branded.js";
import { byteOffset } from "../../types/branded.js";
import { gapKey, toAnchoredOffset, toResidentOffset } from "../core/chunk-anchor.js";

/** Anchor resident `offset` using placement key `key`. */
export function anchorAt(pieceTable: PieceTableState, key: number, offset: number): HistoryAnchor {
  return { position: toAnchoredOffset(pieceTable, key, offset), afterChunk: key };
}

/** Resident offset of an anchored position in `pieceTable`. */
export function residentOffset(pieceTable: PieceTableState, anchor: HistoryAnchor): ByteOffset {
  return byteOffset(toResidentOffset(pieceTable, anchor.afterChunk, anchor.position));
}

/** Anchor a live selection, giving each gap the key new text would receive there. */
export function anchorSelection(
  pieceTable: PieceTableState,
  selection: SelectionState,
): HistorySelectionState {
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
 * Resolve a history selection to resident offsets, clamped to the document.
 * Selections are not guarded against eviction, so a cursor that pointed inside
 * an evicted chunk resolves to a nearby position rather than failing.
 */
export function resolveSelection(
  pieceTable: PieceTableState,
  selection: HistorySelectionState,
): SelectionState {
  const max = pieceTable.totalLength;
  const clamp = (key: number, anchored: number) =>
    byteOffset(Math.max(0, Math.min(toResidentOffset(pieceTable, key, anchored), max)));
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

/**
 * True when a change in `entry` points strictly inside chunk `chunkIndex`,
 * whose resident span is [start, end).
 *
 * Positions inside a chunk carry the key `chunkIndex - 1`. After eviction the
 * chunk's bytes are gone, so such a position can no longer be resolved. The
 * chunk's boundaries are fine: they stay meaningful without its bytes.
 */
function entryPointsInsideChunk(
  pieceTable: PieceTableState,
  entry: HistoryEntry,
  chunkIndex: number,
  start: number,
  end: number,
): boolean {
  return entry.changes.some((change: HistoryChange) => {
    if (change.afterChunk !== chunkIndex - 1) return false;
    const offset = residentOffset(pieceTable, change);
    return offset > start && offset < end;
  });
}

/**
 * Index of the newest entry (stack order: oldest first) that points inside the
 * chunk, or -1. Entries at or below that index can only be replayed after it,
 * so dropping it means dropping all of them.
 */
function newestEntryInsideChunk(
  pieceTable: PieceTableState,
  entries: readonly HistoryEntry[],
  chunkIndex: number,
  start: number,
  end: number,
): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entryPointsInsideChunk(pieceTable, entries[i]!, chunkIndex, start, end)) return i;
  }
  return -1;
}

/**
 * Apply the history eviction policy before evicting `chunkIndex`.
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
  const undo = pstackToArray(history.undoStack);
  const redo = pstackToArray(history.redoStack);
  const undoCut = newestEntryInsideChunk(pieceTable, undo, chunkIndex, start, end);
  const redoCut = newestEntryInsideChunk(pieceTable, redo, chunkIndex, start, end);
  if (undoCut < 0 && redoCut < 0) return history;
  if (history.evictionPolicy === "pin") return null;
  return Object.freeze({
    ...history,
    undoStack: undoCut < 0 ? history.undoStack : pstackFromArray(undo.slice(undoCut + 1)),
    redoStack: redoCut < 0 ? history.redoStack : pstackFromArray(redo.slice(redoCut + 1)),
  });
}
