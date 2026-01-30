/**
 * History helper functions for the Reed document editor.
 * Provides utilities for checking undo/redo availability.
 */

import type { DocumentState, HistoryState } from '../types/state.ts';

/**
 * Check if undo is available.
 * @param state - Document state or history state
 * @returns true if there are entries in the undo stack
 */
export function canUndo(state: DocumentState | HistoryState): boolean {
  const history = 'history' in state ? state.history : state;
  return history.undoStack.length > 0;
}

/**
 * Check if redo is available.
 * @param state - Document state or history state
 * @returns true if there are entries in the redo stack
 */
export function canRedo(state: DocumentState | HistoryState): boolean {
  const history = 'history' in state ? state.history : state;
  return history.redoStack.length > 0;
}

/**
 * Get the number of available undo steps.
 * @param state - Document state or history state
 * @returns number of entries in the undo stack
 */
export function getUndoCount(state: DocumentState | HistoryState): number {
  const history = 'history' in state ? state.history : state;
  return history.undoStack.length;
}

/**
 * Get the number of available redo steps.
 * @param state - Document state or history state
 * @returns number of entries in the redo stack
 */
export function getRedoCount(state: DocumentState | HistoryState): number {
  const history = 'history' in state ? state.history : state;
  return history.redoStack.length;
}

/**
 * Check if history is empty (no undo or redo available).
 * @param state - Document state or history state
 * @returns true if both stacks are empty
 */
export function isHistoryEmpty(state: DocumentState | HistoryState): boolean {
  const history = 'history' in state ? state.history : state;
  return history.undoStack.length === 0 && history.redoStack.length === 0;
}
