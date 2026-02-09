/**
 * Tests for rendering utilities.
 */

import { describe, it, expect } from 'vitest';
import { createInitialState } from './state.ts';
import {
  getVisibleLineRange,
  getVisibleLines,
  getVisibleLine,
  estimateLineHeight,
  estimateTotalHeight,
  positionToLineColumn,
  lineColumnToPosition,
} from './rendering.ts';
import type { ScrollPosition, LineHeightConfig, VisibleLine } from './rendering.ts';
import { byteOffset } from '../types/branded.ts';

describe('getVisibleLineRange', () => {
  it('should calculate visible lines from scroll position', () => {
    const scroll: ScrollPosition = {
      scrollTop: 200,
      lineHeight: 20,
      viewportHeight: 400,
    };

    const result = getVisibleLineRange(scroll, 100);

    // First visible line: 200 / 20 = 10
    // Visible lines: 400 / 20 = 20
    // With overscan 5: lines 5-35
    expect(result.startLine).toBe(5);
    expect(result.endLine).toBe(35);
  });

  it('should clamp to document bounds', () => {
    const scroll: ScrollPosition = {
      scrollTop: 0,
      lineHeight: 20,
      viewportHeight: 400,
    };

    const result = getVisibleLineRange(scroll, 10);

    expect(result.startLine).toBe(0);
    expect(result.endLine).toBe(9); // Only 10 lines in document
  });

  it('should apply custom overscan', () => {
    const scroll: ScrollPosition = {
      scrollTop: 100,
      lineHeight: 20,
      viewportHeight: 200,
    };

    const result = getVisibleLineRange(scroll, 50, 10);

    // First visible: 5, last visible: 15
    // With overscan 10: lines 0-25
    expect(result.startLine).toBe(0); // Clamped
    expect(result.endLine).toBe(25);
  });

  it('should handle zero scroll', () => {
    const scroll: ScrollPosition = {
      scrollTop: 0,
      lineHeight: 20,
      viewportHeight: 100,
    };

    const result = getVisibleLineRange(scroll, 1000, 5);

    expect(result.startLine).toBe(0);
    expect(result.endLine).toBe(10); // 5 visible + 5 overscan
  });
});

describe('getVisibleLines', () => {
  it('should return empty for empty document', () => {
    const state = createInitialState();
    const result = getVisibleLines(state, {
      startLine: 0,
      visibleLineCount: 10,
    });

    expect(result.lines).toHaveLength(0);
    expect(result.totalLines).toBe(0);
  });

  it('should return visible lines with content', () => {
    const state = createInitialState({
      content: 'Line 0\nLine 1\nLine 2\nLine 3\nLine 4',
    });

    const result = getVisibleLines(state, {
      startLine: 0,
      visibleLineCount: 3,
      overscan: 0,
    });

    expect(result.lines).toHaveLength(3);
    expect(result.lines[0].content).toBe('Line 0');
    expect(result.lines[0].lineNumber).toBe(0);
    expect(result.lines[1].content).toBe('Line 1');
    expect(result.lines[2].content).toBe('Line 2');
  });

  it('should strip trailing newlines from content', () => {
    const state = createInitialState({
      content: 'Hello\nWorld\n',
    });

    const result = getVisibleLines(state, {
      startLine: 0,
      visibleLineCount: 3,
      overscan: 0,
    });

    expect(result.lines[0].content).toBe('Hello');
    expect(result.lines[0].hasNewline).toBe(true);
    expect(result.lines[1].content).toBe('World');
    expect(result.lines[1].hasNewline).toBe(true);
  });

  it('should include offsets', () => {
    const state = createInitialState({
      content: 'ABC\nDEF\n',
    });

    const result = getVisibleLines(state, {
      startLine: 0,
      visibleLineCount: 2,
      overscan: 0,
    });

    expect(result.lines[0].startOffset).toBe(0);
    expect(result.lines[0].endOffset).toBe(4); // 'ABC\n'
    expect(result.lines[1].startOffset).toBe(4);
    expect(result.lines[1].endOffset).toBe(8); // 'DEF\n'
  });

  it('should apply overscan', () => {
    const state = createInitialState({
      content: 'L0\nL1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9',
    });

    const result = getVisibleLines(state, {
      startLine: 5,
      visibleLineCount: 2,
      overscan: 2,
    });

    // Visible: lines 5-6 (2 lines)
    // With overscan 2: lines 3-8 (6 lines)
    expect(result.firstLine).toBe(3); // 5 - 2
    expect(result.lastLine).toBe(8); // 5 + 2 - 1 + 2
    expect(result.lines.length).toBe(6);
  });

  it('should return frozen results', () => {
    const state = createInitialState({
      content: 'Hello\nWorld',
    });

    const result = getVisibleLines(state, {
      startLine: 0,
      visibleLineCount: 2,
      overscan: 0,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.lines)).toBe(true);
    expect(Object.isFrozen(result.lines[0])).toBe(true);
  });
});

