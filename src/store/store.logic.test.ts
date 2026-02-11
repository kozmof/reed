/**
 * Logic tests for the Reed document store.
 * Unit tests for reducer, state factories, action creators, and invariants.
 */

import { describe, it, expect } from 'vitest';
import { documentReducer } from './reducer.ts';
import {
  createInitialState,
  createEmptyPieceTableState,
  createPieceTableState,
  createEmptyLineIndexState,
  createLineIndexState,
  createInitialSelectionState,
  createInitialHistoryState,
  createInitialMetadata,
  createPieceNode,
  createLineIndexNode,
  withState,
  withPieceNode,
  withLineIndexNode,
} from './state.ts';
import {
  DocumentActions,
  serializeAction,
  deserializeAction,
} from './actions.ts';
import {
  isTextEditAction,
  isHistoryAction,
  isTransactionAction,
  isDocumentAction,
} from '../types/actions.ts';
import { createDocumentStore, isDocumentStore } from './store.ts';
import { getLineCountFromIndex, getLineRange } from './line-index.ts';
import { byteOffset, byteLength, type ByteOffset } from '../types/branded.ts';

// =============================================================================
// State Factory Tests
// =============================================================================

describe('State Factories', () => {
  describe('createInitialState', () => {
    it('should create state with default config', () => {
      const state = createInitialState();

      expect(state.version).toBe(0);
      expect(state.pieceTable.totalLength).toBe(0);
      expect(state.lineIndex.lineCount).toBe(1);
      expect(state.selection.ranges.length).toBe(1);
      expect(state.history.undoStack.length).toBe(0);
      expect(state.history.redoStack.length).toBe(0);
      expect(state.metadata.isDirty).toBe(false);
    });

    it('should create state with initial content', () => {
      const state = createInitialState({ content: 'Hello' });

      expect(state.pieceTable.totalLength).toBe(5);
      expect(state.pieceTable.originalBuffer.length).toBe(5);
    });

    it('should create state with custom history limit', () => {
      const state = createInitialState({ historyLimit: 100 });

      expect(state.history.limit).toBe(100);
    });

    it('should create state with custom encoding', () => {
      const state = createInitialState({ encoding: 'utf-16' });

      expect(state.metadata.encoding).toBe('utf-16');
    });

    it('should create state with custom line ending', () => {
      const state = createInitialState({ lineEnding: 'crlf' });

      expect(state.metadata.lineEnding).toBe('crlf');
    });

    it('should return frozen state', () => {
      const state = createInitialState();

      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.pieceTable)).toBe(true);
      expect(Object.isFrozen(state.selection)).toBe(true);
      expect(Object.isFrozen(state.history)).toBe(true);
      expect(Object.isFrozen(state.metadata)).toBe(true);
    });
  });

  describe('createEmptyPieceTableState', () => {
    it('should create empty piece table', () => {
      const pieceTable = createEmptyPieceTableState();

      expect(pieceTable.root).toBeNull();
      expect(pieceTable.originalBuffer.length).toBe(0);
      expect(pieceTable.addBuffer.length).toBe(0);
      expect(pieceTable.addBufferLength).toBe(0);
      expect(pieceTable.totalLength).toBe(0);
    });

    it('should be frozen', () => {
      const pieceTable = createEmptyPieceTableState();
      expect(Object.isFrozen(pieceTable)).toBe(true);
    });
  });

  describe('createPieceTableState', () => {
    it('should create piece table from content', () => {
      const pieceTable = createPieceTableState('Hello World');

      expect(pieceTable.totalLength).toBe(11);
      expect(pieceTable.originalBuffer.length).toBe(11);
      expect(pieceTable.root).not.toBeNull();
    });

    it('should return empty state for empty content', () => {
      const pieceTable = createPieceTableState('');

      expect(pieceTable.totalLength).toBe(0);
      expect(pieceTable.root).toBeNull();
    });

    it('should pre-allocate add buffer', () => {
      const pieceTable = createPieceTableState('Hi');

      expect(pieceTable.addBuffer.length).toBeGreaterThan(0);
      expect(pieceTable.addBufferLength).toBe(0);
    });
  });

  describe('createPieceNode', () => {
    it('should create node with default values', () => {
      const node = createPieceNode('original', byteOffset(0), byteLength(10));

      expect(node.bufferType).toBe('original');
      expect(node.start).toBe(0);
      expect(node.length).toBe(10);
      expect(node.color).toBe('black');
      expect(node.left).toBeNull();
      expect(node.right).toBeNull();
      expect(node.subtreeLength).toBe(10);
    });

    it('should calculate subtreeLength with children', () => {
      const left = createPieceNode('original', byteOffset(0), byteLength(5));
      const right = createPieceNode('add', byteOffset(0), byteLength(3));
      const parent = createPieceNode('original', byteOffset(5), byteLength(10), 'black', left, right);

      expect(parent.subtreeLength).toBe(18); // 5 + 10 + 3
    });

    it('should support red color', () => {
      const node = createPieceNode('add', byteOffset(0), byteLength(5), 'red');
      expect(node.color).toBe('red');
    });
  });

  describe('createEmptyLineIndexState', () => {
    it('should create state with 1 line count', () => {
      const lineIndex = createEmptyLineIndexState();

      expect(lineIndex.root).toBeNull();
      expect(lineIndex.lineCount).toBe(1);
    });
  });

  describe('createLineIndexState', () => {
    it('should count lines correctly', () => {
      const lineIndex = createLineIndexState('Line 1\nLine 2\nLine 3');

      expect(lineIndex.lineCount).toBe(3);
      expect(lineIndex.root).not.toBeNull();
    });

    it('should handle CRLF line endings', () => {
      const lineIndex = createLineIndexState('Line 1\r\nLine 2\r\nLine 3');

      expect(lineIndex.lineCount).toBe(3);
    });

    it('should handle CR only line endings', () => {
      const lineIndex = createLineIndexState('Line 1\rLine 2\rLine 3');

      expect(lineIndex.lineCount).toBe(3);
    });

    it('should handle content without trailing newline', () => {
      const lineIndex = createLineIndexState('Single line');

      expect(lineIndex.lineCount).toBe(1);
    });
  });

  describe('createLineIndexNode', () => {
    it('should create node with metadata', () => {
      const node = createLineIndexNode(0, 10);

      expect(node.documentOffset).toBe(0);
      expect(node.lineLength).toBe(10);
      expect(node.subtreeLineCount).toBe(1);
      expect(node.subtreeByteLength).toBe(10);
    });

    it('should aggregate subtree metadata', () => {
      const left = createLineIndexNode(0, 5);
      const right = createLineIndexNode(15, 8);
      const parent = createLineIndexNode(5, 10, 'black', left, right);

      expect(parent.subtreeLineCount).toBe(3);
      expect(parent.subtreeByteLength).toBe(23); // 5 + 10 + 8
    });
  });

  describe('createInitialSelectionState', () => {
    it('should create cursor at position 0', () => {
      const selection = createInitialSelectionState();

      expect(selection.ranges.length).toBe(1);
      expect(selection.ranges[0].anchor).toBe(0);
      expect(selection.ranges[0].head).toBe(0);
      expect(selection.primaryIndex).toBe(0);
    });
  });

  describe('createInitialHistoryState', () => {
    it('should create empty stacks with limit', () => {
      const history = createInitialHistoryState(500);

      expect(history.undoStack.length).toBe(0);
      expect(history.redoStack.length).toBe(0);
      expect(history.limit).toBe(500);
    });

    it('should use default limit of 1000', () => {
      const history = createInitialHistoryState();
      expect(history.limit).toBe(1000);
    });
  });

  describe('createInitialMetadata', () => {
    it('should create metadata with defaults', () => {
      const metadata = createInitialMetadata();

      expect(metadata.filePath).toBeUndefined();
      expect(metadata.encoding).toBe('utf-8');
      expect(metadata.lineEnding).toBe('lf');
      expect(metadata.isDirty).toBe(false);
      expect(metadata.lastSaved).toBeUndefined();
    });
  });

  describe('withState', () => {
    it('should create new state with changes', () => {
      const state = createInitialState();
      const newState = withState(state, { version: 1 });

      expect(newState.version).toBe(1);
      expect(newState).not.toBe(state);
    });

    it('should preserve unchanged properties', () => {
      const state = createInitialState();
      const newState = withState(state, { version: 1 });

      expect(newState.pieceTable).toBe(state.pieceTable);
      expect(newState.selection).toBe(state.selection);
      expect(newState.history).toBe(state.history);
    });

    it('should return frozen state', () => {
      const state = createInitialState();
      const newState = withState(state, { version: 1 });

      expect(Object.isFrozen(newState)).toBe(true);
    });
  });

  describe('withPieceNode', () => {
    it('should recalculate subtreeLength on child change', () => {
      const node = createPieceNode('original', byteOffset(0), byteLength(10));
      const newLeft = createPieceNode('add', byteOffset(0), byteLength(5));
      const newNode = withPieceNode(node, { left: newLeft });

      expect(newNode.subtreeLength).toBe(15); // 10 + 5
    });
  });

  describe('withLineIndexNode', () => {
    it('should recalculate subtree metadata on child change', () => {
      const node = createLineIndexNode(0, 10);
      const newLeft = createLineIndexNode(0, 5);
      const newNode = withLineIndexNode(node, { left: newLeft });

      expect(newNode.subtreeLineCount).toBe(2);
      expect(newNode.subtreeByteLength).toBe(15);
    });
  });
});

