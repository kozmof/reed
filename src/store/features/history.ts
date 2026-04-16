/**
 * History helper functions for the Reed document editor.
 * Provides utilities for checking undo/redo availability, and the
 * historyUndo / historyRedo operations that apply stored changes.
 */

import type { DocumentState, HistoryState } from '../../types/state.ts';
import { pstackSize, pstackPush, pstackPop } from '../../types/state.ts';
import { withState } from '../core/state.ts';
import {
  applyChange,
  applyInverseChange,
  reconcileRangeForChanges,
} from './edit.ts';

/**
 * Check if undo is available.
 * @param state - Document state or history state
 * @returns true if there are entries in the undo stack
 */
export function canUndo(state: DocumentState | HistoryState): boolean {
  const history = 'history' in state ? state.history : state;
  return history.undoStack !== null;
}

/**
 * Check if redo is available.
 * @param state - Document state or history state
 * @returns true if there are entries in the redo stack
 */
export function canRedo(state: DocumentState | HistoryState): boolean {
  const history = 'history' in state ? state.history : state;
  return history.redoStack !== null;
}

/**
 * Get the number of available undo steps.
 * @param state - Document state or history state
 * @returns number of entries in the undo stack
 */
export function getUndoCount(state: DocumentState | HistoryState): number {
  const history = 'history' in state ? state.history : state;
  return pstackSize(history.undoStack);
}

/**
 * Get the number of available redo steps.
 * @param state - Document state or history state
 * @returns number of entries in the redo stack
 */
export function getRedoCount(state: DocumentState | HistoryState): number {
  const history = 'history' in state ? state.history : state;
  return pstackSize(history.redoStack);
}

/**
 * Check if history is empty (no undo or redo available).
 * @param state - Document state or history state
 * @returns true if both stacks are empty
 */
export function isHistoryEmpty(state: DocumentState | HistoryState): boolean {
  const history = 'history' in state ? state.history : state;
  return history.undoStack === null && history.redoStack === null;
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

  // Incremental reconciliation: resolve only the line range covering the changes
  // being undone (O(k) rather than O(n) full rebuild). Byte offsets from the
  // history changes are mapped to line numbers via the tree's subtreeByteLength,
  // which is accurate even in lazy mode.
  const reconciledLI = reconcileRangeForChanges(newState.lineIndex, entry.changes, version);
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

  // Incremental reconciliation: resolve only the line range covering the changes
  // being redone (O(k) rather than O(n) full rebuild).
  const reconciledLI = reconcileRangeForChanges(newState.lineIndex, entry.changes, version);
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
