/**
 * Tests for history helper functions.
 * Tests canUndo, canRedo, getUndoCount, getRedoCount, isHistoryEmpty, and HISTORY_CLEAR action.
 */

import { describe, it, expect } from 'vitest';
import {
  canUndo,
  canRedo,
  getUndoCount,
  getRedoCount,
  isHistoryEmpty,
} from './history.ts';
import { createInitialState } from './state.ts';
import { documentReducer } from './reducer.ts';
import { DocumentActions } from './actions.ts';
import type { HistoryState } from '../types/state.ts';
import { byteOffset } from '../types/branded.ts';

// =============================================================================
// canUndo Tests
// =============================================================================

describe('canUndo', () => {
  it('should return false for initial state', () => {
    const state = createInitialState();
    expect(canUndo(state)).toBe(false);
  });

  it('should return true after an edit action', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    expect(canUndo(state)).toBe(true);
  });

  it('should return false after undoing all changes', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    state = documentReducer(state, DocumentActions.undo());
    expect(canUndo(state)).toBe(false);
  });

  it('should work with HistoryState directly', () => {
    const historyState: HistoryState = {
      undoStack: [
        {
          changes: [{ type: 'insert', position: byteOffset(0), text: 'a' }],
          selectionBefore: { ranges: [{ anchor: 0, head: 0 }], primaryIndex: 0 },
          selectionAfter: { ranges: [{ anchor: 1, head: 1 }], primaryIndex: 0 },
          timestamp: Date.now(),
        },
      ],
      redoStack: [],
      limit: 1000,
    };
    expect(canUndo(historyState)).toBe(true);
  });

  it('should return true after multiple edits', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'a'));
    state = documentReducer(state, DocumentActions.insert(byteOffset(1), 'b'));
    state = documentReducer(state, DocumentActions.insert(byteOffset(2), 'c'));
    expect(canUndo(state)).toBe(true);
  });
});

// =============================================================================
// canRedo Tests
// =============================================================================

describe('canRedo', () => {
  it('should return false for initial state', () => {
    const state = createInitialState();
    expect(canRedo(state)).toBe(false);
  });

  it('should return false after an edit without undo', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    expect(canRedo(state)).toBe(false);
  });

  it('should return true after undo', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    state = documentReducer(state, DocumentActions.undo());
    expect(canRedo(state)).toBe(true);
  });

  it('should return false after redo', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    state = documentReducer(state, DocumentActions.undo());
    state = documentReducer(state, DocumentActions.redo());
    expect(canRedo(state)).toBe(false);
  });

  it('should work with HistoryState directly', () => {
    const historyState: HistoryState = {
      undoStack: [],
      redoStack: [
        {
          changes: [{ type: 'insert', position: byteOffset(0), text: 'a' }],
          selectionBefore: { ranges: [{ anchor: 0, head: 0 }], primaryIndex: 0 },
          selectionAfter: { ranges: [{ anchor: 1, head: 1 }], primaryIndex: 0 },
          timestamp: Date.now(),
        },
      ],
      limit: 1000,
    };
    expect(canRedo(historyState)).toBe(true);
  });
});

// =============================================================================
// getUndoCount Tests
// =============================================================================