// =============================================================================
// Reducer Tests
// =============================================================================

describe('Document Reducer', () => {
  describe('INSERT action', () => {
    it('should increase total length', () => {
      const state = createInitialState();
      const newState = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));

      expect(newState.pieceTable.totalLength).toBe(5);
    });

    it('should increment version', () => {
      const state = createInitialState();
      const newState = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hi'));

      expect(newState.version).toBe(1);
    });

    it('should mark document as dirty', () => {
      const state = createInitialState();
      const newState = documentReducer(state, DocumentActions.insert(byteOffset(0), 'A'));

      expect(newState.metadata.isDirty).toBe(true);
    });

    it('should push to history', () => {
      const state = createInitialState();
      const newState = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Test'));

      expect(newState.history.undoStack.length).toBe(1);
      expect(newState.history.undoStack[0].changes[0].type).toBe('insert');
    });

    it('should update line count for newlines', () => {
      const state = createInitialState();
      const newState = documentReducer(state, DocumentActions.insert(byteOffset(0), 'A\nB\nC'));

      expect(newState.lineIndex.lineCount).toBe(3);
    });

    it('should grow add buffer when needed', () => {
      const state = createInitialState();
      const longText = 'x'.repeat(2000);
      const newState = documentReducer(state, DocumentActions.insert(byteOffset(0), longText));

      expect(newState.pieceTable.addBuffer.length).toBeGreaterThanOrEqual(2000);
    });
  });

  describe('DELETE action', () => {
    it('should decrease total length', () => {
      const state = createInitialState({ content: 'Hello World' });
      const newState = documentReducer(state, DocumentActions.delete(byteOffset(0), byteOffset(5)));

      expect(newState.pieceTable.totalLength).toBe(6);
    });

    it('should do nothing for zero-length delete', () => {
      const state = createInitialState({ content: 'Hello' });
      const newState = documentReducer(state, DocumentActions.delete(byteOffset(2), byteOffset(2)));

      expect(newState).toBe(state);
    });

    it('should do nothing for negative range', () => {
      const state = createInitialState({ content: 'Hello' });
      const newState = documentReducer(state, DocumentActions.delete(byteOffset(5), byteOffset(3)));

      expect(newState).toBe(state);
    });

    it('should not go below zero length', () => {
      const state = createInitialState({ content: 'Hi' });
      const newState = documentReducer(state, DocumentActions.delete(byteOffset(0), byteOffset(100)));

      expect(newState.pieceTable.totalLength).toBe(0);
    });
  });

  describe('REPLACE action', () => {
    it('should replace text range', () => {
      const state = createInitialState({ content: 'Hello World' });
      const newState = documentReducer(
        state,
        DocumentActions.replace(byteOffset(6), byteOffset(11), 'Universe')
      );

      // Original: 11, Delete 5, Add 8 = 14
      expect(newState.pieceTable.totalLength).toBe(14);
    });

    it('should work as insert when range is empty', () => {
      const state = createInitialState({ content: 'AB' });
      const newState = documentReducer(
        state,
        DocumentActions.replace(byteOffset(1), byteOffset(1), 'X')
      );

      expect(newState.pieceTable.totalLength).toBe(3);
    });
  });

  describe('SET_SELECTION action', () => {
    it('should update selection ranges', () => {
      const state = createInitialState({ content: 'Hello' });
      const newState = documentReducer(
        state,
        DocumentActions.setSelection([{ anchor: byteOffset(1), head: byteOffset(4) }])
      );

      expect(newState.selection.ranges[0].anchor).toBe(1);
      expect(newState.selection.ranges[0].head).toBe(4);
    });

    it('should increment version', () => {
      const state = createInitialState();
      const newState = documentReducer(
        state,
        DocumentActions.setSelection([{ anchor: byteOffset(0), head: byteOffset(0) }])
      );

      expect(newState.version).toBe(1);
    });

    it('should not mark dirty', () => {
      const state = createInitialState();
      const newState = documentReducer(
        state,
        DocumentActions.setSelection([{ anchor: byteOffset(0), head: byteOffset(0) }])
      );

      expect(newState.metadata.isDirty).toBe(false);
    });
  });

  describe('UNDO action', () => {
    it('should revert insert', () => {
      let state = createInitialState();
      state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
      expect(state.pieceTable.totalLength).toBe(5);

      state = documentReducer(state, DocumentActions.undo());
      expect(state.pieceTable.totalLength).toBe(0);
    });

    it('should move entry from undo to redo stack', () => {
      let state = createInitialState();
      state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'A'));
      expect(state.history.undoStack.length).toBe(1);
      expect(state.history.redoStack.length).toBe(0);

      state = documentReducer(state, DocumentActions.undo());
      expect(state.history.undoStack.length).toBe(0);
      expect(state.history.redoStack.length).toBe(1);
    });

    it('should return same state when nothing to undo', () => {
      const state = createInitialState();
      const newState = documentReducer(state, DocumentActions.undo());

      expect(newState).toBe(state);
    });
  });

  describe('REDO action', () => {
    it('should reapply undone action', () => {
      let state = createInitialState();
      state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Hello'));
      state = documentReducer(state, DocumentActions.undo());
      expect(state.pieceTable.totalLength).toBe(0);

      state = documentReducer(state, DocumentActions.redo());
      expect(state.pieceTable.totalLength).toBe(5);
    });

    it('should return same state when nothing to redo', () => {
      const state = createInitialState();
      const newState = documentReducer(state, DocumentActions.redo());

      expect(newState).toBe(state);
    });
  });

  describe('Undo/Redo line index correctness (P3 fix)', () => {
    it('should update line count after undoing an insert with newlines', () => {
      let state = createInitialState();
      state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'Line 1\nLine 2\nLine 3'));
      expect(getLineCountFromIndex(state.lineIndex)).toBe(3);

      state = documentReducer(state, DocumentActions.undo());
      expect(state.pieceTable.totalLength).toBe(0);
      expect(getLineCountFromIndex(state.lineIndex)).toBe(1);
    });

    it('should update line count after redoing an insert with newlines', () => {
      let state = createInitialState();
      state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'A\nB\nC\nD'));
      expect(getLineCountFromIndex(state.lineIndex)).toBe(4);

      state = documentReducer(state, DocumentActions.undo());
      expect(getLineCountFromIndex(state.lineIndex)).toBe(1);

      state = documentReducer(state, DocumentActions.redo());
      expect(getLineCountFromIndex(state.lineIndex)).toBe(4);
    });

    it('should update line count after undoing a delete that removed newlines', () => {
      let state = createInitialState({ content: 'Line 1\nLine 2\nLine 3' });
      expect(getLineCountFromIndex(state.lineIndex)).toBe(3);

      // Delete "Line 2\n" (bytes 7-14)
      state = documentReducer(state, DocumentActions.delete(byteOffset(7), byteOffset(14)));
      expect(getLineCountFromIndex(state.lineIndex)).toBe(2);

      state = documentReducer(state, DocumentActions.undo());
      expect(getLineCountFromIndex(state.lineIndex)).toBe(3);
    });

    it('should update line count after undoing a replace that changed line structure', () => {
      let state = createInitialState({ content: 'Hello World' });
      expect(getLineCountFromIndex(state.lineIndex)).toBe(1);

      // Replace "World" (bytes 6-11) with "A\nB\nC"
      state = documentReducer(state, DocumentActions.replace(byteOffset(6), byteOffset(11), 'A\nB\nC'));
      expect(getLineCountFromIndex(state.lineIndex)).toBe(3);

      state = documentReducer(state, DocumentActions.undo());
      expect(getLineCountFromIndex(state.lineIndex)).toBe(1);
    });

    it('should maintain correct line count through multiple undo/redo cycles', () => {
      let state = createInitialState();
      state = documentReducer(state, DocumentActions.insert(byteOffset(0), 'A\nB'));
      expect(getLineCountFromIndex(state.lineIndex)).toBe(2);

      state = documentReducer(state, DocumentActions.insert(byteOffset(3), '\nC\nD'));
      expect(getLineCountFromIndex(state.lineIndex)).toBe(4);

      // Undo second insert
      state = documentReducer(state, DocumentActions.undo());
      expect(getLineCountFromIndex(state.lineIndex)).toBe(2);

      // Undo first insert
      state = documentReducer(state, DocumentActions.undo());
      expect(getLineCountFromIndex(state.lineIndex)).toBe(1);

      // Redo first insert
      state = documentReducer(state, DocumentActions.redo());
      expect(getLineCountFromIndex(state.lineIndex)).toBe(2);

      // Redo second insert
      state = documentReducer(state, DocumentActions.redo());
      expect(getLineCountFromIndex(state.lineIndex)).toBe(4);
    });
  });

  describe('APPLY_REMOTE action', () => {
    it('should apply remote insert', () => {
      const state = createInitialState();
      const newState = documentReducer(
        state,
        DocumentActions.applyRemote([
          { type: 'insert', start: byteOffset(0), text: 'Remote' },
        ])
      );

      expect(newState.pieceTable.totalLength).toBe(6);
    });

    it('should apply remote delete', () => {
      const state = createInitialState({ content: 'Hello World' });
      const newState = documentReducer(
        state,
        DocumentActions.applyRemote([
          { type: 'delete', start: byteOffset(5), length: 6 },
        ])
      );

      expect(newState.pieceTable.totalLength).toBe(5);
    });

    it('should not push to history', () => {
      const state = createInitialState();
      const newState = documentReducer(
        state,
        DocumentActions.applyRemote([
          { type: 'insert', start: byteOffset(0), text: 'A' },
        ])
      );

      expect(newState.history.undoStack.length).toBe(0);
    });
  });

  describe('Transaction actions', () => {
    it('should return same state for TRANSACTION_START', () => {
      const state = createInitialState();
      const newState = documentReducer(
        state,
        DocumentActions.transactionStart()
      );

      expect(newState).toBe(state);
    });

    it('should return same state for TRANSACTION_COMMIT', () => {
      const state = createInitialState();
      const newState = documentReducer(
        state,
        DocumentActions.transactionCommit()
      );

      expect(newState).toBe(state);
    });

    it('should return same state for TRANSACTION_ROLLBACK', () => {
      const state = createInitialState();
      const newState = documentReducer(
        state,
        DocumentActions.transactionRollback()
      );

      expect(newState).toBe(state);
    });
  });

  describe('Structural sharing', () => {
    it('should preserve unchanged subtrees', () => {
      const state = createInitialState({ content: 'Hello' });
      const newState = documentReducer(
        state,
        DocumentActions.setSelection([{ anchor: byteOffset(1), head: byteOffset(1) }])
      );

      // pieceTable should be same reference (unchanged)
      expect(newState.pieceTable).toBe(state.pieceTable);
      // lineIndex should be same reference (unchanged)
      expect(newState.lineIndex).toBe(state.lineIndex);
      // history should be same reference (SET_SELECTION doesn't affect history)
      expect(newState.history).toBe(state.history);
    });

    it('should only update affected parts', () => {
      const state = createInitialState({ content: 'Hello' });
      const newState = documentReducer(state, DocumentActions.insert(byteOffset(5), '!'));

      // Selection should be same reference if not changed
      expect(newState.selection).toBe(state.selection);
    });
  });

  describe('History limit enforcement', () => {
    it('should trim undo stack when exceeding limit', () => {
      let state = createInitialState({ historyLimit: 3 });

      // Add 5 entries
      for (let i = 0; i < 5; i++) {
        state = documentReducer(state, DocumentActions.insert(byteOffset(i), String(i)));
      }

      // Should only keep last 3
      expect(state.history.undoStack.length).toBe(3);
    });
  });
});

