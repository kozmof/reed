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
 * What an undo or redo step did. `"empty"` means there was nothing to undo or
 * redo and `state` is the input. `"applied"` means the top entry replayed.
 * `"dropped"` means it no longer replayed and was discarded together with the
 * entries that depend on it, so only history changed.
 */
export interface HistoryStepResult {
  readonly outcome: "empty" | "applied" | "dropped";
  readonly state: DocumentState;
}

/** States that an undo or redo step produced by dropping a stale entry. */
const droppedStepStates = new WeakSet<DocumentState>();

/** A `"dropped"` step result, its state marked for {@link isDroppedHistoryStep}. */
function droppedStep(state: DocumentState): HistoryStepResult {
  droppedStepStates.add(state);
  return { outcome: "dropped", state };
}

/**
 * True when `state` is the state an UNDO or REDO returned after dropping a
 * stale entry instead of replaying it. The event layer uses this to emit
 * `history-drop` rather than `history-change`: the document is unchanged
 * either way when an entry changes no bytes, so the step's outcome is the only
 * reliable signal.
 */
export function isDroppedHistoryStep(state: DocumentState): boolean {
  return droppedStepStates.has(state);
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
 * @returns The step's outcome and resulting state
 */
export function historyUndo(state: DocumentState, _revision: number): HistoryStepResult {
  const history = state.history;
  if (history.undoStack === null) return { outcome: "empty", state };

  const [entry, newUndoStack] = pstackPop(history.undoStack);

  // Apply inverse of each change (in reverse order) with lazy line index updates
  const replayed = replayEntry(state, entry, applyInverseChange, true);
  if (replayed === null) {
    return droppedStep(
      withState(state, { history: Object.freeze({ ...history, undoStack: null }) }),
    );
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

  return { outcome: "applied", state: newState };
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
 * @returns The step's outcome and resulting state
 */
export function historyRedo(state: DocumentState, _revision: number): HistoryStepResult {
  const history = state.history;
  if (history.redoStack === null) return { outcome: "empty", state };

  const [entry, newRedoStack] = pstackPop(history.redoStack);

  // Apply each change with lazy line index updates
  const replayed = replayEntry(state, entry, applyChange, false);
  if (replayed === null) {
    return droppedStep(
      withState(state, { history: Object.freeze({ ...history, redoStack: null }) }),
    );
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

  return { outcome: "applied", state: newState };
}
