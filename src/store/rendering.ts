/**
 * Rendering utilities for virtualized document display.
 * Provides efficient computation of visible lines and viewport management.
 */

import type { DocumentState, SelectionRange, CharSelectionRange } from '../types/state.ts';
import type { ByteOffset } from '../types/branded.ts';
import { byteOffset, charOffset } from '../types/branded.ts';
import { findLineAtPosition, getLineRange, getLineRangePrecise, getLineCountFromIndex } from './line-index.ts';
import { getText, getValue, charToByteOffset, byteToCharOffset } from './piece-table.ts';
import { textEncoder } from './encoding.ts';

// =============================================================================
// Types
// =============================================================================

/**
 * Information about a visible line for rendering.
 */
export interface VisibleLine {
  /** Line number (0-indexed) */
  readonly lineNumber: number;
  /** Text content of the line (without trailing newline) */
  readonly content: string;
  /** Byte offset where this line starts in the document */
  readonly startOffset: number;
  /** Byte offset where this line ends (exclusive) */
  readonly endOffset: number;
  /** Whether this line ends with a newline */
  readonly hasNewline: boolean;
}

/**
 * Viewport configuration.
 */
export interface ViewportConfig {
  /** First visible line (0-indexed) */
  readonly startLine: number;
  /** Number of lines visible in viewport */
  readonly visibleLineCount: number;
  /** Extra lines to render above/below viewport for smooth scrolling */
  readonly overscan?: number;
}

/**
 * Result of computing visible lines.
 */
export interface VisibleLinesResult {
  /** Lines to render */
  readonly lines: readonly VisibleLine[];
  /** First line number in the result */
  readonly firstLine: number;
  /** Last line number in the result (inclusive) */
  readonly lastLine: number;
  /** Total number of lines in the document */
  readonly totalLines: number;
}

/**
 * Scroll position information.
 */
export interface ScrollPosition {
  /** Scroll offset from top in pixels */
  readonly scrollTop: number;
  /** Height of a single line in pixels */
  readonly lineHeight: number;
  /** Height of the viewport in pixels */
  readonly viewportHeight: number;
}

// =============================================================================
// Viewport Calculations
// =============================================================================

/**
 * Calculate which lines are visible given a scroll position.
 */
export function getVisibleLineRange(
  scroll: ScrollPosition,
  totalLines: number,
  overscan: number = 5
): { startLine: number; endLine: number } {
  const { scrollTop, lineHeight, viewportHeight } = scroll;

  const firstVisibleLine = Math.floor(scrollTop / lineHeight);
  const visibleLineCount = Math.ceil(viewportHeight / lineHeight);
  const lastVisibleLine = firstVisibleLine + visibleLineCount;

  // Apply overscan
  const startLine = Math.max(0, firstVisibleLine - overscan);
  const endLine = Math.min(totalLines - 1, lastVisibleLine + overscan);

  return { startLine, endLine };
}

/**
 * Get the text content of a specific line using the line index for O(log n) lookup.
 *
 * Unlike `getLine()` from piece-table.ts which scans the entire document O(n),
 * this leverages the line index tree for efficient random access.
 *
 * @param state - The full document state (needs both pieceTable and lineIndex)
 * @param lineNum - 0-indexed line number
 * @returns The line text (without trailing newline), or empty string if out of range
 */
export function getLineContent(state: DocumentState, lineNum: number): string {
  const range = getLineRange(state.lineIndex, lineNum);
  if (range === null) return '';
  const raw = getText(state.pieceTable, byteOffset(range.start) as ByteOffset, byteOffset(range.start + range.length) as ByteOffset);
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}

/**
 * Compute visible lines for rendering.
 * Returns line content and metadata for efficient virtualized rendering.
 */