describe('getUndoCount', () => {
  it('should return 0 for initial state', () => {
    const state = createInitialState();
    expect(getUndoCount(state)).toBe(0);
  });

  it('should return correct count after multiple edits', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'a'));
    expect(getUndoCount(state)).toBe(1);

    state = documentReducer(state, DocumentActions.insert(byteOffset(1), 'b'));
    expect(getUndoCount(state)).toBe(2);

    state = documentReducer(state, DocumentActions.insert(byteOffset(2), 'c'));
    expect(getUndoCount(state)).toBe(3);
  });

  it('should decrease after undo', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'a'));
    state = documentReducer(state, DocumentActions.insert(byteOffset(1), 'b'));
    expect(getUndoCount(state)).toBe(2);

    state = documentReducer(state, DocumentActions.undo());
    expect(getUndoCount(state)).toBe(1);
  });

  it('should work with HistoryState directly', () => {
    const historyState: HistoryState = {
      undoStack: [
        {
          changes: [{ type: 'insert', position: byteOffset(0), text: 'a' }],
          selectionBefore: { ranges: [{ anchor: 0, head: 0 }], primaryIndex: 0 },
          selectionAfter: { ranges: [{ anchor: 1, head: 1 }], primaryIndex: 0 },
          timestamp: Date.now(),
        },
        {
          changes: [{ type: 'insert', position: byteOffset(1), text: 'b' }],
          selectionBefore: { ranges: [{ anchor: 1, head: 1 }], primaryIndex: 0 },
          selectionAfter: { ranges: [{ anchor: 2, head: 2 }], primaryIndex: 0 },
          timestamp: Date.now(),
        },
      ],
      redoStack: [],
      limit: 1000,
    };
    expect(getUndoCount(historyState)).toBe(2);
  });
});

// =============================================================================
// getRedoCount Tests
// =============================================================================

describe('getRedoCount', () => {
  it('should return 0 for initial state', () => {
    const state = createInitialState();
    expect(getRedoCount(state)).toBe(0);
  });

  it('should return correct count after undos', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'a'));
    state = documentReducer(state, DocumentActions.insert(byteOffset(1), 'b'));
    state = documentReducer(state, DocumentActions.insert(byteOffset(2), 'c'));

    state = documentReducer(state, DocumentActions.undo());
    expect(getRedoCount(state)).toBe(1);

    state = documentReducer(state, DocumentActions.undo());
    expect(getRedoCount(state)).toBe(2);
  });

  it('should decrease after redo', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'a'));
    state = documentReducer(state, DocumentActions.insert(byteOffset(1), 'b'));
    state = documentReducer(state, DocumentActions.undo());
    state = documentReducer(state, DocumentActions.undo());
    expect(getRedoCount(state)).toBe(2);

    state = documentReducer(state, DocumentActions.redo());
    expect(getRedoCount(state)).toBe(1);
  });

  it('should work with HistoryState directly', () => {
    const historyState: HistoryState = {
      undoStack: [],
      redoStack: [
        {
          changes: [{ type: 'insert', position: byteOffset(0), text: 'a' }],
          selectionBefore: { ranges: [{ anchor: 0, head: 0 }], primaryIndex: 0 },
          selectionAfter: { ranges: [{ anchor: 1, head: 1 }], primaryIndex: 0 },
          timestamp: Date.now(),
        },
      ],
      limit: 1000,
    };
    expect(getRedoCount(historyState)).toBe(1);
  });
});

// =============================================================================
// isHistoryEmpty Tests
// =============================================================================

describe('isHistoryEmpty', () => {
  it('should return true for initial state', () => {
    const state = createInitialState();
    expect(isHistoryEmpty(state)).toBe(true);
  });

  it('should return false after an edit', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    expect(isHistoryEmpty(state)).toBe(false);
  });

  it('should return false after undo (redo stack not empty)', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    state = documentReducer(state, DocumentActions.undo());
    expect(isHistoryEmpty(state)).toBe(false);
  });

  it('should return true after undo then redo', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    state = documentReducer(state, DocumentActions.undo());
    state = documentReducer(state, DocumentActions.redo());
    // Undo stack has 1 entry, redo stack is empty
    expect(isHistoryEmpty(state)).toBe(false);
  });

  it('should work with HistoryState directly', () => {
    const emptyHistory: HistoryState = {
      undoStack: [],
      redoStack: [],
      limit: 1000,
    };
    expect(isHistoryEmpty(emptyHistory)).toBe(true);

    const nonEmptyHistory: HistoryState = {
      undoStack: [
        {
          changes: [{ type: 'insert', position: byteOffset(0), text: 'a' }],
          selectionBefore: { ranges: [{ anchor: 0, head: 0 }], primaryIndex: 0 },
          selectionAfter: { ranges: [{ anchor: 1, head: 1 }], primaryIndex: 0 },
          timestamp: Date.now(),
        },
      ],
      redoStack: [],
      limit: 1000,
    };
    expect(isHistoryEmpty(nonEmptyHistory)).toBe(false);
  });
});

