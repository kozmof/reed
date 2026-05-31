/**
 * History helper functions for the Reed document editor.
 * Provides utilities for checking undo/redo availability, and the
 * historyUndo / historyRedo operations that apply stored changes.
 */

import type {
  DocumentState,
  HistoryState,
  LineIndexState,
} from "../../types/state.ts";
import { pstackSize, pstackPush, pstackPop } from "../../types/state.ts";
import { withState } from "../core/state.ts";
import { reconcileFull } from "../core/line-index.ts";
import { applyChange, applyInverseChange } from "./edit.ts";

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
// Line-Index Reconciliation for History Operations
// =============================================================================

/**
 * Reconcile the line index to a fully eager state before replaying history changes.
 * `applyChange` / `applyInverseChange` both call `asEagerLineIndex`, which throws
 * unless every dirty range has been resolved. A partial `reconcileRange` is not
 * sufficient — it would leave dirty ranges outside the changed window, causing the
 * second undo/redo in a sequence to throw on the `asEagerLineIndex` assertion.
 */
export function reconcileRangeForChanges(
  lineIndex: LineIndexState,
  version: number,
): LineIndexState<"eager"> {
  if (!lineIndex.rebuildPending) return lineIndex as LineIndexState<"eager">;
  return reconcileFull(lineIndex, version);
}

// =============================================================================
// Undo / Redo Operations
// =============================================================================

/**
 * Perform undo operation.
 * Uses eager line index strategy for immediate accuracy.
 *
 * @param state - Current document state
 * @param version - Next version number (caller is responsible for incrementing)
 * @returns New state with undo applied, or the same state if no undo is available
 */
export function historyUndo(state: DocumentState, version: number): DocumentState {
  const history = state.history;
  if (history.undoStack === null) return state;

  const [entry, newUndoStack] = pstackPop(history.undoStack);
  const newRedoStack = pstackPush(history.redoStack, entry);

  // Apply inverse changes
  let newState = withState(state, {
    history: Object.freeze({
      ...history,
      undoStack: newUndoStack,
      redoStack: newRedoStack,
    }),
  });

  const reconciledLI = reconcileRangeForChanges(newState.lineIndex, version);
  if (reconciledLI !== newState.lineIndex) {
    newState = withState(newState, { lineIndex: reconciledLI });
  }

  // Apply inverse of each change (in reverse order) with eager line index updates
  for (let i = entry.changes.length - 1; i >= 0; i--) {
    const change = entry.changes[i];
    newState = applyInverseChange(newState, change);
  }

  // Restore selection
  newState = withState(newState, {
    selection: entry.selectionBefore,
  });

  return newState;
}

/**
 * Perform redo operation.
 * Uses eager line index strategy for immediate accuracy.
 *
 * @param state - Current document state
 * @param version - Next version number (caller is responsible for incrementing)
 * @returns New state with redo applied, or the same state if no redo is available
 */
export function historyRedo(state: DocumentState, version: number): DocumentState {
  const history = state.history;
  if (history.redoStack === null) return state;

  const [entry, newRedoStack] = pstackPop(history.redoStack);
  const newUndoStack = pstackPush(history.undoStack, entry);

  // Apply changes
  let newState = withState(state, {
    history: Object.freeze({
      ...history,
      undoStack: newUndoStack,
      redoStack: newRedoStack,
    }),
  });

  const reconciledLI = reconcileRangeForChanges(newState.lineIndex, version);
  if (reconciledLI !== newState.lineIndex) {
    newState = withState(newState, { lineIndex: reconciledLI });
  }

  // Apply each change with eager line index updates
  for (const change of entry.changes) {
    newState = applyChange(newState, change);
  }

  // Restore selection
  newState = withState(newState, {
    selection: entry.selectionAfter,
  });

  return newState;
}