export function getVisibleLines(
  state: DocumentState,
  config: ViewportConfig
): VisibleLinesResult {
  const { startLine, visibleLineCount, overscan = 5 } = config;
  const totalLines = getLineCountFromIndex(state.lineIndex);

  // Handle empty document (root is null but lineCount may be 1)
  if (state.lineIndex.root === null) {
    return {
      lines: [],
      firstLine: 0,
      lastLine: 0,
      totalLines: 0,
    };
  }

  // Calculate actual range with overscan
  // startLine to startLine + visibleLineCount - 1 gives visibleLineCount lines
  const firstLine = Math.max(0, startLine - overscan);
  const lastLine = Math.min(totalLines - 1, startLine + visibleLineCount - 1 + overscan);

  const lines: VisibleLine[] = [];

  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    // Use getLineRangePrecise to handle dirty line indices correctly
    const range = getLineRangePrecise(state.lineIndex, lineNum);
    if (range) {
      const startOffset = byteOffset(range.start);
      const endOffset = byteOffset(range.start + range.length);
      const rawContent = getText(state.pieceTable, startOffset, endOffset);

      // Check if line ends with newline and strip it for display
      const hasNewline = rawContent.endsWith('\n');
      const content = hasNewline ? rawContent.slice(0, -1) : rawContent;

      lines.push(Object.freeze({
        lineNumber: lineNum,
        content,
        startOffset,
        endOffset,
        hasNewline,
      }));
    }
  }

  return Object.freeze({
    lines: Object.freeze(lines),
    firstLine,
    lastLine,
    totalLines,
  });
}

/**
 * Get a single line for rendering.
 */
export function getVisibleLine(
  state: DocumentState,
  lineNumber: number
): VisibleLine | null {
  const totalLines = getLineCountFromIndex(state.lineIndex);

  if (lineNumber < 0 || lineNumber >= totalLines) {
    return null;
  }

  // Use getLineRangePrecise to handle dirty line indices correctly
  const range = getLineRangePrecise(state.lineIndex, lineNumber);
  if (!range) {
    return null;
  }

  const startOffset = byteOffset(range.start);
  const endOffset = byteOffset(range.start + range.length);
  const rawContent = getText(state.pieceTable, startOffset, endOffset);
  const hasNewline = rawContent.endsWith('\n');
  const content = hasNewline ? rawContent.slice(0, -1) : rawContent;

  return Object.freeze({
    lineNumber,
    content,
    startOffset,
    endOffset,
    hasNewline,
  });
}

// =============================================================================
// Line Height Estimation
// =============================================================================

/**
 * Configuration for variable line height calculation.
 */
export interface LineHeightConfig {
  /** Base line height in pixels */
  readonly baseLineHeight: number;
  /** Character width in pixels (for wrapping calculation) */
  readonly charWidth: number;
  /** Viewport width in pixels */
  readonly viewportWidth: number;
  /** Whether soft wrapping is enabled */
  readonly softWrap: boolean;
}

/**
 * Estimate the rendered height of a line (accounting for wrapping).
 */
export function estimateLineHeight(
  line: VisibleLine,
  config: LineHeightConfig
): number {
  if (!config.softWrap) {
    return config.baseLineHeight;
  }

  const charsPerLine = Math.floor(config.viewportWidth / config.charWidth);
  if (charsPerLine <= 0) {
    return config.baseLineHeight;
  }

  const wrappedLines = Math.ceil(line.content.length / charsPerLine) || 1;
  return wrappedLines * config.baseLineHeight;
}

/**
 * Calculate total document height for scroll container sizing.
 */
export function estimateTotalHeight(
  state: DocumentState,
  config: LineHeightConfig
): number {
  const totalLines = getLineCountFromIndex(state.lineIndex);

  if (!config.softWrap) {
    // Fixed height mode: simple multiplication
    return totalLines * config.baseLineHeight;
  }

  // Variable height mode: we need to estimate
  // For large documents, sample lines to estimate average wrapped height
  const SAMPLE_SIZE = 100;

  if (totalLines <= SAMPLE_SIZE) {
    // Small document: calculate exactly
    let totalHeight = 0;
    for (let i = 0; i < totalLines; i++) {
      const line = getVisibleLine(state, i);
      if (line) {
        totalHeight += estimateLineHeight(line, config);
      }
    }
    return totalHeight;
  }

  // Large document: sample and extrapolate
  let sampleHeight = 0;
  const step = Math.floor(totalLines / SAMPLE_SIZE);

  for (let i = 0; i < totalLines; i += step) {
    const line = getVisibleLine(state, i);
    if (line) {
      sampleHeight += estimateLineHeight(line, config);
    }
  }

  const sampledLines = Math.ceil(totalLines / step);
  const avgLineHeight = sampleHeight / sampledLines;

  return Math.ceil(totalLines * avgLineHeight);
}

