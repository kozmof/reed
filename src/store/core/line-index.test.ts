/**
 * Tests for line index operations.
 */

import { describe, it, expect } from 'vitest';
import {
  lineIndexInsert,
  lineIndexDelete,
  findLineAtPosition,
  findLineByNumber,
  getLineStartOffset,
  getLineRange,
  getLineCountFromIndex,
  collectLines,
  rebuildLineIndex,
  lineIndexInsertLazy,
  lineIndexDeleteLazy,
  reconcileFull,
  reconcileRange,
  reconcileViewport,
  mergeDirtyRanges,
} from './line-index.ts';
import { createLineIndexState, createEmptyLineIndexState, withLineIndexState } from './state.ts';
import { byteOffset } from '../../types/branded.ts';

describe('Line Index Operations', () => {
  describe('rebuildLineIndex', () => {
    it('should create index for empty content', () => {
      const state = rebuildLineIndex('');
      expect(getLineCountFromIndex(state)).toBe(1);
    });

    it('should create index for single line', () => {
      const state = rebuildLineIndex('Hello');
      expect(getLineCountFromIndex(state)).toBe(1);
    });

    it('should create index for multiple lines', () => {
      const state = rebuildLineIndex('Line 1\nLine 2\nLine 3');
      expect(getLineCountFromIndex(state)).toBe(3);
    });

    it('should handle trailing newline', () => {
      const state = rebuildLineIndex('Line 1\n');
      expect(getLineCountFromIndex(state)).toBe(2);
    });

    it('should handle consecutive CRLF line endings', () => {
      const state = rebuildLineIndex('\r\n\r\n');
      expect(getLineCountFromIndex(state)).toBe(3);
    });
  });

  describe('findLineAtPosition', () => {
    it('should find zero-length sentinel for empty state', () => {
      const state = createEmptyLineIndexState();
      const location = findLineAtPosition(state.root, byteOffset(0));
      expect(location).not.toBeNull();
      expect(location!.lineNumber).toBe(0);
      expect(location!.offsetInLine).toBe(0);
    });

    it('should find line at position 0', () => {
      const state = createLineIndexState('Hello\nWorld');
      const location = findLineAtPosition(state.root, byteOffset(0));
      expect(location).not.toBeNull();
      expect(location!.lineNumber).toBe(0);
      expect(location!.offsetInLine).toBe(0);
    });

    it('should find correct line for position in first line', () => {
      const state = createLineIndexState('Hello\nWorld');
      const location = findLineAtPosition(state.root, byteOffset(3));
      expect(location).not.toBeNull();
      expect(location!.lineNumber).toBe(0);
      expect(location!.offsetInLine).toBe(3);
    });

    it('should find correct line for position in second line', () => {
      const state = createLineIndexState('Hello\nWorld');
      const location = findLineAtPosition(state.root, byteOffset(7));
      expect(location).not.toBeNull();
      expect(location!.lineNumber).toBe(1);
      expect(location!.offsetInLine).toBe(1);
    });

    it('should handle position at newline', () => {
      const state = createLineIndexState('Hello\nWorld');
      const location = findLineAtPosition(state.root, byteOffset(5));
      expect(location).not.toBeNull();
      expect(location!.lineNumber).toBe(0);
      expect(location!.offsetInLine).toBe(5);
    });
  });

  describe('findLineByNumber', () => {
    it('should find zero-length sentinel for empty state', () => {
      const state = createEmptyLineIndexState();
      const node = findLineByNumber(state.root, 0);
      expect(node).not.toBeNull();
      expect(node!.lineLength).toBe(0);
    });

    it('should find first line', () => {
      const state = createLineIndexState('Hello\nWorld\n!');
      const node = findLineByNumber(state.root, 0);
      expect(node).not.toBeNull();
      expect(node!.lineLength).toBe(6); // "Hello\n"
    });

    it('should find middle line', () => {
      const state = createLineIndexState('Hello\nWorld\n!');
      const node = findLineByNumber(state.root, 1);
      expect(node).not.toBeNull();
      expect(node!.lineLength).toBe(6); // "World\n"
    });

    it('should find last line', () => {
      const state = createLineIndexState('Hello\nWorld\n!');
      const node = findLineByNumber(state.root, 2);
      expect(node).not.toBeNull();
      expect(node!.lineLength).toBe(1); // "!"
    });

    it('should return null for out of bounds', () => {
      const state = createLineIndexState('Hello\nWorld');
      expect(findLineByNumber(state.root, 5)).toBeNull();
      expect(findLineByNumber(state.root, -1)).toBeNull();
    });
  });

  describe('getLineStartOffset', () => {
    it('should return 0 for first line', () => {
      const state = createLineIndexState('Hello\nWorld');
      expect(getLineStartOffset(state.root, 0)).toBe(0);
    });

    it('should return correct offset for second line', () => {
      const state = createLineIndexState('Hello\nWorld');
      expect(getLineStartOffset(state.root, 1)).toBe(6);
    });

    it('should return correct offset for multiple lines', () => {
      const state = createLineIndexState('Line 1\nLine 2\nLine 3');
      expect(getLineStartOffset(state.root, 0)).toBe(0);
      expect(getLineStartOffset(state.root, 1)).toBe(7);
      expect(getLineStartOffset(state.root, 2)).toBe(14);
    });
  });

  describe('getLineRange', () => {
    it('should return zero-length range for empty state', () => {
      const state = createEmptyLineIndexState();
      const range = getLineRange(state, 0);
      expect(range).toEqual({ start: 0, length: 0 });
    });

    it('should return correct range for first line', () => {
      const state = createLineIndexState('Hello\nWorld');
      const range = getLineRange(state, 0);
      expect(range).toEqual({ start: 0, length: 6 });
    });

    it('should return correct range for second line', () => {
      const state = createLineIndexState('Hello\nWorld');
      const range = getLineRange(state, 1);
      expect(range).toEqual({ start: 6, length: 5 });
    });
  });

  describe('collectLines', () => {
    it('should return sentinel node for empty state', () => {
      const state = createEmptyLineIndexState();
      const lines = collectLines(state.root);
      expect(lines.length).toBe(1);
      expect(lines[0].lineLength).toBe(0);
    });

    it('should collect all lines in order', () => {
      const state = createLineIndexState('A\nB\nC');
      const lines = collectLines(state.root);
      expect(lines.length).toBe(3);
      expect(lines[0].lineLength).toBe(2); // "A\n"
      expect(lines[1].lineLength).toBe(2); // "B\n"
      expect(lines[2].lineLength).toBe(1); // "C"
    });
  });

  describe('lineIndexInsert', () => {
    it('should handle insert without newlines', () => {
      const state = createLineIndexState('Hello');
      const newState = lineIndexInsert(state, byteOffset(5), ' World');
      expect(getLineCountFromIndex(newState)).toBe(1);
    });

    it('should handle insert with newline at end', () => {
      const state = createLineIndexState('Hello');
      const newState = lineIndexInsert(state, byteOffset(5), '\nWorld');
      expect(getLineCountFromIndex(newState)).toBe(2);
    });

    it('should handle insert with newline in middle', () => {
      const state = createLineIndexState('HelloWorld');
      const newState = lineIndexInsert(state, byteOffset(5), '\n');
      expect(getLineCountFromIndex(newState)).toBe(2);
    });

    it('should handle insert with multiple newlines', () => {
      const state = createLineIndexState('A');
      const newState = lineIndexInsert(state, byteOffset(1), '\nB\nC');
      expect(getLineCountFromIndex(newState)).toBe(3);
    });

    it('should handle insert into empty state', () => {
      const state = createEmptyLineIndexState();
      const newState = lineIndexInsert(state, byteOffset(0), 'Hello');
      expect(getLineCountFromIndex(newState)).toBe(1);
    });

    it('should handle insert newlines into empty state', () => {
      const state = createEmptyLineIndexState();
      const newState = lineIndexInsert(state, byteOffset(0), 'A\nB\nC');
      expect(getLineCountFromIndex(newState)).toBe(3);
    });
  });

  describe('lineIndexDelete', () => {
    it('should handle delete without newlines', () => {
      const state = createLineIndexState('Hello World');
      const newState = lineIndexDelete(state, byteOffset(5), byteOffset(11), ' World');
      expect(getLineCountFromIndex(newState)).toBe(1);
    });

    it('should handle delete newline (merge lines)', () => {
      const state = createLineIndexState('Hello\nWorld');
      const newState = lineIndexDelete(state, byteOffset(5), byteOffset(6), '\n');
      expect(getLineCountFromIndex(newState)).toBe(1);
    });

    it('should handle delete multiple lines', () => {
      const state = createLineIndexState('A\nB\nC\nD');
      const newState = lineIndexDelete(state, byteOffset(2), byteOffset(6), 'B\nC\n');
      expect(getLineCountFromIndex(newState)).toBe(2);
    });

    it('should handle delete entire content', () => {
      const state = createLineIndexState('Hello\nWorld');
      const newState = lineIndexDelete(state, byteOffset(0), byteOffset(11), 'Hello\nWorld');
      expect(getLineCountFromIndex(newState)).toBe(1);
    });
  });

  describe('integration with createLineIndexState', () => {
    it('should match piece table line operations', () => {
      // Create the same content through state factory
      const content = 'Line 1\nLine 2\nLine 3';
      const state = createLineIndexState(content);

      expect(getLineCountFromIndex(state)).toBe(3);

      // Verify line positions
      const line0 = getLineRange(state, 0);
      expect(line0).toEqual({ start: 0, length: 7 });

      const line1 = getLineRange(state, 1);
      expect(line1).toEqual({ start: 7, length: 7 });

      const line2 = getLineRange(state, 2);
      expect(line2).toEqual({ start: 14, length: 6 });
    });
  });

  describe('multi-byte character handling (UTF-8)', () => {
    // CJK characters: 3 bytes each in UTF-8, 1 code unit in UTF-16
    // Emoji (😀): 4 bytes in UTF-8, 2 code units in UTF-16 (surrogate pair)

    describe('createLineIndexState with multi-byte text', () => {
      it('should compute correct byte lengths for CJK text', () => {
        // '你好\n世界' = 6 bytes + 1 byte + 6 bytes = 13 bytes total
        const state = createLineIndexState('你好\n世界');
        expect(getLineCountFromIndex(state)).toBe(2);

        const line0 = getLineRange(state, 0);
        expect(line0).toEqual({ start: 0, length: 7 }); // '你好\n' = 6 + 1 = 7 bytes

        const line1 = getLineRange(state, 1);
        expect(line1).toEqual({ start: 7, length: 6 }); // '世界' = 6 bytes
      });

      it('should compute correct byte lengths for emoji text', () => {
        // 'Hi😀\nBye' = 2 + 4 + 1 + 3 = 10 bytes
        const state = createLineIndexState('Hi😀\nBye');
        expect(getLineCountFromIndex(state)).toBe(2);

        const line0 = getLineRange(state, 0);
        expect(line0).toEqual({ start: 0, length: 7 }); // 'Hi😀\n' = 2 + 4 + 1 = 7 bytes

        const line1 = getLineRange(state, 1);
        expect(line1).toEqual({ start: 7, length: 3 }); // 'Bye' = 3 bytes
      });

      it('should compute correct byte lengths for mixed multi-byte lines', () => {
        // '你好😀\nABC\n世界' = (6+4+1) + (3+1) + 6 = 21 bytes
        const state = createLineIndexState('你好😀\nABC\n世界');
        expect(getLineCountFromIndex(state)).toBe(3);

        const line0 = getLineRange(state, 0);
        expect(line0).toEqual({ start: 0, length: 11 }); // '你好😀\n' = 6+4+1 = 11

        const line1 = getLineRange(state, 1);
        expect(line1).toEqual({ start: 11, length: 4 }); // 'ABC\n' = 3+1 = 4

        const line2 = getLineRange(state, 2);
        expect(line2).toEqual({ start: 15, length: 6 }); // '世界' = 6
      });
    });

    describe('lineIndexInsert with multi-byte text', () => {
      it('should insert CJK text without newlines', () => {
        // 'AB' = 2 bytes, insert '你' (3 bytes) at position 1 → 'A你B' = 5 bytes
        const state = createLineIndexState('AB');
        const newState = lineIndexInsert(state, byteOffset(1), '你');
        expect(getLineCountFromIndex(newState)).toBe(1);

        const line0 = getLineRange(newState, 0);
        expect(line0).toEqual({ start: 0, length: 5 }); // 1 + 3 + 1 = 5 bytes
      });

      it('should insert CJK text with newlines', () => {
        // 'AB' = 2 bytes, insert '你\n好' (3+1+3 = 7 bytes) at position 1
        // Result: 'A你\n好B' → line0 = 'A你\n' (1+3+1=5), line1 = '好B' (3+1=4)
        const state = createLineIndexState('AB');
        const newState = lineIndexInsert(state, byteOffset(1), '你\n好');
        expect(getLineCountFromIndex(newState)).toBe(2);

        const line0 = getLineRange(newState, 0);
        expect(line0).toEqual({ start: 0, length: 5 }); // 'A你\n' = 5 bytes

        const line1 = getLineRange(newState, 1);
        expect(line1).toEqual({ start: 5, length: 4 }); // '好B' = 4 bytes
      });

      it('should insert emoji with multiple newlines', () => {
        // 'X' = 1 byte, insert '😀\n🎉\nZ' (4+1+4+1+1 = 11 bytes) at position 1
        // Result: 'X😀\n🎉\nZX' wait... insert at end of 'X': 'X😀\n🎉\nZ'
        // Actually: insert at byteOffset(1) into 'X' → 'X😀\n🎉\nZ'
        const state = createLineIndexState('X');
        const newState = lineIndexInsert(state, byteOffset(1), '😀\n🎉\nZ');
        expect(getLineCountFromIndex(newState)).toBe(3);

        const line0 = getLineRange(newState, 0);
        expect(line0).toEqual({ start: 0, length: 6 }); // 'X😀\n' = 1+4+1 = 6 bytes

        const line1 = getLineRange(newState, 1);
        expect(line1).toEqual({ start: 6, length: 5 }); // '🎉\n' = 4+1 = 5 bytes

        const line2 = getLineRange(newState, 2);
        expect(line2).toEqual({ start: 11, length: 1 }); // 'Z' = 1 byte
      });
    });

    describe('lineIndexDelete with multi-byte text', () => {
      it('should delete newline between CJK lines', () => {
        // '你好\n世界' → delete the newline (byte 6, length 1)
        const state = createLineIndexState('你好\n世界');
        const newState = lineIndexDelete(state, byteOffset(6), byteOffset(7), '\n');
        expect(getLineCountFromIndex(newState)).toBe(1);
      });

      it('should delete CJK text without newlines', () => {
        // '你好世界' = 12 bytes, delete '好' (bytes 3-6) → '你世界' = 9 bytes
        const state = createLineIndexState('你好世界');
        const newState = lineIndexDelete(state, byteOffset(3), byteOffset(6), '好');
        expect(getLineCountFromIndex(newState)).toBe(1);

        const line0 = getLineRange(newState, 0);
        expect(line0).toEqual({ start: 0, length: 9 }); // '你世界' = 9 bytes
      });
    });

    describe('rebuildLineIndex with multi-byte text', () => {
      it('should compute correct byte lengths for CJK text', () => {
        const state = rebuildLineIndex('你好\n世界');
        expect(getLineCountFromIndex(state)).toBe(2);

        const line0 = getLineRange(state, 0);
        expect(line0).toEqual({ start: 0, length: 7 }); // '你好\n' = 7 bytes

        const line1 = getLineRange(state, 1);
        expect(line1).toEqual({ start: 7, length: 6 }); // '世界' = 6 bytes
      });
    });

    describe('findLineAtPosition with multi-byte text', () => {
      it('should find correct line using byte positions', () => {
        // '你好\n世界' → line0 bytes [0,7), line1 bytes [7,13)
        const state = createLineIndexState('你好\n世界');

        // Position 3 is in the middle of '好' on line 0
        const loc0 = findLineAtPosition(state.root, byteOffset(3));
        expect(loc0).not.toBeNull();
        expect(loc0!.lineNumber).toBe(0);

        // Position 7 is start of line 1 ('世')
        const loc1 = findLineAtPosition(state.root, byteOffset(7));
        expect(loc1).not.toBeNull();
        expect(loc1!.lineNumber).toBe(1);
      });
    });
  });

  describe('structural integrity', () => {
    it('should maintain correct subtree metadata', () => {
      const state = createLineIndexState('A\nB\nC\nD\nE');
      const lines = collectLines(state.root);

      // Total should be 5 lines
      expect(lines.length).toBe(5);

      // Verify root subtree metadata
      expect(state.root!.subtreeLineCount).toBe(5);
    });

    it('should freeze state', () => {
      const state = createLineIndexState('Hello\nWorld');
      expect(Object.isFrozen(state)).toBe(true);
    });
  });
});

