/**
 * History helper functions for the Reed document editor.
 * Provides utilities for checking undo/redo availability, and the
 * historyUndo / historyRedo operations that apply stored changes.
 */

import type {
  DocumentState,
  HistoryChange,
  HistoryEntry,
  HistoryState,
} from "../../types/state.js";
import { pstackSize, pstackPush, pstackPop } from "../../types/state.js";
import { withState } from "../core/state.js";
import { applyChange, applyInverseChange, StaleHistoryChangeError } from "./edit.js";
import { keepSameSelection, resolveSelection } from "./history-anchor.js";

/**
 * Check if undo is available.
 * @param state - Document state or history state
 * @returns true if there are entries in the undo stack
 */
export function canUndo(state: DocumentState | HistoryState): boolean {
  const history = "history" in state ? state.history : state;
  return history.undoStack !== null;
}

/**
 * Check if redo is available.
 * @param state - Document state or history state
 * @returns true if there are entries in the redo stack
 */
export function canRedo(state: DocumentState | HistoryState): boolean {
  const history = "history" in state ? state.history : state;
  return history.redoStack !== null;
}

/**
 * Get the number of available undo steps.
 * @param state - Document state or history state
 * @returns number of entries in the undo stack
 */
export function getUndoCount(state: DocumentState | HistoryState): number {
  const history = "history" in state ? state.history : state;
  return pstackSize(history.undoStack);
}

/**
 * Get the number of available redo steps.
 * @param state - Document state or history state
 * @returns number of entries in the redo stack
 */
export function getRedoCount(state: DocumentState | HistoryState): number {
  const history = "history" in state ? state.history : state;
  return pstackSize(history.redoStack);
}

/**
 * Check if history is empty (no undo or redo available).
 * @param state - Document state or history state
 * @returns true if both stacks are empty
 */
export function isHistoryEmpty(state: DocumentState | HistoryState): boolean {
  const history = "history" in state ? state.history : state;
  return history.undoStack === null && history.redoStack === null;
}

// =============================================================================
// Undo / Redo Operations
// =============================================================================

/**
 * Apply an entry's changes, or return null when one of them no longer resolves
 * inside the document. Valid history always replays; a stale entry can only
 * come from a gap in the eviction guards or a hand-built state.
 */
function replayEntry(
  state: DocumentState,
  entry: HistoryEntry,
  apply: (state: DocumentState, change: HistoryChange) => DocumentState,
  reverse: boolean,
): DocumentState | null {
  const { changes } = entry;
  let next = state;
  try {
    for (let n = 0; n < changes.length; n++) {
      next = apply(next, changes[reverse ? changes.length - 1 - n : n]!);
    }
  } catch (error) {
    if (error instanceof StaleHistoryChangeError) return null;
    throw error;
  }
  return next;
}

/**
 * True when an undo (or redo) step from `prev` to `next` dropped a stale entry
 * instead of replaying it. A replayed step always pushes the entry onto the
 * other stack, while a dropped step keeps that stack as it was. This holds even
 * for an entry whose replay changes no bytes, which leaves the piece table
 * untouched. A step with nothing to undo or redo returns `prev` itself and is
 * not a drop.
 */
export function historyStepDropped(
  prev: DocumentState,
  next: DocumentState,
  direction: "undo" | "redo",
): boolean {
  if (prev.history === next.history) return false;
  return direction === "undo"
    ? prev.history.redoStack === next.history.redoStack
    : prev.history.undoStack === next.history.undoStack;
}

/**
 * Perform undo operation.
 * Keeps aggregate-based queries accurate and defers cached offset repair.
 *
 * When the top entry no longer replays, it is dropped together with every
 * older undo entry, since each of those applies to the document the dropped
 * one would have left. The document is unchanged and the redo stack is kept.
 *
 * @param state - Current document state
 * @param revision - Next revision number (caller is responsible for incrementing)
 * @returns New state with undo applied, or the same state if no undo is available
 */
export function historyUndo(state: DocumentState, _revision: number): DocumentState {
  const history = state.history;
  if (history.undoStack === null) return state;

  const [entry, newUndoStack] = pstackPop(history.undoStack);

  // Apply inverse of each change (in reverse order) with lazy line index updates
  const replayed = replayEntry(state, entry, applyInverseChange, true);
  if (replayed === null) {
    return withState(state, { history: Object.freeze({ ...history, undoStack: null }) });
  }

  let newState = withState(replayed, {
    history: Object.freeze({
      ...history,
      undoStack: newUndoStack,
      redoStack: pstackPush(history.redoStack, entry),
    }),
  });

  // Restore selection
  newState = withState(newState, {
    selection: keepSameSelection(
      state.selection,
      resolveSelection(newState.pieceTable, entry.selectionBefore),
    ),
    metadata: Object.freeze({ ...newState.metadata, isDirty: true }),
  });

  return newState;
}

/**
 * Perform redo operation.
 * Keeps aggregate-based queries accurate and defers cached offset repair.
 *
 * When the top entry no longer replays, it is dropped together with the rest
 * of the redo stack, which applies on top of it. The document is unchanged and
 * the undo stack is kept.
 *
 * @param state - Current document state
 * @param revision - Next revision number (caller is responsible for incrementing)
 * @returns New state with redo applied, or the same state if no redo is available
 */
export function historyRedo(state: DocumentState, _revision: number): DocumentState {
  const history = state.history;
  if (history.redoStack === null) return state;

  const [entry, newRedoStack] = pstackPop(history.redoStack);

  // Apply each change with lazy line index updates
  const replayed = replayEntry(state, entry, applyChange, false);
  if (replayed === null) {
    return withState(state, { history: Object.freeze({ ...history, redoStack: null }) });
  }

  let newState = withState(replayed, {
    history: Object.freeze({
      ...history,
      undoStack: pstackPush(history.undoStack, entry),
      redoStack: newRedoStack,
    }),
  });

  // Restore selection
  newState = withState(newState, {
    selection: keepSameSelection(
      state.selection,
      resolveSelection(newState.pieceTable, entry.selectionAfter),
    ),
    metadata: Object.freeze({ ...newState.metadata, isDirty: true }),
  });

  return newState;
}