// =============================================================================
// Action Creator Tests
// =============================================================================

describe('Action Creators', () => {
  describe('DocumentActions', () => {
    it('should create INSERT action', () => {
      const action = DocumentActions.insert(byteOffset(5), 'Hello');

      expect(action.type).toBe('INSERT');
      expect(action.start).toBe(5);
      expect(action.text).toBe('Hello');
    });

    it('should create DELETE action', () => {
      const action = DocumentActions.delete(byteOffset(0), byteOffset(10));

      expect(action.type).toBe('DELETE');
      expect(action.start).toBe(0);
      expect(action.end).toBe(10);
    });

    it('should create REPLACE action', () => {
      const action = DocumentActions.replace(byteOffset(5), byteOffset(10), 'New');

      expect(action.type).toBe('REPLACE');
      expect(action.start).toBe(5);
      expect(action.end).toBe(10);
      expect(action.text).toBe('New');
    });

    it('should create SET_SELECTION action', () => {
      const ranges = [{ anchor: byteOffset(0), head: byteOffset(5) }];
      const action = DocumentActions.setSelection(ranges);

      expect(action.type).toBe('SET_SELECTION');
      expect(action.ranges).toBe(ranges);
    });

    it('should create UNDO action', () => {
      const action = DocumentActions.undo();
      expect(action.type).toBe('UNDO');
    });

    it('should create REDO action', () => {
      const action = DocumentActions.redo();
      expect(action.type).toBe('REDO');
    });

    it('should create transaction actions', () => {
      expect(DocumentActions.transactionStart().type).toBe('TRANSACTION_START');
      expect(DocumentActions.transactionCommit().type).toBe('TRANSACTION_COMMIT');
      expect(DocumentActions.transactionRollback().type).toBe('TRANSACTION_ROLLBACK');
    });

    it('should create APPLY_REMOTE action', () => {
      const changes = [{ type: 'insert' as const, start: byteOffset(0), text: 'Hi' }];
      const action = DocumentActions.applyRemote(changes);

      expect(action.type).toBe('APPLY_REMOTE');
      expect(action.changes).toBe(changes);
    });

    it('should create LOAD_CHUNK action', () => {
      const data = new Uint8Array([1, 2, 3]);
      const action = DocumentActions.loadChunk(0, data);

      expect(action.type).toBe('LOAD_CHUNK');
      expect(action.chunkIndex).toBe(0);
      expect(action.data).toBe(data);
    });

    it('should create EVICT_CHUNK action', () => {
      const action = DocumentActions.evictChunk(5);

      expect(action.type).toBe('EVICT_CHUNK');
      expect(action.chunkIndex).toBe(5);
    });
  });

  describe('serializeAction / deserializeAction', () => {
    it('should round-trip INSERT action', () => {
      const action = DocumentActions.insert(byteOffset(10), 'Hello');
      const json = serializeAction(action);
      const restored = deserializeAction(json);

      expect(restored).toEqual(action);
    });

    it('should round-trip DELETE action', () => {
      const action = DocumentActions.delete(byteOffset(5), byteOffset(15));
      const json = serializeAction(action);
      const restored = deserializeAction(json);

      expect(restored).toEqual(action);
    });

    it('should round-trip LOAD_CHUNK action with Uint8Array', () => {
      const data = new Uint8Array([65, 66, 67, 68]); // ABCD
      const action = DocumentActions.loadChunk(3, data);
      const json = serializeAction(action);
      const restored = deserializeAction(json);

      expect(restored.type).toBe('LOAD_CHUNK');
      expect((restored as typeof action).chunkIndex).toBe(3);
      expect((restored as typeof action).data).toBeInstanceOf(Uint8Array);
      expect(Array.from((restored as typeof action).data)).toEqual([65, 66, 67, 68]);
    });

    it('should produce valid JSON', () => {
      const action = DocumentActions.replace(byteOffset(0), byteOffset(5), 'Test');
      const json = serializeAction(action);

      expect(() => JSON.parse(json)).not.toThrow();
    });
  });
});