describe('Reconciliation version tracking (P6 fix)', () => {
  it('reconcileFull should update lastReconciledVersion', () => {
    const initial = createLineIndexState('Line 1\nLine 2');
    // Insert lazily to create dirty ranges
    const dirty = lineIndexInsertLazy(initial, byteOffset(13), '\nLine 3', 5);
    expect(dirty.dirtyRanges.length).toBeGreaterThan(0);
    expect(dirty.lastReconciledVersion).toBe(0);

    const reconciled = reconcileFull(dirty, 10);
    expect(reconciled.lastReconciledVersion).toBe(10);
    expect(reconciled.dirtyRanges.length).toBe(0);
  });

  it('reconcileRange should update lastReconciledVersion', () => {
    const initial = createLineIndexState('Line 1\nLine 2');
    const dirty = lineIndexInsertLazy(initial, byteOffset(13), '\nLine 3', 5);
    expect(dirty.lastReconciledVersion).toBe(0);

    const reconciled = reconcileRange(dirty, 0, 2, 7);
    expect(reconciled.lastReconciledVersion).toBe(7);
  });

  it('reconcileRange should keep dirty lines outside the reconciled window', () => {
    const content = Array.from({ length: 150 }, (_, i) => `Line ${i}`).join('\n');
    const initial = createLineIndexState(content);
    const dirty = lineIndexInsertLazy(initial, byteOffset(0), 'X\n', 1);
    expect(dirty.dirtyRanges.length).toBeGreaterThan(0);

    const partiallyReconciled = reconcileRange(dirty, 100, 120, 2);
    const hasLineOneStillDirty = partiallyReconciled.dirtyRanges.some(
      range => range.startLine <= 1 && range.endLine >= 1
    );
    const hasViewportLineStillDirty = partiallyReconciled.dirtyRanges.some(
      range => range.startLine <= 110 && range.endLine >= 110
    );
    expect(hasLineOneStillDirty).toBe(true);
    expect(hasViewportLineStillDirty).toBe(false);
  });

  it('reconcileRange should no-op for invalid clamped windows', () => {
    const initial = createLineIndexState(Array.from({ length: 30 }, (_, i) => `Line ${i}`).join('\n'));
    const dirty = lineIndexInsertLazy(initial, byteOffset(0), 'X\n', 1);
    const noOp = reconcileRange(dirty, 20, 5, 2);

    expect(noOp).toBe(dirty);
  });

  it('reconcileViewport should normalize reversed bounds', () => {
    const initial = createLineIndexState(Array.from({ length: 40 }, (_, i) => `Line ${i}`).join('\n'));
    const dirty = lineIndexInsertLazy(initial, byteOffset(0), 'X\n', 1);

    const reversed = reconcileViewport(dirty, 12, 3, 2);
    const normalized = reconcileViewport(dirty, 3, 12, 2);

    expect(reversed.dirtyRanges).toEqual(normalized.dirtyRanges);
    expect(reversed.lineCount).toBe(normalized.lineCount);
  });
});