// =============================================================================
// HISTORY_CLEAR Action Tests
// =============================================================================

describe('HISTORY_CLEAR action', () => {
  it('should clear both undo and redo stacks', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    state = documentReducer(state, DocumentActions.insert(byteOffset(5), ' World'));
    state = documentReducer(state, DocumentActions.undo());

    // Should have entries in both stacks
    expect(getUndoCount(state)).toBe(1);
    expect(getRedoCount(state)).toBe(1);

    // Clear history
    state = documentReducer(state, DocumentActions.historyClear());

    expect(getUndoCount(state)).toBe(0);
    expect(getRedoCount(state)).toBe(0);
    expect(isHistoryEmpty(state)).toBe(true);
  });

  it('should preserve history limit', () => {
    let state = createInitialState({ historyLimit: 50 });
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    state = documentReducer(state, DocumentActions.historyClear());

    expect(state.history.limit).toBe(50);
  });

  it('should increment version', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    const versionBefore = state.version;

    state = documentReducer(state, DocumentActions.historyClear());

    expect(state.version).toBe(versionBefore + 1);
  });

  it('should not affect document content', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    state = documentReducer(state, DocumentActions.insert(byteOffset(5), ' World'));

    const lengthBefore = state.pieceTable.totalLength;

    state = documentReducer(state, DocumentActions.historyClear());

    expect(state.pieceTable.totalLength).toBe(lengthBefore);
  });

  it('should work on empty history', () => {
    let state = createInitialState();

    // Should not throw when clearing empty history
    state = documentReducer(state, DocumentActions.historyClear());

    expect(isHistoryEmpty(state)).toBe(true);
  });

  it('should return frozen history state', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
    state = documentReducer(state, DocumentActions.historyClear());

    expect(Object.isFrozen(state.history)).toBe(true);
    expect(Object.isFrozen(state.history.undoStack)).toBe(true);
    expect(Object.isFrozen(state.history.redoStack)).toBe(true);
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('History helpers integration', () => {
  it('should track full undo/redo cycle correctly', () => {
    let state = createInitialState();

    // Initial state
    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(false);
    expect(getUndoCount(state)).toBe(0);
    expect(getRedoCount(state)).toBe(0);
    expect(isHistoryEmpty(state)).toBe(true);

    // Make edits
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'a'));
    expect(canUndo(state)).toBe(true);
    expect(canRedo(state)).toBe(false);
    expect(getUndoCount(state)).toBe(1);

    state = documentReducer(state, DocumentActions.insert(byteOffset(1), 'b'));
    expect(getUndoCount(state)).toBe(2);

    state = documentReducer(state, DocumentActions.insert(byteOffset(2), 'c'));
    expect(getUndoCount(state)).toBe(3);

    // Undo
    state = documentReducer(state, DocumentActions.undo());
    expect(canUndo(state)).toBe(true);
    expect(canRedo(state)).toBe(true);
    expect(getUndoCount(state)).toBe(2);
    expect(getRedoCount(state)).toBe(1);

    // Redo
    state = documentReducer(state, DocumentActions.redo());
    expect(canUndo(state)).toBe(true);
    expect(canRedo(state)).toBe(false);
    expect(getUndoCount(state)).toBe(3);
    expect(getRedoCount(state)).toBe(0);

    // Clear
    state = documentReducer(state, DocumentActions.historyClear());
    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(false);
    expect(isHistoryEmpty(state)).toBe(true);
  });

  it('should clear redo stack on new edit', () => {
    let state = createInitialState();
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'a'));
    state = documentReducer(state, DocumentActions.insert(byteOffset(1), 'b'));
    state = documentReducer(state, DocumentActions.undo());

    expect(getRedoCount(state)).toBe(1);

    // New edit should clear redo stack
    state = documentReducer(state, DocumentActions.insert(byteOffset(1), 'c'));

    expect(getRedoCount(state)).toBe(0);
    expect(canRedo(state)).toBe(false);
  });
});