describe('getVisibleLine', () => {
  it('should return null for invalid line number', () => {
    const state = createInitialState({ content: 'Hello' });

    expect(getVisibleLine(state, -1)).toBeNull();
    expect(getVisibleLine(state, 100)).toBeNull();
  });

  it('should return line content', () => {
    const state = createInitialState({
      content: 'Line 0\nLine 1\nLine 2',
    });

    const line = getVisibleLine(state, 1);

    expect(line).not.toBeNull();
    expect(line!.lineNumber).toBe(1);
    expect(line!.content).toBe('Line 1');
    expect(line!.hasNewline).toBe(true);
  });

  it('should handle last line without newline', () => {
    const state = createInitialState({
      content: 'Hello\nWorld',
    });

    const line = getVisibleLine(state, 1);

    expect(line!.content).toBe('World');
    expect(line!.hasNewline).toBe(false);
  });

  it('should return frozen result', () => {
    const state = createInitialState({ content: 'Test' });
    const line = getVisibleLine(state, 0);

    expect(Object.isFrozen(line)).toBe(true);
  });
});

describe('estimateLineHeight', () => {
  const mockLine: VisibleLine = {
    lineNumber: 0,
    content: 'A'.repeat(50),
    startOffset: 0,
    endOffset: 50,
    hasNewline: true,
  };

  it('should return base height when wrapping disabled', () => {
    const config: LineHeightConfig = {
      baseLineHeight: 20,
      charWidth: 8,
      viewportWidth: 400,
      softWrap: false,
    };

    expect(estimateLineHeight(mockLine, config)).toBe(20);
  });

  it('should calculate wrapped height', () => {
    const config: LineHeightConfig = {
      baseLineHeight: 20,
      charWidth: 8,
      viewportWidth: 200, // 25 chars per line
      softWrap: true,
    };

    // 50 chars / 25 chars per line = 2 lines
    expect(estimateLineHeight(mockLine, config)).toBe(40);
  });

  it('should handle empty line', () => {
    const emptyLine: VisibleLine = {
      lineNumber: 0,
      content: '',
      startOffset: 0,
      endOffset: 1,
      hasNewline: true,
    };

    const config: LineHeightConfig = {
      baseLineHeight: 20,
      charWidth: 8,
      viewportWidth: 200,
      softWrap: true,
    };

    expect(estimateLineHeight(emptyLine, config)).toBe(20);
  });
});

describe('estimateTotalHeight', () => {
  it('should calculate total height without wrapping', () => {
    const state = createInitialState({
      content: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5',
    });

    const config: LineHeightConfig = {
      baseLineHeight: 20,
      charWidth: 8,
      viewportWidth: 400,
      softWrap: false,
    };

    expect(estimateTotalHeight(state, config)).toBe(100); // 5 lines * 20
  });

  it('should calculate height with wrapping for small docs', () => {
    const state = createInitialState({
      content: 'Short\n' + 'A'.repeat(50) + '\nShort',
    });

    const config: LineHeightConfig = {
      baseLineHeight: 20,
      charWidth: 10,
      viewportWidth: 200, // 20 chars per line
      softWrap: true,
    };

    // Line 1: 1 row (5 chars)
    // Line 2: 3 rows (50 chars / 20)
    // Line 3: 1 row (5 chars)
    // Total: 5 rows * 20 = 100
    expect(estimateTotalHeight(state, config)).toBe(100);
  });
});

describe('positionToLineColumn', () => {
  it('should convert position to line/column', () => {
    const state = createInitialState({
      content: 'Hello\nWorld',
    });

    expect(positionToLineColumn(state, byteOffset(0))).toEqual({ line: 0, column: 0 });
    expect(positionToLineColumn(state, byteOffset(5))).toEqual({ line: 0, column: 5 });
    expect(positionToLineColumn(state, byteOffset(6))).toEqual({ line: 1, column: 0 });
    expect(positionToLineColumn(state, byteOffset(11))).toEqual({ line: 1, column: 5 });
  });

  it('should handle empty document', () => {
    const state = createInitialState();

    expect(positionToLineColumn(state, byteOffset(0))).toEqual({ line: 0, column: 0 });
  });

  it('should handle position at newline', () => {
    const state = createInitialState({
      content: 'ABC\nDEF',
    });

    // Position 3 is at the newline
    const result = positionToLineColumn(state, byteOffset(3));
    expect(result).toEqual({ line: 0, column: 3 });
  });
});

describe('lineColumnToPosition', () => {
  it('should convert line/column to position', () => {
    const state = createInitialState({
      content: 'Hello\nWorld',
    });

    expect(lineColumnToPosition(state, 0, 0)).toBe(0);
    expect(lineColumnToPosition(state, 0, 5)).toBe(5);
    expect(lineColumnToPosition(state, 1, 0)).toBe(6);
    expect(lineColumnToPosition(state, 1, 5)).toBe(11);
  });

  it('should return null for invalid line', () => {
    const state = createInitialState({
      content: 'Hello',
    });

    expect(lineColumnToPosition(state, -1, 0)).toBeNull();
    expect(lineColumnToPosition(state, 100, 0)).toBeNull();
  });

  it('should clamp column to line length', () => {
    const state = createInitialState({
      content: 'Hi\nWorld',
    });

    // Line 0 is 'Hi\n' (3 chars with newline, 2 without)
    // Column 100 should clamp to end of line
    const result = lineColumnToPosition(state, 0, 100);
    expect(result).toBe(3); // Clamped to line length including newline
  });

  it('should handle unicode', () => {
    const state = createInitialState({
      content: '世界\nHello',
    });

    // Line index uses byte positions (UTF-8)
    // '世界\n' is 7 bytes (3+3+1), so line 1 starts at byte position 7
    expect(lineColumnToPosition(state, 1, 0)).toBe(7);
  });
});