describe('mergeDirtyRanges improvements', () => {
  it('should merge same-start ranges with different deltas by summing', () => {
    const ranges = [
      Object.freeze({ startLine: 5, endLine: 10 , offsetDelta: 3, createdAtVersion: 1 }),
      Object.freeze({ startLine: 5, endLine: 12 , offsetDelta: -2, createdAtVersion: 2 }),
    ];

    const merged = mergeDirtyRanges(ranges);
    expect(merged).toHaveLength(1);
    expect(merged[0].startLine).toBe(5);
    expect(merged[0].endLine).toBe(12);
    expect(merged[0].offsetDelta).toBe(1); // 3 + (-2)
    expect(merged[0].createdAtVersion).toBe(2);
  });

  it('should collapse to single range when exceeding 32 ranges', () => {
    const ranges = [];
    for (let i = 0; i < 40; i++) {
      ranges.push(Object.freeze({
        startLine: i * 10,
        endLine: (i * 10 + 5) ,
        offsetDelta: i % 2 === 0 ? 1 : -1,
        createdAtVersion: i,
      }));
    }

    const merged = mergeDirtyRanges(ranges);
    expect(merged).toHaveLength(1);
    expect(merged[0].startLine).toBe(0);
    expect(merged[0].endLine).toBe(Number.MAX_SAFE_INTEGER);
    expect(merged[0].offsetDelta).toBe(0);
    expect(merged[0].createdAtVersion).toBe(39);
  });

  it('should still merge adjacent same-delta ranges normally', () => {
    const ranges = [
      Object.freeze({ startLine: 0, endLine: 5 , offsetDelta: 2, createdAtVersion: 1 }),
      Object.freeze({ startLine: 6, endLine: 10 , offsetDelta: 2, createdAtVersion: 2 }),
    ];

    const merged = mergeDirtyRanges(ranges);
    expect(merged).toHaveLength(1);
    expect(merged[0].startLine).toBe(0);
    expect(merged[0].endLine).toBe(10);
  });

  it('reconcileFull should fully rebuild when range-cap collapse loses delta detail', () => {
    const base = createLineIndexState(Array.from({ length: 20 }, (_, i) => `Line ${i}`).join('\n'));
    const dirty = lineIndexInsertLazy(base, byteOffset(0), 'A\nB\nC\n', 1);

    // Simulate the >32 range collapse sentinel produced by mergeDirtyRanges.
    const manyRanges = [];
    for (let i = 0; i < 40; i++) {
      manyRanges.push(Object.freeze({
        startLine: i * 2,
        endLine: i * 2,
        offsetDelta: i % 2 === 0 ? 1 : -1,
        createdAtVersion: i + 1,
      }));
    }
    const collapsed = mergeDirtyRanges(manyRanges);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].startLine).toBe(0);
    expect(collapsed[0].endLine).toBe(Number.MAX_SAFE_INTEGER);
    expect(collapsed[0].offsetDelta).toBe(0);

    const forcedDirty = withLineIndexState(dirty, {
      dirtyRanges: Object.freeze(collapsed),
      rebuildPending: true,
    });

    const reconciled = reconcileFull(forcedDirty, 2);
    const lines = collectLines(reconciled.root);

    let runningOffset = 0;
    for (const line of lines) {
      expect(line.documentOffset).toBe(runningOffset);
      runningOffset += line.lineLength;
    }
  });
});

