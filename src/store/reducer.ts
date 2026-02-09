/**
 * Document reducer for the Reed document editor.
 * Pure reducer function for document state transitions.
 * No side effects - produces new state from old state + action.
 */

import type { DocumentState, HistoryEntry, HistoryChange, SelectionState, SelectionRange } from '../types/state.ts';
import type { DocumentAction } from '../types/actions.ts';
import type { ByteOffset } from '../types/branded.ts';
import type { LineIndexStrategy } from '../types/store.ts';
import { byteOffset } from '../types/branded.ts';
import { withState } from './state.ts';
import {
  pieceTableInsert as ptInsert,
  pieceTableDelete as ptDelete,
  getText,
} from './piece-table.ts';
import {
  lineIndexInsert as liInsert,
  lineIndexDelete as liDelete,
  lineIndexInsertLazy as liInsertLazy,
  lineIndexDeleteLazy as liDeleteLazy,
} from './line-index.ts';
import { textEncoder } from './encoding.ts';

// =============================================================================
// Position Validation
// =============================================================================

/**
 * Validate and clamp position to valid document range.
 * Returns clamped position within [0, totalLength].
 */
function validatePosition(position: number, totalLength: number): ByteOffset {
  if (!Number.isFinite(position)) {
    console.warn(`Invalid position: ${position}, defaulting to 0`);
    return byteOffset(0);
  }
  return byteOffset(Math.max(0, Math.min(position, totalLength)));
}

/**
 * Validate and clamp a range to valid document bounds.
 * Returns { start, end, valid } with both within [0, totalLength].
 * If start > end, marks as invalid (caller should treat as no-op).
 */
function validateRange(
  start: number,
  end: number,
  totalLength: number
): { start: ByteOffset; end: ByteOffset; valid: boolean } {
  // Inverted range is invalid (should be no-op)
  if (start > end) {
    return { start: byteOffset(start), end: byteOffset(end), valid: false };
  }

  const validStart = validatePosition(start, totalLength);
  const validEnd = validatePosition(end, totalLength);

  return { start: validStart, end: validEnd, valid: true };
}

// =============================================================================
// Piece Table Operations
// =============================================================================

/**
 * Insert text into piece table at position.
 * Returns new document state with updated piece table.
 */
