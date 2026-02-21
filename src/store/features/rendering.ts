/**
 * Rendering utilities for virtualized document display.
 * Provides efficient computation of visible lines and viewport management.
 */

import type { DocumentState, SelectionRange, CharSelectionRange } from '../../types/state.ts';
import type { ByteOffset, ConstCost, CostFn, LinearCost } from '../../types/branded.ts';
import { $, $cost, byteOffset, charOffset, addByteOffset, $mapCost, $zipCost } from '../../types/branded.ts';
import { findLineAtPosition, getCharStartOffset, findLineAtCharPosition, getLineRangePrecise, getLineCountFromIndex } from '../core/line-index.ts';
import { getText, charToByteOffset } from '../core/piece-table.ts';
import { textEncoder } from '../core/encoding.ts';

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
): ConstCost<{ startLine: number; endLine: number }> {
  const { scrollTop, lineHeight, viewportHeight } = scroll;

  const firstVisibleLine = Math.floor(scrollTop / lineHeight);
  const visibleLineCount = Math.ceil(viewportHeight / lineHeight);
  const lastVisibleLine = firstVisibleLine + visibleLineCount;

  // Apply overscan
  const startLine = Math.max(0, firstVisibleLine - overscan);
  const endLine = Math.min(totalLines - 1, lastVisibleLine + overscan);

  return $('O(1)', $cost({ startLine, endLine }));
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
export const getLineContent: CostFn<'linear', [DocumentState, number], string> = (state, lineNum) =>
{
  const range = getLineRangePrecise(state.lineIndex, lineNum);
  if (range === null) {
    // Keep linear-cost contract without assertion casting.
    return getText(state.pieceTable, byteOffset(0), byteOffset(0));
  }

  const raw = getText(state.pieceTable, range.start, addByteOffset(range.start, range.length as number));
  return $mapCost(raw, (text) => (text.endsWith('\n') ? text.slice(0, -1) : text));
};

/**
 * Compute visible lines for rendering.
 * Returns line content and metadata for efficient virtualized rendering.
 */
export function getVisibleLines(
  state: DocumentState,
  config: ViewportConfig
): LinearCost<VisibleLinesResult> {
  const { startLine, visibleLineCount, overscan = 5 } = config;
  const totalLines = getLineCountFromIndex(state.lineIndex);

  // Calculate actual range with overscan
  // startLine to startLine + visibleLineCount - 1 gives visibleLineCount lines
  const firstLine = Math.max(0, startLine - overscan);
  const lastLine = Math.min(totalLines - 1, startLine + visibleLineCount - 1 + overscan);

  const lines: VisibleLine[] = [];

  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    // Use getLineRangePrecise to handle dirty line indices correctly
    const range = getLineRangePrecise(state.lineIndex, lineNum);
    if (range) {
      const startOffset = range.start;
      const endOffset = addByteOffset(range.start, range.length as number);
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

  return $('O(n)', $cost(Object.freeze({
    lines: Object.freeze(lines),
    firstLine,
    lastLine,
    totalLines,
  })));
}

/**
 * Get a single line for rendering.
 */
export function getVisibleLine(
  state: DocumentState,
  lineNumber: number
): LinearCost<VisibleLine | null> {
  const totalLines = getLineCountFromIndex(state.lineIndex);

  if (lineNumber < 0 || lineNumber >= totalLines) {
    return $('O(n)', $cost(null));
  }

  // Use getLineRangePrecise to handle dirty line indices correctly
  const range = getLineRangePrecise(state.lineIndex, lineNumber);
  if (!range) {
    return $('O(n)', $cost(null));
  }

  const startOffset = range.start;
  const endOffset = addByteOffset(range.start, range.length as number);
  const rawContent = getText(state.pieceTable, startOffset, endOffset);

  return $mapCost(rawContent, (text) => {
    const hasNewline = text.endsWith('\n');
    const content = hasNewline ? text.slice(0, -1) : text;
    return Object.freeze({
      lineNumber,
      content,
      startOffset,
      endOffset,
      hasNewline,
    });
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
): ConstCost<number> {
  if (!config.softWrap) {
    return $('O(1)', $cost(config.baseLineHeight));
  }

  const charsPerLine = Math.floor(config.viewportWidth / config.charWidth);
  if (charsPerLine <= 0) {
    return $('O(1)', $cost(config.baseLineHeight));
  }

  const wrappedLines = Math.ceil(line.content.length / charsPerLine) || 1;
  return $('O(1)', $cost(wrappedLines * config.baseLineHeight));
}

/**
 * Calculate total document height for scroll container sizing.
 */
export function estimateTotalHeight(
  state: DocumentState,
  config: LineHeightConfig
): LinearCost<number> {
  const totalLines = getLineCountFromIndex(state.lineIndex);

  if (!config.softWrap) {
    // Fixed height mode: simple multiplication
    return $('O(n)', $cost(totalLines * config.baseLineHeight));
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
    return $('O(n)', $cost(totalHeight));
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

  return $('O(n)', $cost(Math.ceil(totalLines * avgLineHeight)));
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
): LinearCost<{ line: number; column: number } | null> {
  const totalLines = getLineCountFromIndex(state.lineIndex);

  // Use findLineAtPosition to locate the line
  const lineInfo = findLineAtPosition(state.lineIndex.root, position);
  if (lineInfo) {
    // offsetInLine is the byte offset within the line
    // We need to convert to character offset
    const range = getLineRangePrecise(state.lineIndex, lineInfo.lineNumber);
    if (range) {
      const lineContent = getText(state.pieceTable, range.start, addByteOffset(range.start, lineInfo.offsetInLine));
      return $mapCost(lineContent, (text) => ({
        line: lineInfo.lineNumber,
        column: text.length,
      }));
    }
  }

  // Check if position is at the very end of document
  const lastLineRange = getLineRangePrecise(state.lineIndex, totalLines - 1);
  if (lastLineRange) {
    const endOffset = addByteOffset(lastLineRange.start, lastLineRange.length as number);
    if (position === endOffset) {
      const content = getText(state.pieceTable, lastLineRange.start, endOffset);
      return $mapCost(content, (text) => ({
        line: totalLines - 1,
        column: text.length,
      }));
    }
  }

  return $('O(n)', $cost(null));
}

/**
 * Convert line and column to a document byte position.
 */
export function lineColumnToPosition(
  state: DocumentState,
  line: number,
  column: number
): LinearCost<ByteOffset | null> {
  // Use getLineRangePrecise to handle dirty line indices correctly
  const range = getLineRangePrecise(state.lineIndex, line);
  if (!range) {
    return $('O(n)', $cost(null));
  }

  const startOffset = range.start;
  const endOffset = addByteOffset(range.start, range.length as number);
  const lineContent = getText(state.pieceTable, startOffset, endOffset);

  // Clamp column to line length
  const clampedColumn = Math.min(column, lineContent.length);

  // Convert character column to byte offset within the line
  const columnByteLen = textEncoder.encode(lineContent.slice(0, clampedColumn)).length;

  return $mapCost(lineContent, () => byteOffset(startOffset + columnByteLen));
}

// =============================================================================
// Selection Offset Conversion
// =============================================================================

/**
 * Convert a single byte offset to a character offset using the line index.
 * Uses subtreeCharLength for O(log n) prefix sum, then reads only the
 * partial current line for the within-line offset.
 * O(log n + line_length) — contract-faithful.
 */
function byteOffsetToCharOffset(
  state: DocumentState,
  position: ByteOffset
): LinearCost<number> {
  const posNum = position as number;
  if (posNum <= 0) return $('O(n)', $cost(0));

  const location = findLineAtPosition(state.lineIndex.root, position);
  if (location === null) {
    // Fallback: read from start (shouldn't happen with valid positions)
    const text = getText(state.pieceTable, byteOffset(0), position);
    return $mapCost(text, value => value.length);
  }

  const charStart = getCharStartOffset(state.lineIndex.root, location.lineNumber);
  if (location.offsetInLine <= 0) {
    return charStart;
  }

  // Add chars within the current line up to the byte offset — O(line_length)
  const range = getLineRangePrecise(state.lineIndex, location.lineNumber);
  if (!range) {
    return charStart;
  }

  const partialText = getText(state.pieceTable, range.start, addByteOffset(range.start, location.offsetInLine));
  return $mapCost(partialText, (text) => (charStart as number) + text.length);
}

/**
 * Convert a byte-offset SelectionRange to a character-offset CharSelectionRange.
 * Uses the line index to narrow reads to relevant lines instead of reading from byte 0.
 */
export function selectionToCharOffsets(
  state: DocumentState,
  range: SelectionRange
): LinearCost<CharSelectionRange> {
  const anchor = byteOffsetToCharOffset(state, range.anchor);
  const head = byteOffsetToCharOffset(state, range.head);
  return $zipCost(anchor, head, (anchorOffset, headOffset) => Object.freeze({
    anchor: charOffset(anchorOffset),
    head: charOffset(headOffset),
  }));
}

/**
 * Convert a single character offset to a byte offset using the line index.
 * Uses subtreeCharLength for O(log n) line lookup, then reads only the
 * target line to find the exact byte position.
 * O(log n + line_length) — contract-faithful.
 */
function charOffsetToByteOffset(
  state: DocumentState,
  charPos: number
): LinearCost<ByteOffset> {
  if (charPos <= 0) {
    return $('O(n)', $cost(byteOffset(0)));
  }

  const location = findLineAtCharPosition(state.lineIndex.root, charPos);
  if (location === null) {
    // charPos is at or past end of document
    return $('O(n)', $cost(byteOffset(state.pieceTable.totalLength)));
  }

  // Get the byte range of the target line
  const range = getLineRangePrecise(state.lineIndex, location.lineNumber);
  if (range === null) {
    return $('O(n)', $cost(byteOffset(state.pieceTable.totalLength)));
  }

  // Read only this line's text and find the byte offset of the char within it
  const lineText = getText(state.pieceTable, range.start, addByteOffset(range.start, range.length as number));
  const charInLine = Math.min(location.charOffsetInLine, lineText.length);
  const byteInLine = charToByteOffset(lineText, charOffset(charInLine));

  return $mapCost(byteInLine, (offsetInLine) => addByteOffset(range.start, offsetInLine));
}

/**
 * Convert a character-offset CharSelectionRange to a byte-offset SelectionRange.
 * Uses the line index for O(log n + line_length) per offset — contract-faithful.
 */
export function charOffsetsToSelection(
  state: DocumentState,
  range: CharSelectionRange
): LinearCost<SelectionRange> {
  const anchor = charOffsetToByteOffset(state, range.anchor);
  const head = charOffsetToByteOffset(state, range.head);
  return $zipCost(anchor, head, (anchorOffset, headOffset) => Object.freeze({
    anchor: anchorOffset,
    head: headOffset,
  }));
}