describe('CR-only line ending edits', () => {
  it('lineIndexInsertLazy should split lines for CR-only inserts', () => {
    const initial = createLineIndexState('A\rB');
    expect(initial.lineCount).toBe(2);

    const dirty = lineIndexInsertLazy(initial, byteOffset(3), '\rC', 1);
    expect(dirty.lineCount).toBe(3);
  });

  it('lineIndexDeleteLazy should merge lines when deleting CR-only separator', () => {
    const initial = createLineIndexState('A\rB');
    expect(initial.lineCount).toBe(2);

    const dirty = lineIndexDeleteLazy(initial, byteOffset(1), byteOffset(2), '\r', 1);
    expect(dirty.lineCount).toBe(1);
  });

  it('lineIndexDeleteLazy should keep line count when deleting only CR from CRLF', () => {
    const initial = createLineIndexState('A\r\nB');
    expect(initial.lineCount).toBe(2);

    const dirty = lineIndexDeleteLazy(
      initial,
      byteOffset(1),
      byteOffset(2),
      '\r',
      1,
      { nextChar: '\n' }
    );
    expect(dirty.lineCount).toBe(2);
  });

  it('lineIndexDeleteLazy should keep line count when deleting only LF from CRLF', () => {
    const initial = createLineIndexState('A\r\nB');
    expect(initial.lineCount).toBe(2);

    const dirty = lineIndexDeleteLazy(
      initial,
      byteOffset(2),
      byteOffset(3),
      '\n',
      1,
      { prevChar: '\r' }
    );
    expect(dirty.lineCount).toBe(2);
  });
});
