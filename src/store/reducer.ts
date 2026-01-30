/**
 * Document reducer for the Reed document editor.
 * Pure reducer function for document state transitions.
 * No side effects - produces new state from old state + action.
 */

import type { DocumentState, HistoryEntry, HistoryChange } from '../types/state.ts';
import type { DocumentAction } from '../types/actions.ts';
import { withState } from './state.ts';
import {
  pieceTableInsert as ptInsert,
  pieceTableDelete as ptDelete,
  getText,
} from './piece-table.ts';
import {
  lineIndexInsert as liInsert,
  lineIndexDelete as liDelete,
} from './line-index.ts';

// =============================================================================
// Piece Table Operations
// =============================================================================

/**
 * Insert text into piece table at position.
 * Returns new document state with updated piece table.
 */
function pieceTableInsert(
  state: DocumentState,
  position: number,
  text: string
): DocumentState {
  const newPieceTable = ptInsert(state.pieceTable, position, text);
  return withState(state, {
    pieceTable: newPieceTable,
  });
}

/**
 * Delete text from piece table in range [start, end).
 * Returns new document state with updated piece table.
 */
function pieceTableDelete(
  state: DocumentState,
  start: number,
  end: number
): DocumentState {
  const newPieceTable = ptDelete(state.pieceTable, start, end);
  return withState(state, {
    pieceTable: newPieceTable,
  });
}

/**
 * Get text in a range from the piece table.
 * Used for capturing deleted text for undo.
 */
function getTextRange(state: DocumentState, start: number, end: number): string {
  return getText(state.pieceTable, start, end);
}

// =============================================================================
// Line Index Operations
// =============================================================================

/**
 * Update line index after text insertion.
 */
function lineIndexUpdate(
  state: DocumentState,
  position: number,
  text: string
): DocumentState {
  const newLineIndex = liInsert(state.lineIndex, position, text);
  return withState(state, {
    lineIndex: newLineIndex,
  });
}

/**
 * Update line index after text deletion.
 */
function lineIndexRemove(
  state: DocumentState,
  start: number,
  end: number,
  deletedText: string
): DocumentState {
  const newLineIndex = liDelete(state.lineIndex, start, end, deletedText);
  return withState(state, {
    lineIndex: newLineIndex,
  });
}

// =============================================================================
// History Operations
// =============================================================================

/**
 * Push a change to the history stack.
 */
function historyPush(
  state: DocumentState,
  change: HistoryChange
): DocumentState {
  const history = state.history;

  const entry: HistoryEntry = Object.freeze({
    changes: Object.freeze([change]),
    selectionBefore: state.selection,
    selectionAfter: state.selection, // Updated after action completes
    timestamp: Date.now(),
  });

  // Trim undo stack if it exceeds limit
  let undoStack = [...history.undoStack, entry];
  if (undoStack.length > history.limit) {
    undoStack = undoStack.slice(undoStack.length - history.limit);
  }

  return withState(state, {
    history: Object.freeze({
      ...history,
      undoStack: Object.freeze(undoStack),
      redoStack: Object.freeze([]), // Clear redo stack on new change
    }),
  });
}

/**
 * Perform undo operation.
 */
