/**
 * Editor use case tests for the Reed document store.
 * Tests simulate real-world editing scenarios and workflows.
 */

import { describe, it, expect, vi } from 'vitest';
import { createDocumentStore } from './store.ts';
import { DocumentActions } from './actions.ts';
import { byteOffset } from '../../types/branded.ts';
import { rebuildLineIndex, getLineStartOffset, getCharStartOffset } from '../core/line-index.ts';
import { getText } from '../core/piece-table.ts';

function createDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function charIndexToByteOffset(text: string, charIndex: number): number {
  if (charIndex <= 0) return 0;
  if (charIndex >= text.length) return new TextEncoder().encode(text).length;
  return new TextEncoder().encode(text.slice(0, charIndex)).length;
}

function codePointIndexToCharIndex(text: string, codePointIndex: number): number {
  if (codePointIndex <= 0) return 0;
  let cp = 0;
  let charIndex = 0;
  while (charIndex < text.length && cp < codePointIndex) {
    const code = text.codePointAt(charIndex);
    charIndex += code !== undefined && code > 0xFFFF ? 2 : 1;
    cp++;
  }
  return charIndex;
}

function assertLineIndexMatchesRebuild(store: ReturnType<typeof createDocumentStore>, expectedContent?: string): void {
  const reconciled = store.reconcileNow();
  const content = getText(
    reconciled.pieceTable,
    byteOffset(0),
    byteOffset(reconciled.pieceTable.totalLength)
  );
  if (expectedContent !== undefined) {
    expect(content).toBe(expectedContent);
  }
  const rebuilt = rebuildLineIndex(content);

  expect(reconciled.lineIndex.lineCount).toBe(rebuilt.lineCount);
  for (let line = 0; line < rebuilt.lineCount; line++) {
    expect(getLineStartOffset(reconciled.lineIndex.root, line)).toBe(
      getLineStartOffset(rebuilt.root, line)
    );
  }
}