// =============================================================================
// Type Guard Tests
// =============================================================================

describe('Type Guards', () => {
  describe('isTextEditAction', () => {
    it('should return true for INSERT', () => {
      expect(isTextEditAction(DocumentActions.insert(byteOffset(0), 'a'))).toBe(true);
    });

    it('should return true for DELETE', () => {
      expect(isTextEditAction(DocumentActions.delete(byteOffset(0), byteOffset(1)))).toBe(true);
    });

    it('should return true for REPLACE', () => {
      expect(isTextEditAction(DocumentActions.replace(byteOffset(0), byteOffset(1), 'x'))).toBe(true);
    });

    it('should return false for UNDO', () => {
      expect(isTextEditAction(DocumentActions.undo())).toBe(false);
    });
  });

  describe('isHistoryAction', () => {
    it('should return true for UNDO', () => {
      expect(isHistoryAction(DocumentActions.undo())).toBe(true);
    });

    it('should return true for REDO', () => {
      expect(isHistoryAction(DocumentActions.redo())).toBe(true);
    });

    it('should return false for INSERT', () => {
      expect(isHistoryAction(DocumentActions.insert(byteOffset(0), 'a'))).toBe(false);
    });
  });

  describe('isTransactionAction', () => {
    it('should return true for TRANSACTION_START', () => {
      expect(isTransactionAction(DocumentActions.transactionStart())).toBe(true);
    });

    it('should return true for TRANSACTION_COMMIT', () => {
      expect(isTransactionAction(DocumentActions.transactionCommit())).toBe(true);
    });

    it('should return true for TRANSACTION_ROLLBACK', () => {
      expect(isTransactionAction(DocumentActions.transactionRollback())).toBe(true);
    });

    it('should return false for INSERT', () => {
      expect(isTransactionAction(DocumentActions.insert(byteOffset(0), 'a'))).toBe(false);
    });
  });

  describe('isDocumentAction', () => {
    it('should validate INSERT action', () => {
      expect(isDocumentAction({ type: 'INSERT', start: 0, text: 'a' })).toBe(true);
      expect(isDocumentAction({ type: 'INSERT', start: 'x', text: 'a' })).toBe(false);
      expect(isDocumentAction({ type: 'INSERT', start: 0 })).toBe(false);
    });

    it('should validate DELETE action', () => {
      expect(isDocumentAction({ type: 'DELETE', start: 0, end: 5 })).toBe(true);
      expect(isDocumentAction({ type: 'DELETE', start: 0 })).toBe(false);
    });

    it('should validate REPLACE action', () => {
      expect(isDocumentAction({ type: 'REPLACE', start: 0, end: 5, text: 'x' })).toBe(true);
      expect(isDocumentAction({ type: 'REPLACE', start: 0, end: 5 })).toBe(false);
    });

    it('should validate SET_SELECTION action', () => {
      expect(isDocumentAction({ type: 'SET_SELECTION', ranges: [] })).toBe(true);
      expect(isDocumentAction({ type: 'SET_SELECTION' })).toBe(false);
    });

    it('should validate simple actions', () => {
      expect(isDocumentAction({ type: 'UNDO' })).toBe(true);
      expect(isDocumentAction({ type: 'REDO' })).toBe(true);
      expect(isDocumentAction({ type: 'TRANSACTION_START' })).toBe(true);
      expect(isDocumentAction({ type: 'TRANSACTION_COMMIT' })).toBe(true);
      expect(isDocumentAction({ type: 'TRANSACTION_ROLLBACK' })).toBe(true);
    });

    it('should validate APPLY_REMOTE action', () => {
      expect(isDocumentAction({ type: 'APPLY_REMOTE', changes: [] })).toBe(true);
      expect(isDocumentAction({ type: 'APPLY_REMOTE' })).toBe(false);
    });

    it('should validate LOAD_CHUNK action', () => {
      expect(isDocumentAction({
        type: 'LOAD_CHUNK',
        chunkIndex: 0,
        data: new Uint8Array(0),
      })).toBe(true);
      expect(isDocumentAction({ type: 'LOAD_CHUNK', chunkIndex: 0 })).toBe(false);
    });

    it('should validate EVICT_CHUNK action', () => {
      expect(isDocumentAction({ type: 'EVICT_CHUNK', chunkIndex: 0 })).toBe(true);
      expect(isDocumentAction({ type: 'EVICT_CHUNK' })).toBe(false);
    });

    it('should reject invalid values', () => {
      expect(isDocumentAction(null)).toBe(false);
      expect(isDocumentAction(undefined)).toBe(false);
      expect(isDocumentAction('string')).toBe(false);
      expect(isDocumentAction(123)).toBe(false);
      expect(isDocumentAction({})).toBe(false);
      expect(isDocumentAction({ type: 'INVALID' })).toBe(false);
    });
  });

  describe('isDocumentStore', () => {
    it('should return true for valid store', () => {
      const store = createDocumentStore();
      expect(isDocumentStore(store)).toBe(true);
    });

    it('should return false for invalid values', () => {
      expect(isDocumentStore(null)).toBe(false);
      expect(isDocumentStore(undefined)).toBe(false);
      expect(isDocumentStore({})).toBe(false);
      expect(isDocumentStore({ subscribe: () => {} })).toBe(false);
    });
  });
});

