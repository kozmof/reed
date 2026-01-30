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
} from './line-index.ts';
import { createLineIndexState, createEmptyLineIndexState } from './state.ts';

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
  });

  describe('findLineAtPosition', () => {
    it('should return null for empty state', () => {
      const state = createEmptyLineIndexState();
      expect(findLineAtPosition(state.root, 0)).toBeNull();
    });

    it('should find line at position 0', () => {
      const state = createLineIndexState('Hello\nWorld');
      const location = findLineAtPosition(state.root, 0);
      expect(location).not.toBeNull();
      expect(location!.lineNumber).toBe(0);
      expect(location!.offsetInLine).toBe(0);
    });

    it('should find correct line for position in first line', () => {
      const state = createLineIndexState('Hello\nWorld');
      const location = findLineAtPosition(state.root, 3);
      expect(location).not.toBeNull();
      expect(location!.lineNumber).toBe(0);
      expect(location!.offsetInLine).toBe(3);
    });

    it('should find correct line for position in second line', () => {
      const state = createLineIndexState('Hello\nWorld');
      const location = findLineAtPosition(state.root, 7);
      expect(location).not.toBeNull();
      expect(location!.lineNumber).toBe(1);
      expect(location!.offsetInLine).toBe(1);
    });

    it('should handle position at newline', () => {
      const state = createLineIndexState('Hello\nWorld');
      const location = findLineAtPosition(state.root, 5);
      expect(location).not.toBeNull();
      expect(location!.lineNumber).toBe(0);
      expect(location!.offsetInLine).toBe(5);
    });
  });

  describe('findLineByNumber', () => {
    it('should return null for empty state', () => {
      const state = createEmptyLineIndexState();
      expect(findLineByNumber(state.root, 0)).toBeNull();
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
    it('should return null for empty state', () => {
      const state = createEmptyLineIndexState();
      expect(getLineRange(state, 0)).toBeNull();
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
    it('should return empty array for empty state', () => {
      const state = createEmptyLineIndexState();
      expect(collectLines(state.root)).toEqual([]);
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
      const newState = lineIndexInsert(state, 5, ' World');
      expect(getLineCountFromIndex(newState)).toBe(1);
    });

    it('should handle insert with newline at end', () => {
      const state = createLineIndexState('Hello');
      const newState = lineIndexInsert(state, 5, '\nWorld');
      expect(getLineCountFromIndex(newState)).toBe(2);
    });

    it('should handle insert with newline in middle', () => {
      const state = createLineIndexState('HelloWorld');
      const newState = lineIndexInsert(state, 5, '\n');
      expect(getLineCountFromIndex(newState)).toBe(2);
    });

    it('should handle insert with multiple newlines', () => {
      const state = createLineIndexState('A');
      const newState = lineIndexInsert(state, 1, '\nB\nC');
      expect(getLineCountFromIndex(newState)).toBe(3);
    });

    it('should handle insert into empty state', () => {
      const state = createEmptyLineIndexState();
      const newState = lineIndexInsert(state, 0, 'Hello');
      expect(getLineCountFromIndex(newState)).toBe(1);
    });

    it('should handle insert newlines into empty state', () => {
      const state = createEmptyLineIndexState();
      const newState = lineIndexInsert(state, 0, 'A\nB\nC');
      expect(getLineCountFromIndex(newState)).toBe(3);
    });
  });

  describe('lineIndexDelete', () => {
    it('should handle delete without newlines', () => {
      const state = createLineIndexState('Hello World');
      const newState = lineIndexDelete(state, 5, 11, ' World');
      expect(getLineCountFromIndex(newState)).toBe(1);
    });

    it('should handle delete newline (merge lines)', () => {
      const state = createLineIndexState('Hello\nWorld');
      const newState = lineIndexDelete(state, 5, 6, '\n');
      expect(getLineCountFromIndex(newState)).toBe(1);
    });

    it('should handle delete multiple lines', () => {
      const state = createLineIndexState('A\nB\nC\nD');
      const newState = lineIndexDelete(state, 2, 6, 'B\nC\n');
      expect(getLineCountFromIndex(newState)).toBe(2);
    });

    it('should handle delete entire content', () => {
      const state = createLineIndexState('Hello\nWorld');
      const newState = lineIndexDelete(state, 0, 11, 'Hello\nWorld');
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