function assertLineAndCharOffsetsMatchRebuild(
  store: ReturnType<typeof createDocumentStore>,
  expectedContent?: string
): void {
  const reconciled = store.reconcileNow();
  const content = getText(
    reconciled.pieceTable,
    byteOffset(0),
    byteOffset(reconciled.pieceTable.totalLength)
  );
  if (expectedContent !== undefined) {
    expect(content).toBe(expectedContent);
  }
  const rebuilt = rebuildLineIndex(content);

  expect(reconciled.lineIndex.lineCount).toBe(rebuilt.lineCount);
  for (let line = 0; line < rebuilt.lineCount; line++) {
    expect(getLineStartOffset(reconciled.lineIndex.root, line)).toBe(
      getLineStartOffset(rebuilt.root, line)
    );
    expect(getCharStartOffset(reconciled.lineIndex.root, line)).toBe(
      getCharStartOffset(rebuilt.root, line)
    );
  }
}

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
    it('should batch multiple operations while keeping per-action history entries', () => {
      const store = createDocumentStore({ content: '' });

      // Batch insert "Hello World" as a single transaction notification boundary.
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

    it('should schedule reconciliation after outermost transaction commit when pending', () => {
      const g = globalThis as {
        requestIdleCallback?: (callback: () => void) => number;
        cancelIdleCallback?: (id: number) => void;
      };
      const originalRequestIdleCallback = g.requestIdleCallback;
      const originalCancelIdleCallback = g.cancelIdleCallback;
      const scheduledCallbacks: Array<() => void> = [];

      g.requestIdleCallback = (callback: () => void): number => {
        scheduledCallbacks.push(callback);
        return scheduledCallbacks.length;
      };
      g.cancelIdleCallback = (): void => {
        // noop for test
      };

      try {
        const store = createDocumentStore({ content: '' });

        store.dispatch(DocumentActions.transactionStart());
        store.dispatch(DocumentActions.insert(byteOffset(0), 'A\nB\nC'));
        expect(store.getSnapshot().lineIndex.rebuildPending).toBe(true);
        expect(scheduledCallbacks).toHaveLength(0);

        store.dispatch(DocumentActions.transactionCommit());
        expect(scheduledCallbacks).toHaveLength(1);
      } finally {
        g.requestIdleCallback = originalRequestIdleCallback;
        g.cancelIdleCallback = originalCancelIdleCallback;
      }
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

    it('should keep line count when deleting only CR from a CRLF separator', () => {
      const store = createDocumentStore({ content: 'A\r\nB' });
      expect(store.getSnapshot().lineIndex.lineCount).toBe(2);

      store.dispatch(DocumentActions.delete(byteOffset(1), byteOffset(2)));
      expect(store.getSnapshot().lineIndex.lineCount).toBe(2);
    });

    it('should keep line count when deleting only LF from a CRLF separator', () => {
      const store = createDocumentStore({ content: 'A\r\nB' });
      expect(store.getSnapshot().lineIndex.lineCount).toBe(2);

      store.dispatch(DocumentActions.delete(byteOffset(2), byteOffset(3)));
      expect(store.getSnapshot().lineIndex.lineCount).toBe(2);
    });

    it('should keep line count when inserting CR before an existing LF separator', () => {
      const store = createDocumentStore({ content: 'A\nB' });
      expect(store.getSnapshot().lineIndex.lineCount).toBe(2);

      store.dispatch(DocumentActions.insert(byteOffset(1), '\r'));
      expect(store.getSnapshot().lineIndex.lineCount).toBe(2);
    });

    it('should keep line count when inserting LF after an existing CR separator', () => {
      const store = createDocumentStore({ content: 'A\rB' });
      expect(store.getSnapshot().lineIndex.lineCount).toBe(2);

      store.dispatch(DocumentActions.insert(byteOffset(2), '\n'));
      expect(store.getSnapshot().lineIndex.lineCount).toBe(2);
    });

    it('should keep line index accurate when inserting CRLF inside an existing CRLF pair', () => {
      const store = createDocumentStore({ content: '\r\n\r' });
      store.dispatch(DocumentActions.insert(byteOffset(1), '\r\n'));
      assertLineIndexMatchesRebuild(store, '\r\r\n\n\r');
    });

    it('should keep line index accurate when deleting LF from CRLF plus following character', () => {
      const store = createDocumentStore({ content: 'a\n\n\r\na\r\n' });
      store.dispatch(DocumentActions.delete(byteOffset(4), byteOffset(6)));
      assertLineIndexMatchesRebuild(store, 'a\n\n\r\r\n');
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

    it('should keep line index consistent after many rapid multiline edits', () => {
      const initialContent = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join('\n');
      const store = createDocumentStore({ content: initialContent });

      // Simulate rapid multiline typing near document start.
      for (let i = 0; i < 50; i++) {
        store.dispatch(DocumentActions.insert(byteOffset(0), `X${i}\n`));
      }

      // Reconcile an active viewport first, then force full reconciliation.
      store.setViewport(25, 40);
      const reconciled = store.reconcileNow();

      const content = getText(
        reconciled.pieceTable,
        byteOffset(0),
        byteOffset(reconciled.pieceTable.totalLength)
      );
      const rebuilt = rebuildLineIndex(content);

      expect(reconciled.lineIndex.lineCount).toBe(rebuilt.lineCount);

      for (let line = 0; line < rebuilt.lineCount; line++) {
        expect(getLineStartOffset(reconciled.lineIndex.root, line)).toBe(
          getLineStartOffset(rebuilt.root, line)
        );
      }
    });

    it('should keep line index consistent after rapid mixed edits and viewport updates', () => {
      const initialContent = Array.from({ length: 60 }, (_, i) => `L${i}`).join('\n');
      const store = createDocumentStore({ content: initialContent });
      let model = initialContent;
      const rng = createDeterministicRng(0xC0FFEE);
      const pool = ['x', 'yz', '\n', 'a\nb', '\n\n', 'END\n'];

      for (let i = 0; i < 400; i++) {
        const op = randomInt(rng, 0, 2);

        if (op === 0 || model.length === 0) {
          const pos = randomInt(rng, 0, model.length);
          const text = pool[randomInt(rng, 0, pool.length - 1)];
          store.dispatch(DocumentActions.insert(byteOffset(pos), text));
          model = model.slice(0, pos) + text + model.slice(pos);
        } else if (op === 1) {
          const start = randomInt(rng, 0, model.length - 1);
          const end = randomInt(rng, start + 1, model.length);
          store.dispatch(DocumentActions.delete(byteOffset(start), byteOffset(end)));
          model = model.slice(0, start) + model.slice(end);
        } else {
          const start = randomInt(rng, 0, model.length - 1);
          const end = randomInt(rng, start + 1, model.length);
          const text = pool[randomInt(rng, 0, pool.length - 1)];
          store.dispatch(DocumentActions.replace(byteOffset(start), byteOffset(end), text));
          model = model.slice(0, start) + text + model.slice(end);
        }

        if (randomInt(rng, 0, 4) === 0) {
          const lineCount = model.split('\n').length;
          const startLine = randomInt(rng, -5, lineCount + 5);
          const endLine = randomInt(rng, -5, lineCount + 5);
          store.setViewport(startLine, endLine);
        }
      }

      assertLineIndexMatchesRebuild(store, model);
    });

    it('should keep pending reconciliation stable with reversed and negative viewports', () => {
      const initialContent = Array.from({ length: 80 }, (_, i) => `Line ${i}`).join('\n');
      const store = createDocumentStore({ content: initialContent });

      for (let i = 0; i < 40; i++) {
        store.dispatch(DocumentActions.insert(byteOffset(0), `X${i}\n`));
      }
      expect(store.getSnapshot().lineIndex.rebuildPending).toBe(true);

      store.setViewport(70, 20); // Reversed bounds
      store.setViewport(-10, 5); // Negative start
      expect(store.getSnapshot().lineIndex.rebuildPending).toBe(true);

      assertLineIndexMatchesRebuild(store);
    });

    it('should preserve line index through rapid multiline edits with full undo/redo', () => {
      const initialContent = Array.from({ length: 25 }, (_, i) => `Base ${i}`).join('\n');
      const store = createDocumentStore({ content: initialContent });
      let model = initialContent;
      const rng = createDeterministicRng(0xA11CE);
      const pool = ['x', 'yy', '\n', 'm\nn', '\n\n', 'tail\n'];
      let editCount = 0;

      for (let i = 0; i < 250; i++) {
        const op = randomInt(rng, 0, 2);

        if (op === 0 || model.length === 0) {
          const pos = randomInt(rng, 0, model.length);
          const text = pool[randomInt(rng, 0, pool.length - 1)];
          store.dispatch(DocumentActions.insert(byteOffset(pos), text));
          model = model.slice(0, pos) + text + model.slice(pos);
          editCount++;
        } else if (op === 1) {
          const start = randomInt(rng, 0, model.length - 1);
          const end = randomInt(rng, start + 1, model.length);
          store.dispatch(DocumentActions.delete(byteOffset(start), byteOffset(end)));
          model = model.slice(0, start) + model.slice(end);
          editCount++;
        } else {
          const start = randomInt(rng, 0, model.length - 1);
          const end = randomInt(rng, start + 1, model.length);
          const text = pool[randomInt(rng, 0, pool.length - 1)];
          store.dispatch(DocumentActions.replace(byteOffset(start), byteOffset(end), text));
          model = model.slice(0, start) + text + model.slice(end);
          editCount++;
        }

        if (i % 9 === 0) {
          const lineCount = model.split('\n').length;
          const startLine = randomInt(rng, 0, Math.max(0, lineCount - 1));
          const endLine = randomInt(rng, startLine, Math.max(startLine, lineCount - 1));
          store.setViewport(startLine, endLine);
        }
      }

      const editedContent = model;
      assertLineIndexMatchesRebuild(store, editedContent);

      for (let i = 0; i < editCount; i++) {
        store.dispatch(DocumentActions.undo());
      }
      assertLineIndexMatchesRebuild(store, initialContent);

      for (let i = 0; i < editCount; i++) {
        store.dispatch(DocumentActions.redo());
      }
      assertLineIndexMatchesRebuild(store, editedContent);
    });

    it('should stay line-index correct across multiple randomized edit seeds', () => {
      const seeds = [1, 7, 13, 21, 42, 84, 123, 256, 512, 1024];
      const pool = ['a', 'bb', '\n', 'p\nq', '\n\n', 'tail\n'];

      for (const seed of seeds) {
        const initialContent = Array.from({ length: 18 }, (_, i) => `S${seed}-L${i}`).join('\n');
        const store = createDocumentStore({ content: initialContent });
        let model = initialContent;
        const rng = createDeterministicRng(seed);

        for (let i = 0; i < 180; i++) {
          const op = randomInt(rng, 0, 2);

          if (op === 0 || model.length === 0) {
            const pos = randomInt(rng, 0, model.length);
            const text = pool[randomInt(rng, 0, pool.length - 1)];
            store.dispatch(DocumentActions.insert(byteOffset(pos), text));
            model = model.slice(0, pos) + text + model.slice(pos);
          } else if (op === 1) {
            const start = randomInt(rng, 0, model.length - 1);
            const end = randomInt(rng, start + 1, model.length);
            store.dispatch(DocumentActions.delete(byteOffset(start), byteOffset(end)));
            model = model.slice(0, start) + model.slice(end);
          } else {
            const start = randomInt(rng, 0, model.length - 1);
            const end = randomInt(rng, start + 1, model.length);
            const text = pool[randomInt(rng, 0, pool.length - 1)];
            store.dispatch(DocumentActions.replace(byteOffset(start), byteOffset(end), text));
            model = model.slice(0, start) + text + model.slice(end);
          }

          if (randomInt(rng, 0, 3) === 0) {
            const lineCount = model.split('\n').length;
            const startLine = randomInt(rng, -4, lineCount + 4);
            const endLine = randomInt(rng, -4, lineCount + 4);
            store.setViewport(startLine, endLine);
          }
        }

        assertLineIndexMatchesRebuild(store, model);
      }
    });

    it('should stay line-index correct across randomized mixed line endings', () => {
      const seeds = [3, 9, 27, 81, 243, 511, 997, 2027, 4093, 8191];
      const pool = ['x', 'yy', '\n', '\r', '\r\n', 'a\r', '\nb', 'c\r\nd', '\r\n\r'];

      for (const seed of seeds) {
        const initialContent = Array.from({ length: 10 }, (_, i) => `R${seed}-${i}`).join('\n');
        const store = createDocumentStore({ content: initialContent });
        let model = initialContent;
        const rng = createDeterministicRng(seed * 97);
        let opDesc = 'init';

        for (let i = 0; i < 220; i++) {
          const op = randomInt(rng, 0, 2);

          if (op === 0 || model.length === 0) {
            const pos = randomInt(rng, 0, model.length);
            const text = pool[randomInt(rng, 0, pool.length - 1)];
            opDesc = `insert pos=${pos} text=${JSON.stringify(text)}`;
            store.dispatch(DocumentActions.insert(byteOffset(pos), text));
            model = model.slice(0, pos) + text + model.slice(pos);
          } else if (op === 1) {
            const start = randomInt(rng, 0, model.length - 1);
            const end = randomInt(rng, start + 1, model.length);
            opDesc = `delete start=${start} end=${end} text=${JSON.stringify(model.slice(start, end))}`;
            store.dispatch(DocumentActions.delete(byteOffset(start), byteOffset(end)));
            model = model.slice(0, start) + model.slice(end);
          } else {
            const start = randomInt(rng, 0, model.length - 1);
            const end = randomInt(rng, start + 1, model.length);
            const text = pool[randomInt(rng, 0, pool.length - 1)];
            opDesc = `replace start=${start} end=${end} text=${JSON.stringify(text)}`;
            store.dispatch(DocumentActions.replace(byteOffset(start), byteOffset(end), text));
            model = model.slice(0, start) + text + model.slice(end);
          }

          if (randomInt(rng, 0, 2) === 0) {
            const lineCount = model.split(/\r\n|\r|\n/).length;
            const startLine = randomInt(rng, -3, lineCount + 3);
            const endLine = randomInt(rng, -3, lineCount + 3);
            opDesc += ` viewport=${startLine}-${endLine}`;
            store.setViewport(startLine, endLine);
          }

          const reconciled = store.reconcileNow();
          const content = getText(
            reconciled.pieceTable,
            byteOffset(0),
            byteOffset(reconciled.pieceTable.totalLength)
          );
          if (content !== model) {
            throw new Error(
              `mixed-line-ending seed=${seed} step=${i} op=${opDesc} content-mismatch expected=${JSON.stringify(model)} actual=${JSON.stringify(content)}`
            );
          }

          const rebuilt = rebuildLineIndex(content);
          if (reconciled.lineIndex.lineCount !== rebuilt.lineCount) {
            throw new Error(
              `mixed-line-ending seed=${seed} step=${i} op=${opDesc} model=${JSON.stringify(model)} lineCount actual=${reconciled.lineIndex.lineCount} expected=${rebuilt.lineCount}`
            );
          }

          for (let line = 0; line < rebuilt.lineCount; line++) {
            const actual = getLineStartOffset(reconciled.lineIndex.root, line);
            const expected = getLineStartOffset(rebuilt.root, line);
            if (actual !== expected) {
              throw new Error(
                `mixed-line-ending seed=${seed} step=${i} op=${opDesc} model=${JSON.stringify(model)} line=${line} offset actual=${actual} expected=${expected}`
              );
            }
          }
        }

        try {
          assertLineIndexMatchesRebuild(store, model);
        } catch (error) {
          throw new Error(
            `mixed-line-ending seed=${seed} modelLength=${model.length}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    });

    it('should stay line and char offset correct across randomized unicode and mixed line endings', () => {
      const seeds = [5, 17, 29];
      const pool = [
        'x',
        'é',
        '中',
        '😀',
        '\n',
        '\r',
        '\r\n',
        '中\n😀',
        '😀\r\n',
        '\n中',
        'é\r',
      ];

      for (const seed of seeds) {
        const initialContent = `S${seed}\nπ\n終`;
        const store = createDocumentStore({ content: initialContent });
        let model = initialContent;
        const rng = createDeterministicRng(seed * 131);

        for (let i = 0; i < 180; i++) {
          const op = randomInt(rng, 0, 2);
          const cpLen = Array.from(model).length;

          if (op === 0 || cpLen === 0) {
            const cpPos = randomInt(rng, 0, cpLen);
            const charPos = codePointIndexToCharIndex(model, cpPos);
            const text = pool[randomInt(rng, 0, pool.length - 1)];
            const pos = charIndexToByteOffset(model, charPos);
            store.dispatch(DocumentActions.insert(byteOffset(pos), text));
            model = model.slice(0, charPos) + text + model.slice(charPos);
          } else if (op === 1) {
            const startCp = randomInt(rng, 0, cpLen - 1);
            const endCp = randomInt(rng, startCp + 1, cpLen);
            const startChar = codePointIndexToCharIndex(model, startCp);
            const endChar = codePointIndexToCharIndex(model, endCp);
            const start = charIndexToByteOffset(model, startChar);
            const end = charIndexToByteOffset(model, endChar);
            store.dispatch(DocumentActions.delete(byteOffset(start), byteOffset(end)));
            model = model.slice(0, startChar) + model.slice(endChar);
          } else {
            const startCp = randomInt(rng, 0, cpLen - 1);
            const endCp = randomInt(rng, startCp + 1, cpLen);
            const startChar = codePointIndexToCharIndex(model, startCp);
            const endChar = codePointIndexToCharIndex(model, endCp);
            const text = pool[randomInt(rng, 0, pool.length - 1)];
            const start = charIndexToByteOffset(model, startChar);
            const end = charIndexToByteOffset(model, endChar);
            store.dispatch(DocumentActions.replace(byteOffset(start), byteOffset(end), text));
            model = model.slice(0, startChar) + text + model.slice(endChar);
          }

          if (randomInt(rng, 0, 2) === 0) {
            const lineCount = model.split(/\r\n|\r|\n/).length;
            const startLine = randomInt(rng, -5, lineCount + 5);
            const endLine = randomInt(rng, -5, lineCount + 5);
            store.setViewport(startLine, endLine);
          }

          assertLineAndCharOffsetsMatchRebuild(store, model);
        }
      }
    });

    it('should keep reconciliation stable across randomized APPLY_REMOTE changes', () => {
      const seeds = [11, 33, 77, 143];
      const pool = ['x', 'yy', '\n', '\r', '\r\n', 'p\r', '\nq', 'r\r\ns'];

      for (const seed of seeds) {
        const initialContent = Array.from({ length: 12 }, (_, i) => `R${seed}-${i}`).join('\n');
        const store = createDocumentStore({ content: initialContent });
        let model = initialContent;
        const rng = createDeterministicRng(seed * 313);

        for (let i = 0; i < 160; i++) {
          const changeCount = randomInt(rng, 1, 3);
          const changes: Array<
            { type: 'insert'; start: number; text: string } |
            { type: 'delete'; start: number; length: number }
          > = [];

          for (let c = 0; c < changeCount; c++) {
            const op = randomInt(rng, 0, 1);
            if (op === 0 || model.length === 0) {
              const pos = randomInt(rng, 0, model.length);
              const text = pool[randomInt(rng, 0, pool.length - 1)];
              changes.push({ type: 'insert', start: pos, text });
              model = model.slice(0, pos) + text + model.slice(pos);
            } else {
              const start = randomInt(rng, 0, model.length - 1);
              const end = randomInt(rng, start + 1, model.length);
              changes.push({ type: 'delete', start, length: end - start });
              model = model.slice(0, start) + model.slice(end);
            }
          }

          store.dispatch(DocumentActions.applyRemote(
            changes.map(change => change.type === 'insert'
              ? { type: 'insert' as const, start: byteOffset(change.start), text: change.text }
              : { type: 'delete' as const, start: byteOffset(change.start), length: change.length })
          ));

          if (randomInt(rng, 0, 2) === 0) {
            const lineCount = model.split(/\r\n|\r|\n/).length;
            const mode = randomInt(rng, 0, 2);
            if (mode === 0) {
              store.setViewport(-20, lineCount + 20);
            } else if (mode === 1) {
              store.setViewport(Number.NaN, Number.POSITIVE_INFINITY);
            } else {
              const startLine = randomInt(rng, -6, lineCount + 6);
              const endLine = randomInt(rng, -6, lineCount + 6);
              store.setViewport(startLine, endLine);
            }
          }

          assertLineIndexMatchesRebuild(store, model);
        }
      }
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
