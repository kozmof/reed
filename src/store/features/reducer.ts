/**
 * Document reducer for the Reed document editor.
 * Pure reducer function for document state transitions.
 * No side effects - produces new state from old state + action.
 */

import type { DocumentState, HistoryEntry, HistoryChange, SelectionState, SelectionRange } from '../../types/state.ts';
import type { DocumentAction } from '../../types/actions.ts';
import type { ByteOffset } from '../../types/branded.ts';
import type { LineIndexStrategy } from '../../types/store.ts';
import { byteOffset } from '../../types/branded.ts';
import { withState } from '../core/state.ts';
import {
  pieceTableInsert as ptInsert,
  pieceTableDelete as ptDelete,
  getText,
} from '../core/piece-table.ts';
import {
  lineIndexInsert as liInsert,
  lineIndexDelete as liDelete,
  lineIndexInsertLazy as liInsertLazy,
  lineIndexDeleteLazy as liDeleteLazy,
} from '../core/line-index.ts';
import { textEncoder } from '../core/encoding.ts';

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
 * Returns new document state with updated piece table and inserted byte length.
 */
function pieceTableInsert(
  state: DocumentState,
  position: ByteOffset,
  text: string
): { state: DocumentState; insertedByteLength: number } {
  const result = ptInsert(state.pieceTable, position, text);
  return {
    state: withState(state, { pieceTable: result.state }),
    insertedByteLength: result.insertedByteLength,
  };
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
// Line Index Strategies (Formalized Eager/Lazy Duality)
// =============================================================================

/**
 * Eager strategy: updates all line offsets immediately.
 * Used for undo/redo where we need immediate accuracy.
 */
export const eagerLineIndex: LineIndexStrategy = {
  insert: (lineIndex, position, text, _version, readText) => {
    return liInsert(lineIndex, position, text, readText);
  },
  delete: (lineIndex, start, end, deletedText, _version) => {
    return liDelete(lineIndex, start, end, deletedText);
  },
};

/**
 * Lazy strategy: defers offset recalculation to idle time.
 * Used for normal editing where throughput matters more than immediate accuracy.
 */
export const lazyLineIndex: LineIndexStrategy = {
  insert: (lineIndex, position, text, version, readText) => {
    return liInsertLazy(lineIndex, position, text, version, readText);
  },
  delete: (lineIndex, start, end, deletedText, version) => {
    return liDeleteLazy(lineIndex, start, end, deletedText, version);
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
 * Check if a new change can be coalesced with the last history entry.
 * Coalescing merges consecutive same-type changes within a timeout window
 * into a single undo entry (e.g., typing a word becomes one undo step).
 */
function canCoalesce(
  lastEntry: HistoryEntry,
  newChange: HistoryChange,
  timeout: number,
  now: number
): boolean {
  if (timeout <= 0) return false;
  if (now - lastEntry.timestamp > timeout) return false;
  if (lastEntry.changes.length !== 1) return false;

  const last = lastEntry.changes[0];
  if (last.type !== newChange.type) return false;

  switch (newChange.type) {
    case 'insert':
      // Contiguous typing: new insert starts where last insert ended
      return newChange.position === last.position + last.byteLength;
    case 'delete': {
      // Backspace: new delete ends where last delete starts
      if (newChange.position + newChange.byteLength === last.position) return true;
      // Forward delete: same position as last delete
      if (newChange.position === last.position) return true;
      return false;
    }
    default:
      return false;
  }
}

/**
 * Merge two changes into a single coalesced change.
 * Assumes canCoalesce() returned true for these changes.
 */
function coalesceChanges(
  existing: HistoryChange,
  incoming: HistoryChange
): HistoryChange {
  switch (incoming.type) {
    case 'insert':
      // Append: concatenate text, sum byte lengths, keep earlier position
      return Object.freeze({
        type: 'insert',
        position: existing.position,
        text: existing.text + incoming.text,
        byteLength: existing.byteLength + incoming.byteLength,
      });
    case 'delete': {
      if (incoming.position + incoming.byteLength === existing.position) {
        // Backspace: prepend text, use earlier position
        return Object.freeze({
          type: 'delete',
          position: incoming.position,
          text: incoming.text + existing.text,
          byteLength: existing.byteLength + incoming.byteLength,
        });
      }
      // Forward delete: append text, keep position
      return Object.freeze({
        type: 'delete',
        position: existing.position,
        text: existing.text + incoming.text,
        byteLength: existing.byteLength + incoming.byteLength,
      });
    }
    default:
      return incoming;
  }
}

/**
 * Push a change to the history stack.
 * May coalesce with the previous entry if within the coalesce timeout.
 */
function historyPush(
  state: DocumentState,
  change: HistoryChange,
  now: number
): DocumentState {
  const history = state.history;

  // Compute expected selection after the change for proper redo
  const selectionAfter = computeSelectionAfterChange(state, change);

  // Try to coalesce with the last entry
  const lastEntry = history.undoStack[history.undoStack.length - 1];
  if (lastEntry && canCoalesce(lastEntry, change, history.coalesceTimeout, now)) {
    const merged = coalesceChanges(lastEntry.changes[0], change);
    const mergedEntry: HistoryEntry = Object.freeze({
      changes: Object.freeze([merged]),
      selectionBefore: lastEntry.selectionBefore,
      selectionAfter,
      timestamp: now,
    });
    const undoStack = [...history.undoStack.slice(0, -1), mergedEntry];
    return withState(state, {
      history: Object.freeze({
        ...history,
        undoStack: Object.freeze(undoStack),
        redoStack: Object.freeze([]),
      }),
    });
  }

  const entry: HistoryEntry = Object.freeze({
    changes: Object.freeze([change]),
    selectionBefore: state.selection,
    selectionAfter,
    timestamp: now,
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
 * Invert a history change.
 * insert ↔ delete, replace swaps text/oldText.
 * This formalizes the duality between applyChange and applyInverseChange.
 */
function invertChange(change: HistoryChange): HistoryChange {
  switch (change.type) {
    case 'insert':
      return Object.freeze({
        type: 'delete' as const,
        position: change.position,
        text: change.text,
        byteLength: change.byteLength,
      });
    case 'delete':
      return Object.freeze({
        type: 'insert' as const,
        position: change.position,
        text: change.text,
        byteLength: change.byteLength,
      });
    case 'replace':
      return Object.freeze({
        type: 'replace' as const,
        position: change.position,
        text: change.oldText,
        byteLength: textEncoder.encode(change.oldText).length,
        oldText: change.text,
      });
  }
}

/**
 * Apply a single change (for redo).
 * Uses eager line index strategy for immediate accuracy after redo.
 */
function applyChange(state: DocumentState, change: HistoryChange, version: number): DocumentState {
  switch (change.type) {
    case 'insert': {
      const { state: s } = pieceTableInsert(state, change.position, change.text);
      const readText = (start: ByteOffset, end: ByteOffset) => getText(s.pieceTable, start, end);
      const newLineIndex = eagerLineIndex.insert(s.lineIndex, change.position, change.text, version, readText);
      return withState(s, { lineIndex: newLineIndex });
    }
    case 'delete': {
      const end = byteOffset(change.position + change.byteLength);
      const s = pieceTableDelete(state, change.position, end);
      const newLineIndex = eagerLineIndex.delete(s.lineIndex, change.position, end, change.text, version);
      return withState(s, { lineIndex: newLineIndex });
    }
    case 'replace': {
      const deleteEnd = byteOffset(change.position + textEncoder.encode(change.oldText).length);
      const s = pieceTableDelete(state, change.position, deleteEnd);
      const { state: s2 } = pieceTableInsert(s, change.position, change.text);
      const li1 = eagerLineIndex.delete(s2.lineIndex, change.position, deleteEnd, change.oldText, version);
      const readText = (start: ByteOffset, end: ByteOffset) => getText(s2.pieceTable, start, end);
      const li2 = eagerLineIndex.insert(li1, change.position, change.text, version, readText);
      return withState(s2, { lineIndex: li2 });
    }
    default:
      return state;
  }
}

/**
 * Apply inverse of a change (for undo).
 * Delegates to applyChange(invertChange(change)) — the structural dual.
 */
function applyInverseChange(state: DocumentState, change: HistoryChange, version: number): DocumentState {
  return applyChange(state, invertChange(change), version);
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
// Unified Edit Pipeline
// =============================================================================

/**
 * Describes an edit operation: an optional delete followed by an optional insert.
 * INSERT = { position, insertText }
 * DELETE = { position, deleteEnd, deletedText }
 * REPLACE = { position, deleteEnd, deletedText, insertText }
 */
interface EditOperation {
  position: ByteOffset;
  deleteEnd?: ByteOffset;
  deletedText?: string;
  insertText: string;
  timestamp?: number;
}

/**
 * Apply a text edit through the unified pipeline:
 * 1. Delete phase (if deleteEnd specified)
 * 2. Insert phase (if insertText non-empty)
 * 3. Build history change
 * 4. Push to history
 * 5. Mark dirty + increment version
 */
function applyEdit(state: DocumentState, op: EditOperation): DocumentState {
  const nextVersion = state.version + 1;
  let newState: DocumentState = state;

  // Delete phase
  if (op.deleteEnd !== undefined) {
    newState = pieceTableDelete(newState, op.position, op.deleteEnd);
    const delLineIndex = lazyLineIndex.delete(newState.lineIndex, op.position, op.deleteEnd, op.deletedText!, nextVersion);
    newState = withState(newState, { lineIndex: delLineIndex });
  }

  // Insert phase
  let insertedByteLength = 0;
  if (op.insertText.length > 0) {
    const result = pieceTableInsert(newState, op.position, op.insertText);
    newState = result.state;
    insertedByteLength = result.insertedByteLength;
    const readText = (start: ByteOffset, end: ByteOffset) => getText(newState.pieceTable, start, end);
    const insLineIndex = lazyLineIndex.insert(newState.lineIndex, op.position, op.insertText, nextVersion, readText);
    newState = withState(newState, { lineIndex: insLineIndex });
  }

  // Build and push history change
  let historyChange: HistoryChange;
  if (op.deleteEnd !== undefined && op.insertText.length > 0) {
    historyChange = Object.freeze({
      type: 'replace' as const,
      position: op.position,
      text: op.insertText,
      byteLength: insertedByteLength,
      oldText: op.deletedText!,
    });
  } else if (op.deleteEnd !== undefined) {
    historyChange = Object.freeze({
      type: 'delete' as const,
      position: op.position,
      text: op.deletedText!,
      byteLength: (op.deleteEnd as number) - (op.position as number),
    });
  } else {
    historyChange = Object.freeze({
      type: 'insert' as const,
      position: op.position,
      text: op.insertText,
      byteLength: insertedByteLength,
    });
  }
  newState = historyPush(newState, historyChange, op.timestamp ?? Date.now());

  // Mark as dirty and increment version
  return withState(newState, {
    version: nextVersion,
    metadata: Object.freeze({
      ...state.metadata,
      isDirty: true,
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
      const position = validatePosition(action.start, state.pieceTable.totalLength);
      if (action.text.length === 0) return state;
      return applyEdit(state, { position, insertText: action.text, timestamp: action.timestamp });
    }

    case 'DELETE': {
      const { start, end, valid } = validateRange(action.start, action.end, state.pieceTable.totalLength);
      if (!valid) return state;
      if (end - start <= 0) return state;
      const deletedText = getTextRange(state, start, end);
      return applyEdit(state, { position: start, deleteEnd: end, deletedText, insertText: '', timestamp: action.timestamp });
    }

    case 'REPLACE': {
      const { start, end, valid } = validateRange(action.start, action.end, state.pieceTable.totalLength);
      if (!valid) return state;
      const oldText = getTextRange(state, start, end);
      return applyEdit(state, { position: start, deleteEnd: end, deletedText: oldText, insertText: action.text, timestamp: action.timestamp });
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
      // Clear both undo and redo stacks while preserving config
      return withState(state, {
        history: Object.freeze({
          undoStack: Object.freeze([]),
          redoStack: Object.freeze([]),
          limit: state.history.limit,
          coalesceTimeout: state.history.coalesceTimeout,
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
          newState = pieceTableInsert(newState, change.start, change.text).state;
          const readText = (start: ByteOffset, end: ByteOffset) => getText(newState.pieceTable, start, end);
          const li = lazyLineIndex.insert(newState.lineIndex, change.start, change.text, nextVersion, readText);
          newState = withState(newState, { lineIndex: li });
        } else if (change.type === 'delete' && change.length) {
          // Capture deleted text before deleting for line index update
          const endPosition = byteOffset(change.start + change.length);
          const deletedText = getTextRange(newState, change.start, endPosition);
          newState = pieceTableDelete(newState, change.start, endPosition);
          const li = lazyLineIndex.delete(newState.lineIndex, change.start, endPosition, deletedText, nextVersion);
          newState = withState(newState, { lineIndex: li });
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
