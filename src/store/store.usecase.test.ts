/**
 * Editor use case tests for the Reed document store.
 * Tests simulate real-world editing scenarios and workflows.
 */

import { describe, it, expect, vi } from 'vitest';
import { createDocumentStore } from './features/store.ts';
import { DocumentActions } from './features/actions.ts';
import { byteOffset } from '../types/branded.ts';

describe('Editor Use Cases', () => {
  describe('Basic Text Editing', () => {
    it('should handle typing a sentence character by character', () => {
      const store = createDocumentStore();
      const text = 'Hello World';

      // Simulate typing each character
      for (let i = 0; i < text.length; i++) {
        store.dispatch(DocumentActions.insert(byteOffset(i), text[i]));
      }

      const state = store.getSnapshot();
      expect(state.pieceTable.totalLength).toBe(text.length);
      expect(state.version).toBe(text.length);
      expect(state.metadata.isDirty).toBe(true);
    });

    it('should handle typing with insertions at different positions', () => {
      const store = createDocumentStore({ content: 'Hello' });

      // Insert at end
      store.dispatch(DocumentActions.insert(byteOffset(5), ' World'));
      expect(store.getSnapshot().pieceTable.totalLength).toBe(11);

      // Insert at beginning
      store.dispatch(DocumentActions.insert(byteOffset(0), 'Say '));
      expect(store.getSnapshot().pieceTable.totalLength).toBe(15);

      // Insert in middle
      store.dispatch(DocumentActions.insert(byteOffset(9), ','));
      expect(store.getSnapshot().pieceTable.totalLength).toBe(16);
    });

    it('should handle backspace deletions', () => {
      const store = createDocumentStore({ content: 'Hello World' });

      // Simulate backspace at end (delete one character)
      store.dispatch(DocumentActions.delete(byteOffset(10), byteOffset(11))); // Delete 'd'
      expect(store.getSnapshot().pieceTable.totalLength).toBe(10);

      // Continue backspacing
      store.dispatch(DocumentActions.delete(byteOffset(9), byteOffset(10))); // Delete 'l'
      store.dispatch(DocumentActions.delete(byteOffset(8), byteOffset(9)));  // Delete 'r'
      expect(store.getSnapshot().pieceTable.totalLength).toBe(8);
    });

    it('should handle delete key (forward delete)', () => {
      const store = createDocumentStore({ content: 'Hello World' });

      // Delete at beginning
      store.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(1))); // Delete 'H'
      expect(store.getSnapshot().pieceTable.totalLength).toBe(10);
    });

    it('should handle selection replacement', () => {
      const store = createDocumentStore({ content: 'Hello World' });

      // Select "World" and replace with "Everyone"
      store.dispatch(DocumentActions.replace(byteOffset(6), byteOffset(11), 'Everyone'));
      expect(store.getSnapshot().pieceTable.totalLength).toBe(14); // "Hello Everyone"
    });
  });

  describe('Undo/Redo Workflows', () => {
    it('should undo a single insert operation', () => {
      const store = createDocumentStore({ content: '' });

      store.dispatch(DocumentActions.insert(byteOffset(0), 'Hello'));
      expect(store.getSnapshot().pieceTable.totalLength).toBe(5);

      store.dispatch(DocumentActions.undo());
      expect(store.getSnapshot().pieceTable.totalLength).toBe(0);
    });

    it('should redo an undone operation', () => {
      const store = createDocumentStore({ content: '' });

      store.dispatch(DocumentActions.insert(byteOffset(0), 'Hello'));
      store.dispatch(DocumentActions.undo());
      expect(store.getSnapshot().pieceTable.totalLength).toBe(0);

      store.dispatch(DocumentActions.redo());
      expect(store.getSnapshot().pieceTable.totalLength).toBe(5);
    });

    it('should handle undo/redo sequence for multiple edits', () => {
      const store = createDocumentStore({ content: '' });

      // Type sequence
      store.dispatch(DocumentActions.insert(byteOffset(0), 'A'));
      store.dispatch(DocumentActions.insert(byteOffset(1), 'B'));
      store.dispatch(DocumentActions.insert(byteOffset(2), 'C'));
      expect(store.getSnapshot().pieceTable.totalLength).toBe(3);

      // Undo all
      store.dispatch(DocumentActions.undo()); // Remove C
      expect(store.getSnapshot().pieceTable.totalLength).toBe(2);

      store.dispatch(DocumentActions.undo()); // Remove B
      expect(store.getSnapshot().pieceTable.totalLength).toBe(1);

      store.dispatch(DocumentActions.undo()); // Remove A
      expect(store.getSnapshot().pieceTable.totalLength).toBe(0);

      // Redo all
      store.dispatch(DocumentActions.redo());
      store.dispatch(DocumentActions.redo());
      store.dispatch(DocumentActions.redo());
      expect(store.getSnapshot().pieceTable.totalLength).toBe(3);
    });

    it('should clear redo stack when new edit is made after undo', () => {
      const store = createDocumentStore({ content: '' });

      store.dispatch(DocumentActions.insert(byteOffset(0), 'ABC'));
      store.dispatch(DocumentActions.undo());
      expect(store.getSnapshot().history.redoStack.length).toBe(1);

      // New edit should clear redo stack
      store.dispatch(DocumentActions.insert(byteOffset(0), 'X'));
      expect(store.getSnapshot().history.redoStack.length).toBe(0);
    });

    it('should do nothing when undoing with empty undo stack', () => {
      const store = createDocumentStore({ content: '' });

      const stateBefore = store.getSnapshot();
      store.dispatch(DocumentActions.undo());
      const stateAfter = store.getSnapshot();

      // State should be unchanged (same reference)
      expect(stateAfter).toBe(stateBefore);
    });

    it('should do nothing when redoing with empty redo stack', () => {
      const store = createDocumentStore({ content: '' });

      store.dispatch(DocumentActions.insert(byteOffset(0), 'Hello'));
      const stateBefore = store.getSnapshot();
      store.dispatch(DocumentActions.redo());
      const stateAfter = store.getSnapshot();

      // State should be unchanged (same reference)
      expect(stateAfter).toBe(stateBefore);
    });
  });

  describe('Selection Operations', () => {
    it('should set cursor position', () => {
      const store = createDocumentStore({ content: 'Hello World' });

      store.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(5), head: byteOffset(5) }]));

      const state = store.getSnapshot();
      expect(state.selection.ranges[0].anchor).toBe(5);
      expect(state.selection.ranges[0].head).toBe(5);
    });

    it('should set text selection range', () => {
      const store = createDocumentStore({ content: 'Hello World' });

      // Select "World"
      store.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(6), head: byteOffset(11) }]));

      const state = store.getSnapshot();
      expect(state.selection.ranges[0].anchor).toBe(6);
      expect(state.selection.ranges[0].head).toBe(11);
    });

    it('should support multiple cursors', () => {
      const store = createDocumentStore({ content: 'Hello World' });

      store.dispatch(DocumentActions.setSelection([
        { anchor: byteOffset(0), head: byteOffset(0) },
        { anchor: byteOffset(6), head: byteOffset(6) },
      ]));

      const state = store.getSnapshot();
      expect(state.selection.ranges.length).toBe(2);
      expect(state.selection.ranges[0].anchor).toBe(0);
      expect(state.selection.ranges[1].anchor).toBe(6);
    });
  });

  describe('Transaction Workflows', () => {
    it('should batch multiple operations as a single undo unit', () => {
      const store = createDocumentStore({ content: '' });

      // Batch insert "Hello World" as single transaction
      store.batch([
        DocumentActions.insert(byteOffset(0), 'Hello'),
        DocumentActions.insert(byteOffset(5), ' '),
        DocumentActions.insert(byteOffset(6), 'World'),
      ]);

      expect(store.getSnapshot().pieceTable.totalLength).toBe(11);
      expect(store.getSnapshot().history.undoStack.length).toBe(3);
    });

    it('should notify listeners only once for batched operations', () => {
      const store = createDocumentStore({ content: '' });
      const listener = vi.fn();
      store.subscribe(listener);

      store.batch([
        DocumentActions.insert(byteOffset(0), 'A'),
        DocumentActions.insert(byteOffset(1), 'B'),
        DocumentActions.insert(byteOffset(2), 'C'),
      ]);

      // Only one notification for the entire batch
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should rollback transaction on error', () => {
      const store = createDocumentStore({ content: 'Original' });
      const originalState = store.getSnapshot();

      // Start transaction manually
      store.dispatch(DocumentActions.transactionStart());
      store.dispatch(DocumentActions.insert(byteOffset(8), ' text'));

      // Rollback
      store.dispatch(DocumentActions.transactionRollback());

      expect(store.getSnapshot()).toBe(originalState);
    });

    it('should notify listeners on transaction rollback', () => {
      const store = createDocumentStore({ content: 'Original' });
      const listener = vi.fn();

      store.dispatch(DocumentActions.transactionStart());
      store.dispatch(DocumentActions.insert(byteOffset(8), ' text'));

      store.subscribe(listener);
      store.dispatch(DocumentActions.transactionRollback());

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should support nested transactions', () => {
      const store = createDocumentStore({ content: '' });
      const listener = vi.fn();
      store.subscribe(listener);

      // Outer transaction
      store.dispatch(DocumentActions.transactionStart());
      store.dispatch(DocumentActions.insert(byteOffset(0), 'A'));

      // Inner transaction
      store.dispatch(DocumentActions.transactionStart());
      store.dispatch(DocumentActions.insert(byteOffset(1), 'B'));
      store.dispatch(DocumentActions.transactionCommit()); // Inner commit (no notification)

      expect(listener).not.toHaveBeenCalled();

      store.dispatch(DocumentActions.insert(byteOffset(2), 'C'));
      store.dispatch(DocumentActions.transactionCommit()); // Outer commit (notification)

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should rollback only inner transaction in nested transactions', () => {
      const store = createDocumentStore({ content: '' });

      // Outer transaction
      store.dispatch(DocumentActions.transactionStart());
      store.dispatch(DocumentActions.insert(byteOffset(0), 'A'));

      // Inner transaction
      store.dispatch(DocumentActions.transactionStart());
      store.dispatch(DocumentActions.insert(byteOffset(1), 'B'));

      // Rollback inner only — should keep 'A'
      store.dispatch(DocumentActions.transactionRollback());
      expect(store.getSnapshot().pieceTable.totalLength).toBe(1);

      // Commit outer
      store.dispatch(DocumentActions.transactionCommit());
      expect(store.getSnapshot().pieceTable.totalLength).toBe(1);
    });
  });

  describe('Multiline Editing', () => {
    it('should track line count after inserting newlines', () => {
      const store = createDocumentStore({ content: '' });

      store.dispatch(DocumentActions.insert(byteOffset(0), 'Line 1\nLine 2\nLine 3'));

      const state = store.getSnapshot();
      expect(state.lineIndex.lineCount).toBe(3);
    });

    it('should update line count after inserting more lines', () => {
      const store = createDocumentStore({ content: 'Line 1' });
      expect(store.getSnapshot().lineIndex.lineCount).toBe(1);

      store.dispatch(DocumentActions.insert(byteOffset(6), '\nLine 2'));
      expect(store.getSnapshot().lineIndex.lineCount).toBe(2);
    });
  });

  describe('Large Document Editing', () => {
    it('should handle many rapid insertions', () => {
      const store = createDocumentStore({ content: '' });
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        store.dispatch(DocumentActions.insert(byteOffset(i), 'x'));
      }

      expect(store.getSnapshot().pieceTable.totalLength).toBe(iterations);
      expect(store.getSnapshot().version).toBe(iterations);
    });

    it('should handle batch insert efficiently', () => {
      const store = createDocumentStore({ content: '' });
      const actions = [];

      for (let i = 0; i < 100; i++) {
        actions.push(DocumentActions.insert(byteOffset(i), String(i % 10)));
      }

      store.batch(actions);

      expect(store.getSnapshot().pieceTable.totalLength).toBe(100);
    });
  });

  describe('Subscriber Notifications', () => {
    it('should notify all subscribers on state change', () => {
      const store = createDocumentStore({ content: '' });
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      store.subscribe(listener1);
      store.subscribe(listener2);

      store.dispatch(DocumentActions.insert(byteOffset(0), 'A'));

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('should not notify after unsubscribe', () => {
      const store = createDocumentStore({ content: '' });
      const listener = vi.fn();

      const unsubscribe = store.subscribe(listener);
      store.dispatch(DocumentActions.insert(byteOffset(0), 'A'));
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      store.dispatch(DocumentActions.insert(byteOffset(1), 'B'));
      expect(listener).toHaveBeenCalledTimes(1); // Still 1, not notified
    });

    it('should not notify when state does not change', () => {
      const store = createDocumentStore({ content: '' });
      const listener = vi.fn();
      store.subscribe(listener);

      // Delete with empty range (no-op)
      store.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(0)));

      expect(listener).not.toHaveBeenCalled();
    });

    it('should handle listener errors gracefully', () => {
      const store = createDocumentStore({ content: '' });
      const errorListener = vi.fn(() => {
        throw new Error('Listener error');
      });
      const normalListener = vi.fn();

      store.subscribe(errorListener);
      store.subscribe(normalListener);

      // Should not throw, and second listener should still be called
      expect(() => {
        store.dispatch(DocumentActions.insert(byteOffset(0), 'A'));
      }).not.toThrow();

      expect(normalListener).toHaveBeenCalled();
    });
  });

  describe('Real World Scenarios', () => {
    it('should simulate typing, selecting, and deleting', () => {
      const store = createDocumentStore({ content: '' });

      // Type "Hello World"
      store.dispatch(DocumentActions.insert(byteOffset(0), 'Hello World'));

      // Select "World" (positions 6-11)
      store.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(6), head: byteOffset(11) }]));

      // Delete selection (simulating backspace/delete with selection)
      store.dispatch(DocumentActions.delete(byteOffset(6), byteOffset(11)));

      expect(store.getSnapshot().pieceTable.totalLength).toBe(6); // "Hello "
    });

    it('should simulate find and replace', () => {
      const store = createDocumentStore({ content: 'foo bar foo baz foo' });

      // Replace first "foo" with "qux"
      store.dispatch(DocumentActions.replace(byteOffset(0), byteOffset(3), 'qux'));
      expect(store.getSnapshot().pieceTable.totalLength).toBe(19);

      // Replace second "foo" (now at position 8)
      store.dispatch(DocumentActions.replace(byteOffset(8), byteOffset(11), 'qux'));

      // Replace third "foo" (now at position 16)
      store.dispatch(DocumentActions.replace(byteOffset(16), byteOffset(19), 'qux'));
    });

    it('should simulate code editing with auto-indent', () => {
      const store = createDocumentStore({ content: '' });

      // Type function definition
      store.dispatch(DocumentActions.insert(byteOffset(0), 'function foo() {\n'));
      store.dispatch(DocumentActions.insert(byteOffset(17), '  return 42;\n'));
      store.dispatch(DocumentActions.insert(byteOffset(30), '}'));

      const state = store.getSnapshot();
      expect(state.lineIndex.lineCount).toBe(3);
    });
  });
});