function historyUndo(state: DocumentState): DocumentState {
  const history = state.history;
  if (history.undoStack.length === 0) return state;

  const entry = history.undoStack[history.undoStack.length - 1];
  const newUndoStack = history.undoStack.slice(0, -1);
  const newRedoStack = [...history.redoStack, entry];

  // Apply inverse changes
  let newState = withState(state, {
    history: Object.freeze({
      ...history,
      undoStack: Object.freeze(newUndoStack),
      redoStack: Object.freeze(newRedoStack),
    }),
  });

  // Apply inverse of each change (in reverse order)
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
 */
function historyRedo(state: DocumentState): DocumentState {
  const history = state.history;
  if (history.redoStack.length === 0) return state;

  const entry = history.redoStack[history.redoStack.length - 1];
  const newRedoStack = history.redoStack.slice(0, -1);
  const newUndoStack = [...history.undoStack, entry];

  // Apply changes
  let newState = withState(state, {
    history: Object.freeze({
      ...history,
      undoStack: Object.freeze(newUndoStack),
      redoStack: Object.freeze(newRedoStack),
    }),
  });

  // Apply each change
  for (const change of entry.changes) {
    newState = applyChange(newState, change);
  }

  // Restore selection
  newState = withState(newState, {
    selection: entry.selectionAfter,
  });

  return newState;
}

/**
 * Apply a single change (for redo).
 */
function applyChange(state: DocumentState, change: HistoryChange): DocumentState {
  switch (change.type) {
    case 'insert':
      return pieceTableInsert(state, change.position, change.text);
    case 'delete':
      return pieceTableDelete(state, change.position, change.position + change.text.length);
    case 'replace':
      const deleted = pieceTableDelete(state, change.position, change.position + (change.oldText?.length ?? 0));
      return pieceTableInsert(deleted, change.position, change.text);
    default:
      return state;
  }
}

/**
 * Apply inverse of a change (for undo).
 */
function applyInverseChange(state: DocumentState, change: HistoryChange): DocumentState {
  switch (change.type) {
    case 'insert':
      // Inverse of insert is delete
      return pieceTableDelete(state, change.position, change.position + change.text.length);
    case 'delete':
      // Inverse of delete is insert
      return pieceTableInsert(state, change.position, change.text);
    case 'replace':
      // Inverse of replace is replace with old text
      const deleted = pieceTableDelete(state, change.position, change.position + change.text.length);
      return pieceTableInsert(deleted, change.position, change.oldText ?? '');
    default:
      return state;
  }
}

// =============================================================================
// Selection Operations
// =============================================================================

/**
 * Update selection state.
 */
function setSelection(
  state: DocumentState,
  ranges: readonly { anchor: number; head: number }[]
): DocumentState {
  return withState(state, {
    selection: Object.freeze({
      ranges: Object.freeze(ranges.map(r => Object.freeze({ ...r }))),
      primaryIndex: 0,
    }),
  });
}

// =============================================================================
// Main Reducer
// =============================================================================

/**
 * Core reducer implementation with structural sharing.
 * Handles all document actions and returns new immutable state.
 */
export function documentReducer(
  state: DocumentState,
  action: DocumentAction
): DocumentState {
  switch (action.type) {
    case 'INSERT': {
      // Insert text and update line index
      let newState = pieceTableInsert(state, action.position, action.text);
      newState = lineIndexUpdate(newState, action.position, action.text);

      // Push to history
      newState = historyPush(newState, {
        type: 'insert',
        position: action.position,
        text: action.text,
      });

      // Mark as dirty and increment version
      return withState(newState, {
        version: state.version + 1,
        metadata: Object.freeze({
          ...state.metadata,
          isDirty: true,
        }),
      });
    }

    case 'DELETE': {
      const deletedLength = action.end - action.start;
      if (deletedLength <= 0) return state;

      // Capture deleted text for undo BEFORE deleting
      const deletedText = getTextRange(state, action.start, action.end);

      // Delete from piece table and update line index
      let newState = pieceTableDelete(state, action.start, action.end);
      newState = lineIndexRemove(newState, action.start, action.end, deletedText);

      // Push to history with actual deleted text
      newState = historyPush(newState, {
        type: 'delete',
        position: action.start,
        text: deletedText,
      });

      // Mark as dirty and increment version
      return withState(newState, {
        version: state.version + 1,
        metadata: Object.freeze({
          ...state.metadata,
          isDirty: true,
        }),
      });
    }

    case 'REPLACE': {
      // Capture old text for undo BEFORE replacing
      const oldText = getTextRange(state, action.start, action.end);

      // Replace is delete + insert
      let newState = pieceTableDelete(state, action.start, action.end);
      newState = pieceTableInsert(newState, action.start, action.text);
      newState = lineIndexRemove(newState, action.start, action.end, oldText);
      newState = lineIndexUpdate(newState, action.start, action.text);

      // Push to history with actual old text
      newState = historyPush(newState, {
        type: 'replace',
        position: action.start,
        text: action.text,
        oldText,
      });

      // Mark as dirty and increment version
      return withState(newState, {
        version: state.version + 1,
        metadata: Object.freeze({
          ...state.metadata,
          isDirty: true,
        }),
      });
    }

    case 'SET_SELECTION': {
      return withState(setSelection(state, action.ranges), {
        version: state.version + 1,
      });
    }

    case 'UNDO': {
      const newState = historyUndo(state);
      if (newState === state) return state; // No undo available
      return withState(newState, {
        version: state.version + 1,
      });
    }

    case 'REDO': {
      const newState = historyRedo(state);
      if (newState === state) return state; // No redo available
      return withState(newState, {
        version: state.version + 1,
      });
    }

    case 'HISTORY_CLEAR': {
      // Clear both undo and redo stacks while preserving the limit
      return withState(state, {
        history: Object.freeze({
          undoStack: Object.freeze([]),
          redoStack: Object.freeze([]),
          limit: state.history.limit,
        }),
        version: state.version + 1,
      });
    }

    case 'TRANSACTION_START':
    case 'TRANSACTION_COMMIT':
    case 'TRANSACTION_ROLLBACK':
      // Transaction handling is done in the store, not the reducer
      return state;

    case 'APPLY_REMOTE': {
      // Apply remote changes from collaboration
      let newState = state;
      for (const change of action.changes) {
        if (change.type === 'insert' && change.text) {
          newState = pieceTableInsert(newState, change.position, change.text);
          newState = lineIndexUpdate(newState, change.position, change.text);
        } else if (change.type === 'delete' && change.length) {
          // Capture deleted text before deleting for line index update
          const deletedText = getTextRange(newState, change.position, change.position + change.length);
          newState = pieceTableDelete(newState, change.position, change.position + change.length);
          newState = lineIndexRemove(newState, change.position, change.position + change.length, deletedText);
        }
      }
      // Remote changes don't push to history (they come from network)
      return withState(newState, {
        version: state.version + 1,
      });
    }

    case 'LOAD_CHUNK': {
      // Phase 3 will implement chunk loading
      return state;
    }

    case 'EVICT_CHUNK': {
      // Phase 3 will implement chunk eviction
      return state;
    }

    default: {
      // Exhaustive check - TypeScript will error if we miss an action type
      const exhaustiveCheck: never = action;
      return exhaustiveCheck;
    }
  }
}