function pieceTableInsert(
  state: DocumentState,
  position: ByteOffset,
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
  start: ByteOffset,
  end: ByteOffset
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
function getTextRange(state: DocumentState, start: ByteOffset, end: ByteOffset): string {
  return getText(state.pieceTable, start, end);
}

// =============================================================================
// Line Index Strategies (D3: Formalized Eager/Lazy Duality)
// =============================================================================

/**
 * Eager strategy: updates all line offsets immediately.
 * Used for undo/redo where we need immediate accuracy.
 */
export const eagerLineIndex: LineIndexStrategy = {
  insert: (state, position, text, _version) => {
    const newLineIndex = liInsert(state.lineIndex, position, text);
    return withState(state, { lineIndex: newLineIndex });
  },
  delete: (state, start, end, deletedText, _version) => {
    const newLineIndex = liDelete(state.lineIndex, start, end, deletedText);
    return withState(state, { lineIndex: newLineIndex });
  },
};

/**
 * Lazy strategy: defers offset recalculation to idle time.
 * Used for normal editing where throughput matters more than immediate accuracy.
 */
export const lazyLineIndex: LineIndexStrategy = {
  insert: (state, position, text, version) => {
    const newLineIndex = liInsertLazy(state.lineIndex, position, text, version);
    return withState(state, { lineIndex: newLineIndex });
  },
  delete: (state, start, end, deletedText, version) => {
    const newLineIndex = liDeleteLazy(state.lineIndex, start, end, deletedText, version);
    return withState(state, { lineIndex: newLineIndex });
  },
};

// =============================================================================
// History Operations
// =============================================================================

/**
 * Compute the expected cursor position after a change.
 * This is used to properly restore selection on redo.
 */
function computeSelectionAfterChange(
  state: DocumentState,
  change: HistoryChange
): SelectionState {
  let newPosition: number;

  switch (change.type) {
    case 'insert':
      // After insert, cursor should be at end of inserted text
      newPosition = change.position + change.byteLength;
      break;
    case 'delete':
      // After delete, cursor should be at the deletion point
      newPosition = change.position;
      break;
    case 'replace':
      // After replace, cursor should be at end of inserted text
      newPosition = change.position + change.byteLength;
      break;
    default:
      return state.selection;
  }

  return Object.freeze({
    ranges: Object.freeze([Object.freeze({ anchor: byteOffset(newPosition), head: byteOffset(newPosition) })]),
    primaryIndex: 0,
  });
}

/**
 * Push a change to the history stack.
 */
function historyPush(
  state: DocumentState,
  change: HistoryChange
): DocumentState {
  const history = state.history;

  // Compute expected selection after the change for proper redo
  const selectionAfter = computeSelectionAfterChange(state, change);

  const entry: HistoryEntry = Object.freeze({
    changes: Object.freeze([change]),
    selectionBefore: state.selection,
    selectionAfter,
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
 * Uses eager line index strategy for immediate accuracy.
 */
function historyUndo(state: DocumentState, version: number): DocumentState {
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

  // Apply inverse of each change (in reverse order) with eager line index updates
  for (let i = entry.changes.length - 1; i >= 0; i--) {
    const change = entry.changes[i];
    newState = applyInverseChange(newState, change, version);
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
 */
function historyRedo(state: DocumentState, version: number): DocumentState {
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

  // Apply each change with eager line index updates
  for (const change of entry.changes) {
    newState = applyChange(newState, change, version);
  }

  // Restore selection
  newState = withState(newState, {
    selection: entry.selectionAfter,
  });

  return newState;
}

/**
 * Apply a single change (for redo).
 * Uses eager line index strategy for immediate accuracy after redo.
 */
function applyChange(state: DocumentState, change: HistoryChange, version: number): DocumentState {
  switch (change.type) {
    case 'insert': {
      let s = pieceTableInsert(state, change.position, change.text);
      return eagerLineIndex.insert(s, change.position, change.text, version);
    }
    case 'delete': {
      const end = byteOffset(change.position + change.byteLength);
      let s = pieceTableDelete(state, change.position, end);
      return eagerLineIndex.delete(s, change.position, end, change.text, version);
    }
    case 'replace': {
      const deleteEnd = byteOffset(change.position + (change.oldTextByteLength ?? 0));
      let s = pieceTableDelete(state, change.position, deleteEnd);
      s = pieceTableInsert(s, change.position, change.text);
      s = eagerLineIndex.delete(s, change.position, deleteEnd, change.oldText ?? '', version);
      return eagerLineIndex.insert(s, change.position, change.text, version);
    }
    default:
      return state;
  }
}

/**
 * Apply inverse of a change (for undo).
 * Uses eager line index strategy for immediate accuracy after undo.
 */
function applyInverseChange(state: DocumentState, change: HistoryChange, version: number): DocumentState {
  switch (change.type) {
    case 'insert': {
      // Inverse of insert is delete
      const end = byteOffset(change.position + change.byteLength);
      let s = pieceTableDelete(state, change.position, end);
      return eagerLineIndex.delete(s, change.position, end, change.text, version);
    }
    case 'delete': {
      // Inverse of delete is insert
      let s = pieceTableInsert(state, change.position, change.text);
      return eagerLineIndex.insert(s, change.position, change.text, version);
    }
    case 'replace': {
      // Inverse of replace: delete new text, insert old text
      const deleteEnd = byteOffset(change.position + change.byteLength);
      let s = pieceTableDelete(state, change.position, deleteEnd);
      s = pieceTableInsert(s, change.position, change.oldText ?? '');
      s = eagerLineIndex.delete(s, change.position, deleteEnd, change.text, version);
      return eagerLineIndex.insert(s, change.position, change.oldText ?? '', version);
    }
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
  ranges: readonly SelectionRange[]
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
      // Validate position
      const position = validatePosition(action.start, state.pieceTable.totalLength);

      // Skip empty inserts
      if (action.text.length === 0) return state;

      const nextVersion = state.version + 1;

      // Insert text and update line index (lazy: defers offset recalculation)
      let newState = pieceTableInsert(state, position, action.text);
      newState = lazyLineIndex.insert(newState, position, action.text, nextVersion);

      // Push to history
      newState = historyPush(newState, {
        type: 'insert',
        position,
        text: action.text,
        byteLength: textEncoder.encode(action.text).length,
      });

      // Mark as dirty and increment version
      return withState(newState, {
        version: nextVersion,
        metadata: Object.freeze({
          ...state.metadata,
          isDirty: true,
        }),
      });
    }

    case 'DELETE': {
      // Validate range
      const { start, end, valid } = validateRange(action.start, action.end, state.pieceTable.totalLength);
      if (!valid) return state;

      const deletedLength = end - start;
      if (deletedLength <= 0) return state;

      const nextVersion = state.version + 1;

      // Capture deleted text for undo BEFORE deleting
      const deletedText = getTextRange(state, start, end);

      // Delete from piece table and update line index (lazy: defers offset recalculation)
      let newState = pieceTableDelete(state, start, end);
      newState = lazyLineIndex.delete(newState, start, end, deletedText, nextVersion);

      // Push to history with actual deleted text
      newState = historyPush(newState, {
        type: 'delete',
        position: start,
        text: deletedText,
        byteLength: end - start,
      });

      // Mark as dirty and increment version
      return withState(newState, {
        version: nextVersion,
        metadata: Object.freeze({
          ...state.metadata,
          isDirty: true,
        }),
      });
    }

    case 'REPLACE': {
      // Validate range
      const { start, end, valid } = validateRange(action.start, action.end, state.pieceTable.totalLength);
      if (!valid) return state;

      const nextVersion = state.version + 1;

      // Capture old text for undo BEFORE replacing
      const oldText = getTextRange(state, start, end);

      // Replace is delete + insert (lazy: defers offset recalculation)
      let newState = pieceTableDelete(state, start, end);
      newState = pieceTableInsert(newState, start, action.text);
      newState = lazyLineIndex.delete(newState, start, end, oldText, nextVersion);
      newState = lazyLineIndex.insert(newState, start, action.text, nextVersion);

      // Push to history with actual old text
      newState = historyPush(newState, {
        type: 'replace',
        position: start,
        text: action.text,
        byteLength: textEncoder.encode(action.text).length,
        oldText,
        oldTextByteLength: end - start,
      });

      // Mark as dirty and increment version
      return withState(newState, {
        version: nextVersion,
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
      const nextVersion = state.version + 1;
      const newState = historyUndo(state, nextVersion);
      if (newState === state) return state; // No undo available
      return withState(newState, {
        version: nextVersion,
      });
    }

    case 'REDO': {
      const nextVersion = state.version + 1;
      const newState = historyRedo(state, nextVersion);
      if (newState === state) return state; // No redo available
      return withState(newState, {
        version: nextVersion,
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
      const nextVersion = state.version + 1;
      let newState = state;
      for (const change of action.changes) {
        if (change.type === 'insert' && change.text) {
          newState = pieceTableInsert(newState, change.start, change.text);
          newState = lazyLineIndex.insert(newState, change.start, change.text, nextVersion);
        } else if (change.type === 'delete' && change.length) {
          // Capture deleted text before deleting for line index update
          const endPosition = byteOffset(change.start + change.length);
          const deletedText = getTextRange(newState, change.start, endPosition);
          newState = pieceTableDelete(newState, change.start, endPosition);
          newState = lazyLineIndex.delete(newState, change.start, endPosition, deletedText, nextVersion);
        }
      }
      // Remote changes don't push to history (they come from network)
      return withState(newState, {
        version: nextVersion,
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