// =============================================================================
// Immutability Tests
// =============================================================================

describe('Immutability', () => {
  it('should not allow direct state mutation', () => {
    const state = createInitialState();

    expect(() => {
      (state as { version: number }).version = 999;
    }).toThrow();
  });

  it('should not allow metadata mutation', () => {
    const state = createInitialState();

    expect(() => {
      (state.metadata as { isDirty: boolean }).isDirty = true;
    }).toThrow();
  });

  it('should not allow selection mutation', () => {
    const state = createInitialState();

    expect(() => {
      (state.selection.ranges as { anchor: ByteOffset; head: ByteOffset }[]).push({ anchor: byteOffset(5), head: byteOffset(5) });
    }).toThrow();
  });

  it('should not allow history stack mutation', () => {
    const state = createInitialState();

    expect(() => {
      (state.history.undoStack as unknown[]).push({});
    }).toThrow();
  });
});

// =============================================================================
// Store getSnapshot Identity Tests
// =============================================================================

describe('Store getSnapshot Identity', () => {
  it('should return same reference when state unchanged', () => {
    const store = createDocumentStore();

    const snapshot1 = store.getSnapshot();
    const snapshot2 = store.getSnapshot();

    expect(snapshot1).toBe(snapshot2);
  });

  it('should return different reference after state change', () => {
    const store = createDocumentStore();

    const snapshot1 = store.getSnapshot();
    store.dispatch(DocumentActions.insert(byteOffset(0), 'A'));
    const snapshot2 = store.getSnapshot();

    expect(snapshot1).not.toBe(snapshot2);
  });

  it('should return same reference for no-op actions', () => {
    const store = createDocumentStore();

    const snapshot1 = store.getSnapshot();
    store.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(0))); // No-op
    const snapshot2 = store.getSnapshot();

    expect(snapshot1).toBe(snapshot2);
  });

  it('getServerSnapshot should return same as getSnapshot', () => {
    const store = createDocumentStore({ content: 'Test' });

    expect(store.getServerSnapshot!()).toBe(store.getSnapshot());
  });
});
