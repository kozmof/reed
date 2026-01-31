/**
 * Tests for piece table operations.
 */

import { describe, it, expect } from 'vitest';
import {
  pieceTableInsert,
  pieceTableDelete,
  getValue,
  getText,
  getLength,
  getLineCount,
  getLine,
  findPieceAtPosition,
  collectPieces,
  getBufferStats,
  compactAddBuffer,
} from './piece-table.ts';
import {
  createEmptyPieceTableState,
  createPieceTableState,
} from './state.ts';
import { byteOffset } from '../types/branded.ts';

describe('Piece Table Operations', () => {
  describe('getValue', () => {
    it('should return empty string for empty state', () => {
      const state = createEmptyPieceTableState();
      expect(getValue(state)).toBe('');
    });

    it('should return content for non-empty state', () => {
      const state = createPieceTableState('Hello, World!');
      expect(getValue(state)).toBe('Hello, World!');
    });

    it('should handle multiline content', () => {
      const content = 'Line 1\nLine 2\nLine 3';
      const state = createPieceTableState(content);
      expect(getValue(state)).toBe(content);
    });

    it('should handle unicode content', () => {
      const content = 'Hello 世界! 🎉';
      const state = createPieceTableState(content);
      expect(getValue(state)).toBe(content);
    });
  });

  describe('getText', () => {
    it('should return empty string for empty state', () => {
      const state = createEmptyPieceTableState();
      expect(getText(state, byteOffset(0), byteOffset(10))).toBe('');
    });

    it('should return substring', () => {
      const state = createPieceTableState('Hello, World!');
      expect(getText(state, byteOffset(0), byteOffset(5))).toBe('Hello');
      expect(getText(state, byteOffset(7), byteOffset(12))).toBe('World');
    });

    it('should handle range at end', () => {
      const state = createPieceTableState('Hello');
      expect(getText(state, byteOffset(3), byteOffset(5))).toBe('lo');
    });

    it('should handle range exceeding length', () => {
      const state = createPieceTableState('Hello');
      expect(getText(state, byteOffset(3), byteOffset(100))).toBe('lo');
    });

    it('should return empty for invalid range', () => {
      const state = createPieceTableState('Hello');
      expect(getText(state, byteOffset(5), byteOffset(3))).toBe('');
      expect(getText(state, byteOffset(-1), byteOffset(3))).toBe('');
    });
  });

  describe('getLength', () => {
    it('should return 0 for empty state', () => {
      const state = createEmptyPieceTableState();
      expect(getLength(state)).toBe(0);
    });

    it('should return correct length', () => {
      const state = createPieceTableState('Hello, World!');
      expect(getLength(state)).toBe(13);
    });
  });

  describe('getLineCount', () => {
    it('should return 1 for empty state', () => {
      const state = createEmptyPieceTableState();
      expect(getLineCount(state)).toBe(1);
    });

    it('should return 1 for single line', () => {
      const state = createPieceTableState('Hello');
      expect(getLineCount(state)).toBe(1);
    });

    it('should count lines correctly', () => {
      const state = createPieceTableState('Line 1\nLine 2\nLine 3');
      expect(getLineCount(state)).toBe(3);
    });

    it('should handle trailing newline', () => {
      const state = createPieceTableState('Line 1\n');
      expect(getLineCount(state)).toBe(2);
    });
  });

  describe('getLine', () => {
    it('should return empty for empty state', () => {
      const state = createEmptyPieceTableState();
      expect(getLine(state, 0)).toBe('');
    });

    it('should return first line', () => {
      const state = createPieceTableState('Line 1\nLine 2\nLine 3');
      expect(getLine(state, 0)).toBe('Line 1\n');
    });

    it('should return middle line', () => {
      const state = createPieceTableState('Line 1\nLine 2\nLine 3');
      expect(getLine(state, 1)).toBe('Line 2\n');
    });

    it('should return last line without trailing newline', () => {
      const state = createPieceTableState('Line 1\nLine 2\nLine 3');
      expect(getLine(state, 2)).toBe('Line 3');
    });

    it('should return empty for out of bounds line', () => {
      const state = createPieceTableState('Line 1\nLine 2');
      expect(getLine(state, 5)).toBe('');
      expect(getLine(state, -1)).toBe('');
    });
  });

  describe('pieceTableInsert', () => {
    it('should insert into empty state', () => {
      const state = createEmptyPieceTableState();
      const newState = pieceTableInsert(state, byteOffset(0), 'Hello');
      expect(getValue(newState)).toBe('Hello');
      expect(getLength(newState)).toBe(5);
    });

    it('should insert at beginning', () => {
      const state = createPieceTableState('World');
      const newState = pieceTableInsert(state, byteOffset(0), 'Hello ');
      expect(getValue(newState)).toBe('Hello World');
    });

    it('should insert at end', () => {
      const state = createPieceTableState('Hello');
      const newState = pieceTableInsert(state, byteOffset(5), ' World');
      expect(getValue(newState)).toBe('Hello World');
    });

    it('should insert in middle', () => {
      const state = createPieceTableState('Helo');
      const newState = pieceTableInsert(state, byteOffset(2), 'l');
      expect(getValue(newState)).toBe('Hello');
    });

    it('should handle multiple inserts', () => {
      let state = createEmptyPieceTableState();
      state = pieceTableInsert(state, byteOffset(0), 'A');
      state = pieceTableInsert(state, byteOffset(1), 'B');
      state = pieceTableInsert(state, byteOffset(2), 'C');
      expect(getValue(state)).toBe('ABC');
    });

    it('should handle character-by-character typing', () => {
      let state = createEmptyPieceTableState();
      const text = 'Hello, World!';
      for (let i = 0; i < text.length; i++) {
        state = pieceTableInsert(state, byteOffset(i), text[i]);
      }
      expect(getValue(state)).toBe(text);
    });

    it('should handle insert with unicode', () => {
      const state = createPieceTableState('Hello');
      const newState = pieceTableInsert(state, byteOffset(5), ' 世界!');
      expect(getValue(newState)).toBe('Hello 世界!');
    });

    it('should not mutate original state', () => {
      const state = createPieceTableState('Hello');
      const newState = pieceTableInsert(state, byteOffset(5), ' World');
      expect(getValue(state)).toBe('Hello');
      expect(getValue(newState)).toBe('Hello World');
    });
  });

  describe('pieceTableDelete', () => {
    it('should do nothing on empty state', () => {
      const state = createEmptyPieceTableState();
      const newState = pieceTableDelete(state, byteOffset(0), byteOffset(5));
      expect(getValue(newState)).toBe('');
    });

    it('should delete from beginning', () => {
      const state = createPieceTableState('Hello World');
      const newState = pieceTableDelete(state, byteOffset(0), byteOffset(6));
      expect(getValue(newState)).toBe('World');
    });

    it('should delete from end', () => {
      const state = createPieceTableState('Hello World');
      const newState = pieceTableDelete(state, byteOffset(5), byteOffset(11));
      expect(getValue(newState)).toBe('Hello');
    });

    it('should delete from middle', () => {
      const state = createPieceTableState('Hello World');
      const newState = pieceTableDelete(state, byteOffset(5), byteOffset(6));
      expect(getValue(newState)).toBe('HelloWorld');
    });

    it('should delete entire content', () => {
      const state = createPieceTableState('Hello');
      const newState = pieceTableDelete(state, byteOffset(0), byteOffset(5));
      expect(getValue(newState)).toBe('');
      expect(getLength(newState)).toBe(0);
    });

    it('should handle invalid range', () => {
      const state = createPieceTableState('Hello');
      const newState = pieceTableDelete(state, byteOffset(5), byteOffset(3));
      expect(getValue(newState)).toBe('Hello');
    });

    it('should not mutate original state', () => {
      const state = createPieceTableState('Hello World');
      const newState = pieceTableDelete(state, byteOffset(0), byteOffset(6));
      expect(getValue(state)).toBe('Hello World');
      expect(getValue(newState)).toBe('World');
    });
  });

  describe('insert and delete combinations', () => {
    it('should handle insert then delete', () => {
      let state = createPieceTableState('Hello');
      state = pieceTableInsert(state, byteOffset(5), ' World');
      expect(getValue(state)).toBe('Hello World');
      state = pieceTableDelete(state, byteOffset(5), byteOffset(11));
      expect(getValue(state)).toBe('Hello');
    });

    it('should handle delete then insert', () => {
      let state = createPieceTableState('Hello World');
      state = pieceTableDelete(state, byteOffset(5), byteOffset(11));
      expect(getValue(state)).toBe('Hello');
      state = pieceTableInsert(state, byteOffset(5), ' Universe');
      expect(getValue(state)).toBe('Hello Universe');
    });

    it('should handle multiple operations', () => {
      let state = createEmptyPieceTableState();

      // Type "Hello"
      state = pieceTableInsert(state, byteOffset(0), 'Hello');
      expect(getValue(state)).toBe('Hello');

      // Type " World"
      state = pieceTableInsert(state, byteOffset(5), ' World');
      expect(getValue(state)).toBe('Hello World');

      // Delete " World"
      state = pieceTableDelete(state, byteOffset(5), byteOffset(11));
      expect(getValue(state)).toBe('Hello');

      // Insert " there"
      state = pieceTableInsert(state, byteOffset(5), ' there');
      expect(getValue(state)).toBe('Hello there');

      // Delete "there" and insert "everyone"
      state = pieceTableDelete(state, byteOffset(6), byteOffset(11));
      state = pieceTableInsert(state, byteOffset(6), 'everyone');
      expect(getValue(state)).toBe('Hello everyone');
    });

    it('should simulate backspace', () => {
      let state = createPieceTableState('Hello');
      // Backspace deletes character before cursor
      state = pieceTableDelete(state, byteOffset(4), byteOffset(5));
      expect(getValue(state)).toBe('Hell');
      state = pieceTableDelete(state, byteOffset(3), byteOffset(4));
      expect(getValue(state)).toBe('Hel');
    });

    it('should simulate delete key', () => {
      let state = createPieceTableState('Hello');
      // Delete key deletes character at cursor
      state = pieceTableDelete(state, byteOffset(0), byteOffset(1));
      expect(getValue(state)).toBe('ello');
      state = pieceTableDelete(state, byteOffset(0), byteOffset(1));
      expect(getValue(state)).toBe('llo');
    });
  });

  describe('findPieceAtPosition', () => {
    it('should return null for empty tree', () => {
      const state = createEmptyPieceTableState();
      expect(findPieceAtPosition(state.root, byteOffset(0))).toBeNull();
    });

    it('should find piece at position 0', () => {
      const state = createPieceTableState('Hello');
      const location = findPieceAtPosition(state.root, byteOffset(0));
      expect(location).not.toBeNull();
      expect(location!.offsetInPiece).toBe(0);
    });

    it('should find piece at middle position', () => {
      const state = createPieceTableState('Hello World');
      const location = findPieceAtPosition(state.root, byteOffset(6));
      expect(location).not.toBeNull();
      expect(location!.offsetInPiece).toBe(6);
    });

    it('should return null for position past end', () => {
      const state = createPieceTableState('Hello');
      const location = findPieceAtPosition(state.root, byteOffset(10));
      expect(location).toBeNull();
    });

    it('should return null for negative position', () => {
      const state = createPieceTableState('Hello');
      const location = findPieceAtPosition(state.root, byteOffset(-1));
      expect(location).toBeNull();
    });
  });

  describe('collectPieces', () => {
    it('should return empty array for empty tree', () => {
      const state = createEmptyPieceTableState();
      expect(collectPieces(state.root)).toEqual([]);
    });

    it('should collect all pieces', () => {
      const state = createPieceTableState('Hello');
      const pieces = collectPieces(state.root);
      expect(pieces.length).toBeGreaterThan(0);
    });

    it('should collect pieces after insert', () => {
      let state = createPieceTableState('Hello');
      state = pieceTableInsert(state, byteOffset(5), ' World');
      const pieces = collectPieces(state.root);
      expect(pieces.length).toBeGreaterThanOrEqual(1);

      // Total length should match
      const totalLength = pieces.reduce((sum, p) => sum + p.length, 0);
      expect(totalLength).toBe(state.totalLength);
    });
  });

  describe('structural sharing', () => {
    it('should share original buffer', () => {
      const state = createPieceTableState('Hello');
      const newState = pieceTableInsert(state, byteOffset(5), ' World');
      expect(newState.originalBuffer).toBe(state.originalBuffer);
    });

    it('should freeze state', () => {
      const state = createPieceTableState('Hello');
      expect(Object.isFrozen(state)).toBe(true);

      const newState = pieceTableInsert(state, byteOffset(5), ' World');
      expect(Object.isFrozen(newState)).toBe(true);
    });
  });

  describe('large content', () => {
    it('should handle large content', () => {
      const largeContent = 'a'.repeat(10000);
      const state = createPieceTableState(largeContent);
      expect(getLength(state)).toBe(10000);
      expect(getValue(state)).toBe(largeContent);
    });

    it('should handle many inserts', () => {
      let state = createEmptyPieceTableState();
      for (let i = 0; i < 1000; i++) {
        state = pieceTableInsert(state, byteOffset(i), 'x');
      }
      expect(getLength(state)).toBe(1000);
      expect(getValue(state)).toBe('x'.repeat(1000));
    });
  });

  describe('buffer compaction', () => {
    it('should return stats with zero waste for fresh insert', () => {
      let state = createEmptyPieceTableState();
      state = pieceTableInsert(state, byteOffset(0), 'Hello');
      const stats = getBufferStats(state);
      expect(stats.addBufferUsed).toBe(5);
      expect(stats.addBufferWaste).toBe(0);
      expect(stats.wasteRatio).toBe(0);
    });

    it('should detect waste after deletion', () => {
      let state = createEmptyPieceTableState();
      state = pieceTableInsert(state, byteOffset(0), 'Hello World');
      state = pieceTableDelete(state, byteOffset(0), byteOffset(6)); // Delete "Hello "

      const stats = getBufferStats(state);
      expect(stats.addBufferSize).toBe(11);
      expect(stats.addBufferUsed).toBe(5); // "World"
      expect(stats.addBufferWaste).toBe(6);
      expect(stats.wasteRatio).toBeCloseTo(6 / 11);
    });

    it('should compact buffer when waste exceeds threshold', () => {
      let state = createEmptyPieceTableState();
      state = pieceTableInsert(state, byteOffset(0), 'Hello World');
      state = pieceTableDelete(state, byteOffset(0), byteOffset(6)); // Delete "Hello "

      // Compact with 0 threshold (always compact)
      const compacted = compactAddBuffer(state, 0);

      expect(getValue(compacted)).toBe('World');
      const stats = getBufferStats(compacted);
      expect(stats.addBufferUsed).toBe(5);
      expect(stats.addBufferWaste).toBe(0);
    });

    it('should not compact when waste is below threshold', () => {
      let state = createEmptyPieceTableState();
      state = pieceTableInsert(state, byteOffset(0), 'Hello');

      // Try to compact with 0.5 threshold (no waste, so shouldn't compact)
      const result = compactAddBuffer(state, 0.5);

      expect(result).toBe(state); // Same reference
    });

    it('should preserve content after compaction', () => {
      let state = createEmptyPieceTableState();
      // Create fragmented state with insertions and deletions
      state = pieceTableInsert(state, byteOffset(0), 'AAA');
      state = pieceTableInsert(state, byteOffset(3), 'BBB');
      state = pieceTableInsert(state, byteOffset(6), 'CCC');
      state = pieceTableDelete(state, byteOffset(3), byteOffset(6)); // Delete "BBB"

      const before = getValue(state);
      const compacted = compactAddBuffer(state, 0);
      const after = getValue(compacted);

      expect(after).toBe(before);
      expect(after).toBe('AAACCC');
    });

    it('should handle compaction with original buffer content', () => {
      const state = createPieceTableState('Original');
      let modified = pieceTableInsert(state, byteOffset(8), ' Added');
      modified = pieceTableDelete(modified, byteOffset(8), byteOffset(14)); // Delete " Added"

      const compacted = compactAddBuffer(modified, 0);

      expect(getValue(compacted)).toBe('Original');
    });

    it('should handle empty add buffer after all deletions', () => {
      let state = createEmptyPieceTableState();
      state = pieceTableInsert(state, byteOffset(0), 'Hello');
      state = pieceTableDelete(state, byteOffset(0), byteOffset(5));

      const stats = getBufferStats(state);
      expect(stats.addBufferUsed).toBe(0);

      const compacted = compactAddBuffer(state, 0);
      expect(getValue(compacted)).toBe('');
    });
  });
});