// =============================================================================
// Position Calculations
// =============================================================================

/**
 * Convert a document byte position to line and column.
 */
export function positionToLineColumn(
  state: DocumentState,
  position: ByteOffset
): { line: number; column: number } | null {
  // Handle empty document (root is null but lineCount is 1)
  if (state.lineIndex.root === null) {
    if (position === 0) {
      return { line: 0, column: 0 };
    }
    return null;
  }

  const totalLines = getLineCountFromIndex(state.lineIndex);

  // Use findLineAtPosition to locate the line
  const lineInfo = findLineAtPosition(state.lineIndex.root, position);
  if (lineInfo) {
    // offsetInLine is the byte offset within the line
    // We need to convert to character offset
    const range = getLineRangePrecise(state.lineIndex, lineInfo.lineNumber);
    if (range) {
      const lineContent = getText(state.pieceTable, byteOffset(range.start), byteOffset(range.start + lineInfo.offsetInLine));
      return {
        line: lineInfo.lineNumber,
        column: lineContent.length,
      };
    }
  }

  // Check if position is at the very end of document
  const lastLineRange = getLineRangePrecise(state.lineIndex, totalLines - 1);
  if (lastLineRange) {
    const endOffset = lastLineRange.start + lastLineRange.length;
    if (position === endOffset) {
      const content = getText(state.pieceTable, byteOffset(lastLineRange.start), byteOffset(endOffset));
      return {
        line: totalLines - 1,
        column: content.length,
      };
    }
  }

  return null;
}

/**
 * Convert line and column to a document byte position.
 */
export function lineColumnToPosition(
  state: DocumentState,
  line: number,
  column: number
): ByteOffset | null {
  // Use getLineRangePrecise to handle dirty line indices correctly
  const range = getLineRangePrecise(state.lineIndex, line);
  if (!range) {
    return null;
  }

  const startOffset = range.start;
  const endOffset = range.start + range.length;
  const lineContent = getText(state.pieceTable, byteOffset(startOffset), byteOffset(endOffset));

  // Clamp column to line length
  const clampedColumn = Math.min(column, lineContent.length);

  // Convert character column to byte offset within the line
  const columnByteLen = textEncoder.encode(lineContent.slice(0, clampedColumn)).length;

  return byteOffset(startOffset + columnByteLen);
}

// =============================================================================
// Selection Offset Conversion
// =============================================================================

/**
 * Convert a byte-offset SelectionRange to a character-offset CharSelectionRange.
 * Useful for user-facing APIs where positions correspond to JavaScript string indices.
 */
export function selectionToCharOffsets(
  state: DocumentState,
  range: SelectionRange
): CharSelectionRange {
  const text = getValue(state.pieceTable);
  return Object.freeze({
    anchor: charOffset(byteToCharOffset(text, range.anchor)),
    head: charOffset(byteToCharOffset(text, range.head)),
  });
}

/**
 * Convert a character-offset CharSelectionRange to a byte-offset SelectionRange.
 * Useful for dispatching SET_SELECTION actions from user-facing character positions.
 */
export function charOffsetsToSelection(
  state: DocumentState,
  range: CharSelectionRange
): SelectionRange {
  const text = getValue(state.pieceTable);
  return Object.freeze({
    anchor: byteOffset(charToByteOffset(text, range.anchor)),
    head: byteOffset(charToByteOffset(text, range.head)),
  });
}
