/**
 * Rendering utilities for virtualized document display.
 * Provides efficient computation of visible lines and viewport management.
 */

import type { DocumentState, SelectionRange, CharSelectionRange } from "../../types/state.js";
import { byteOffset, charOffset, addByteOffset, type ByteOffset } from "../../types/branded.js";
import {
  $prove,
  $beginCost,
  $proveCtx,
  $checked,
  $from,
  $lift,
  $pipe,
  $andThen,
  $map,
  $zipCtx,
  type ConstCost,
  type CostFn,
  type LinearCost,
} from "../../types/cost-doc.js";
import {
  findLineAtPosition,
  findLineByNumber,
  getCharStartOffset,
  findLineAtCharPosition,
  getLineRangePrecise,
  getLineCountFromIndex,
  getResidentLineCountFromIndex,
} from "../core/line-index.js";
import { getText, getRawByte, isUtf8Boundary } from "../core/piece-table.js";

import { iterateLineRange } from "../core/line-index-query.js";

import { lineCharToByte, lineByteToChar } from "../core/line-offsets.js";

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
  readonly startOffset: ByteOffset;
  /** Byte offset where this line ends (exclusive) */
  readonly endOffset: ByteOffset;
  /** Whether this line ends with a newline */
  readonly hasNewline: boolean;
  /** UTF-16 column where bounded content starts, when a horizontal window is requested. */
  readonly contentStartColumn?: number;
  /** Whether the returned content omits part of the line. */
  readonly isTruncated?: boolean;
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
  /** First UTF-16 column to render. Defaults to zero. Surrogate pairs snap forward. */
  readonly startColumn?: number;
  /** Window width in UTF-16 units before boundary snapping, excluding newlines. */
  readonly maxColumns?: number;
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
  /** Expected total, including metadata for unloaded chunks. */
  readonly totalLines: number;
  /** Lines represented by the current resident piece/line trees. */
  readonly residentLineCount: number;
  /** Whether all declared chunk lines are resident. */
  readonly isComplete: boolean;
  /** `lines[*].lineNumber`, `firstLine`, and `lastLine` use resident coordinates. */
  readonly coordinateSpace: "resident";
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

interface RenderedLineText {
  readonly content: string;
  readonly hasNewline: boolean;
}

function toNonNegativeInteger(value: number, fallback: number = 0): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/**
 * Split a rendered line into display content plus a terminator flag.
 * Supports LF, CR, and CRLF without leaking terminator characters into UI text.
 */
function splitRenderedLineText(text: string): RenderedLineText {
  if (text.endsWith("\r\n")) {
    return { content: text.slice(0, -2), hasNewline: true };
  }
  if (text.endsWith("\n") || text.endsWith("\r")) {
    return { content: text.slice(0, -1), hasNewline: true };
  }
  return { content: text, hasNewline: false };
}

function createVisibleLine(
  lineNumber: number,
  startOffset: ByteOffset,
  endOffset: ByteOffset,
  rawContent: string,
): VisibleLine {
  const { content, hasNewline } = splitRenderedLineText(rawContent);
  return Object.freeze({
    lineNumber,
    content,
    startOffset,
    endOffset,
    hasNewline,
  });
}

/**
 * Calculate which lines are visible given a scroll position.
 */
export function getVisibleLineRange(
  scroll: ScrollPosition,
  totalLines: number,
  overscan: number = 5,
): ConstCost<{ startLine: number; endLine: number }> {
  const { scrollTop, lineHeight, viewportHeight } = scroll;
  const lineCount = toNonNegativeInteger(totalLines);
  const safeOverscan = toNonNegativeInteger(overscan);

  if (lineCount === 0) {
    return $proveCtx($beginCost("O(1)"), { startLine: 0, endLine: -1 });
  }

  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    return $proveCtx($beginCost("O(1)"), {
      startLine: 0,
      endLine: Math.min(lineCount - 1, safeOverscan),
    });
  }

  const safeScrollTop = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const safeViewportHeight = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const firstVisibleLine = Math.min(Math.floor(safeScrollTop / lineHeight), lineCount - 1);
  const visibleLineCount = Math.ceil(safeViewportHeight / lineHeight);
  const lastVisibleLine = firstVisibleLine + visibleLineCount;

  // Apply overscan
  const startLine = Math.max(0, firstVisibleLine - safeOverscan);
  const endLine = Math.min(lineCount - 1, lastVisibleLine + safeOverscan);

  return $proveCtx($beginCost("O(1)"), { startLine, endLine });
}

/**
 * Get the text content of a specific line using the line index for O(log n) lookup.
 *
 * Unlike `getLine()` from piece-table.ts which scans the entire document O(n),
 * this leverages the line index tree for efficient random access.
 *
 * @param state - The full document state (needs both pieceTable and lineIndex)
 * @param lineNum - 0-indexed line number
 * @returns The line text (without trailing newline), `null` if the line number is out
 * of range, or `''` if the line exists but has no content (e.g. a bare newline).
 */
export const getLineContent: CostFn<"linear", [DocumentState, number], string | null> = (
  state,
  lineNum,
) => {
  const range = getLineRangePrecise(state.lineIndex, lineNum);
  if (range === null) {
    return $proveCtx($beginCost("O(n)"), null);
  }

  return $prove(
    "O(n)",
    $checked(() =>
      $pipe(
        $from(range),
        $andThen((resolvedRange) =>
          $from(
            getText(
              state.pieceTable,
              resolvedRange.start,
              addByteOffset(resolvedRange.start, resolvedRange.length),
            ),
          ),
        ),
        $map((text: string) => splitRenderedLineText(text).content),
      ),
    ),
  );
};

/**
 * Compute visible lines for rendering.
 * Returns line content and metadata for efficient virtualized rendering.
 */
export function getVisibleLines(
  state: DocumentState,
  config: ViewportConfig,
): LinearCost<VisibleLinesResult> {
  const { startLine, visibleLineCount, overscan = 5 } = config;
  const totalLines = getLineCountFromIndex(state.lineIndex);
  const residentLineCount = state.lineIndex.lineCount;

  // Rendering coordinates describe the compact resident document. `totalLines`
  // remains the expected file count for scroll sizing, while the explicit
  // residency fields prevent callers from treating unloaded lines as renderable.
  const firstLine = Math.max(0, startLine - overscan);
  const lastLine = Math.min(residentLineCount - 1, startLine + visibleLineCount - 1 + overscan);

  const lines: VisibleLine[] = [];
  const requested: Array<{
    lineNumber: number;
    startOffset: ByteOffset;
    endOffset: ByteOffset;
    charLength: number;
  }> = [];

  for (const { node, lineNumber, startOffset } of iterateLineRange(
    state.lineIndex.root,
    firstLine,
    lastLine,
  )) {
    requested.push({
      lineNumber,
      startOffset: byteOffset(startOffset),
      endOffset: byteOffset(startOffset + node.lineLength),
      charLength: node.charLength,
    });
  }

  // Requested resident lines are contiguous. Read their bytes once, then split
  // the decoded string with the line index's UTF-16 char lengths. This avoids a
  // separate piece-tree traversal and allocation for every viewport line.
  if (config.startColumn !== undefined || config.maxColumns !== undefined) {
    const column = toNonNegativeInteger(config.startColumn ?? 0);
    const width =
      config.maxColumns === undefined ? Infinity : toNonNegativeInteger(config.maxColumns);
    for (const line of requested) {
      let contentEnd = line.endOffset as number;
      const lastByte =
        contentEnd > line.startOffset
          ? getRawByte(state.pieceTable, byteOffset(contentEnd - 1))
          : -1;
      if (lastByte === 10) contentEnd--;
      if (
        contentEnd > line.startOffset &&
        getRawByte(state.pieceTable, byteOffset(contentEnd - 1)) === 13
      )
        contentEnd--;
      const start = lineCharToByte(state.pieceTable, line.startOffset, line.endOffset, column);
      const clippedStart = Math.min(start, contentEnd);
      const end =
        width === Infinity
          ? contentEnd
          : Math.min(
              contentEnd,
              lineCharToByte(state.pieceTable, line.startOffset, line.endOffset, column + width),
            );
      lines.push(
        Object.freeze({
          lineNumber: line.lineNumber,
          startOffset: line.startOffset,
          endOffset: line.endOffset,
          content: getText(
            state.pieceTable,
            byteOffset(clippedStart),
            byteOffset(Math.max(clippedStart, end)),
          ),
          hasNewline: contentEnd < line.endOffset,
          contentStartColumn: lineByteToChar(
            state.pieceTable,
            line.startOffset,
            line.endOffset,
            clippedStart,
          ),
          isTruncated: clippedStart > line.startOffset || end < contentEnd,
        }),
      );
    }
  } else if (requested.length > 0) {
    const first = requested[0]!;
    const last = requested[requested.length - 1]!;
    const viewportText = getText(state.pieceTable, first.startOffset, last.endOffset);
    let charCursor = 0;
    for (const line of requested) {
      const rawContent = viewportText.slice(charCursor, charCursor + line.charLength);
      charCursor += line.charLength;
      lines.push(createVisibleLine(line.lineNumber, line.startOffset, line.endOffset, rawContent));
    }
  }

  return $proveCtx(
    $beginCost("O(n)"),
    Object.freeze({
      lines: Object.freeze(lines),
      firstLine,
      lastLine,
      totalLines,
      residentLineCount,
      isComplete: state.lineIndex.unloadedLineCount === 0,
      coordinateSpace: "resident" as const,
    }),
  );
}

/**
 * Get a single line for rendering.
 */
export function getVisibleLine(
  state: DocumentState,
  lineNumber: number,
): LinearCost<VisibleLine | null> {
  const residentLineCount = state.lineIndex.lineCount;

  if (lineNumber < 0 || lineNumber >= residentLineCount) {
    return $proveCtx($beginCost("O(n)"), null);
  }

  // Use getLineRangePrecise to handle dirty line indices correctly
  const range = getLineRangePrecise(state.lineIndex, lineNumber);
  if (!range) {
    return $proveCtx($beginCost("O(n)"), null);
  }

  return $prove(
    "O(n)",
    $checked(() =>
      $pipe(
        $from(range),
        $andThen((resolvedRange) =>
          $pipe(
            $from(
              getText(
                state.pieceTable,
                resolvedRange.start,
                addByteOffset(resolvedRange.start, resolvedRange.length),
              ),
            ),
            $map((text: string) => ({ resolvedRange, text })),
          ),
        ),
        $map(({ resolvedRange, text }) => {
          const startOffset = resolvedRange.start;
          const endOffset = addByteOffset(resolvedRange.start, resolvedRange.length);
          return createVisibleLine(lineNumber, startOffset, endOffset, text);
        }),
      ),
    ),
  );
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
export function estimateLineHeight(line: VisibleLine, config: LineHeightConfig): ConstCost<number> {
  if (!config.softWrap) {
    return $proveCtx($beginCost("O(1)"), config.baseLineHeight);
  }

  const charsPerLine = Math.floor(config.viewportWidth / config.charWidth);
  if (charsPerLine <= 0) {
    return $proveCtx($beginCost("O(1)"), config.baseLineHeight);
  }

  const wrappedLines = Math.ceil(line.content.length / charsPerLine) || 1;
  return $proveCtx($beginCost("O(1)"), wrappedLines * config.baseLineHeight);
}

/**
 * Compute wrapped line height from rendered line content.
 * Uses content with any CR/LF/CRLF terminator already stripped.
 */
function wrappedHeight(
  contentLength: number,
  charsPerLine: number,
  baseLineHeight: number,
): number {
  const wrappedLines = charsPerLine > 0 ? Math.ceil(contentLength / charsPerLine) || 1 : 1;
  return wrappedLines * baseLineHeight;
}

/**
 * Calculate total document height for scroll container sizing.
 */
export function estimateTotalHeight(
  state: DocumentState,
  config: LineHeightConfig,
): LinearCost<number> {
  const totalLines = getLineCountFromIndex(state.lineIndex);
  const residentLineCount = state.lineIndex.lineCount;

  if (!config.softWrap) {
    // Fixed height mode: simple multiplication
    return $proveCtx($beginCost("O(n)"), totalLines * config.baseLineHeight);
  }

  const SAMPLE_SIZE = 100;
  const charsPerLine = Math.floor(config.viewportWidth / config.charWidth);

  // Char lengths already include UTF-16 metrics. Only terminator bytes need reading.
  function heightAt(lineNumber: number): number | null {
    const node = findLineByNumber(state.lineIndex.root, lineNumber);
    const range = getLineRangePrecise(state.lineIndex, lineNumber);
    if (!node || !range) return null;
    let chars = node.charLength;
    const end = range.start + range.length;
    if (range.length > 0) {
      const last = getRawByte(state.pieceTable, byteOffset(end - 1));
      if (last === 10 || last === 13) chars--;
      if (
        last === 10 &&
        range.length > 1 &&
        getRawByte(state.pieceTable, byteOffset(end - 2)) === 13
      )
        chars--;
    }
    return wrappedHeight(chars, charsPerLine, config.baseLineHeight);
  }

  if (totalLines <= SAMPLE_SIZE) {
    let totalHeight = state.lineIndex.unloadedLineCount * config.baseLineHeight;
    for (let i = 0; i < residentLineCount; i++) totalHeight += heightAt(i) ?? 0;
    return $proveCtx($beginCost("O(n)"), totalHeight);
  }

  let sampleHeight = 0;
  const step = Math.max(1, Math.floor(residentLineCount / SAMPLE_SIZE));
  let sampledLines = 0;
  for (let i = 0; i < residentLineCount; i += step) {
    const height = heightAt(i);
    if (height !== null) {
      sampleHeight += height;
      sampledLines++;
    }
  }

  const avgLineHeight = sampledLines > 0 ? sampleHeight / sampledLines : config.baseLineHeight;

  const residentHeight = residentLineCount * avgLineHeight;
  const unloadedHeight = state.lineIndex.unloadedLineCount * config.baseLineHeight;
  return $proveCtx($beginCost("O(n)"), Math.ceil(residentHeight + unloadedHeight));
}

// =============================================================================
// Position Calculations
// =============================================================================

/**
 * Convert a document byte position to line and column.
 */
export function positionToLineColumn(
  state: DocumentState,
  position: ByteOffset,
): LinearCost<{ line: number; column: number } | null> {
  const totalLines = getResidentLineCountFromIndex(state.lineIndex);
  if (position <= state.pieceTable.totalLength && !isUtf8Boundary(state.pieceTable, position)) {
    return $proveCtx($beginCost("O(n)"), null);
  }

  // Use findLineAtPosition to locate the line
  const lineInfo = findLineAtPosition(state.lineIndex.root, position);
  if (lineInfo) {
    // offsetInLine is the byte offset within the line
    // We need to convert to character offset
    const range = getLineRangePrecise(state.lineIndex, lineInfo.lineNumber);
    if (range) {
      return $prove(
        "O(n)",
        $checked(() =>
          $pipe(
            $from(lineInfo),
            $andThen((resolvedLineInfo) =>
              $pipe(
                $from(range),
                $andThen((resolvedRange) =>
                  $pipe(
                    $from(
                      lineByteToChar(
                        state.pieceTable,
                        resolvedRange.start,
                        resolvedRange.start + resolvedRange.length,
                        resolvedRange.start + resolvedLineInfo.offsetInLine,
                      ),
                    ),
                    $map((column: number) => ({
                      line: resolvedLineInfo.lineNumber,
                      column,
                    })),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }
  }

  // Check if position is at the very end of document
  const lastLineRange = getLineRangePrecise(state.lineIndex, totalLines - 1);
  if (lastLineRange) {
    return $prove(
      "O(n)",
      $checked(() =>
        $pipe(
          $from(totalLines),
          $andThen((resolvedTotalLines) =>
            $pipe(
              $from(lastLineRange),
              $andThen((resolvedLastLineRange) => {
                const endOffset = addByteOffset(
                  resolvedLastLineRange.start,
                  resolvedLastLineRange.length,
                );
                if (position !== endOffset) {
                  return $lift<"O(n)", { line: number; column: number } | null>("O(n)", null);
                }
                return $pipe(
                  $from(
                    lineByteToChar(
                      state.pieceTable,
                      resolvedLastLineRange.start,
                      endOffset,
                      endOffset,
                    ),
                  ),
                  $map((column: number) => ({
                    line: resolvedTotalLines - 1,
                    column,
                  })),
                );
              }),
            ),
          ),
        ),
      ),
    );
  }

  return $proveCtx($beginCost("O(n)"), null);
}

/**
 * Convert line and column to a document byte position.
 *
 * The column is clamped to the length of the line, and a column that lands inside a code point
 * (between the two UTF-16 code units of a surrogate pair) snaps forward to the end of that
 * character, so the returned offset is always a UTF-8 code-point boundary. The snap is always
 * forward and is not reported back, so a caller building a range from two columns can see both
 * ends land on the same offset when they sit inside one character; snap the leading side backward
 * yourself if the range has to keep covering that character.
 */
export function lineColumnToPosition(
  state: DocumentState,
  line: number,
  column: number,
): LinearCost<ByteOffset | null> {
  const range = getLineRangePrecise(state.lineIndex, line);
  if (!range) return $proveCtx($beginCost("O(n)"), null);
  return $proveCtx(
    $beginCost("O(n)"),
    byteOffset(
      lineCharToByte(
        state.pieceTable,
        range.start,
        range.start + range.length,
        toNonNegativeInteger(column),
      ),
    ),
  );
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
function byteOffsetToCharOffset(state: DocumentState, position: ByteOffset): LinearCost<number> {
  if (position <= state.pieceTable.totalLength && !isUtf8Boundary(state.pieceTable, position)) {
    throw new RangeError(`selection offset (${position}) must be a UTF-8 code-point boundary`);
  }
  const posNum = position;
  if (posNum <= 0) return $proveCtx($beginCost("O(n)"), 0);

  const location = findLineAtPosition(state.lineIndex.root, position);
  if (location === null) {
    // Fallback: read from start (shouldn't happen with valid positions)
    const text = getText(state.pieceTable, byteOffset(0), position);
    return $proveCtx(
      "O(n)",
      $pipe(
        $from(text),
        $map((value) => value.length),
      ),
    );
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

  return $prove(
    "O(n)",
    $checked(() =>
      $pipe(
        $from(charStart),
        $andThen((resolvedCharStart) =>
          $pipe(
            $from(range),
            $andThen((resolvedRange) =>
              $pipe(
                $from(
                  lineByteToChar(
                    state.pieceTable,
                    resolvedRange.start,
                    resolvedRange.start + resolvedRange.length,
                    resolvedRange.start + location.offsetInLine,
                  ),
                ),
                $map((column: number) => resolvedCharStart + column),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * Convert a byte-offset SelectionRange to a character-offset CharSelectionRange.
 * Uses the line index to narrow reads to relevant lines instead of reading from byte 0.
 */
export function selectionToCharOffsets(
  state: DocumentState,
  range: SelectionRange,
): LinearCost<CharSelectionRange> {
  const anchor = byteOffsetToCharOffset(state, range.anchor);
  const head = byteOffsetToCharOffset(state, range.head);
  return $proveCtx(
    "O(n)",
    $zipCtx($from(anchor), $from(head), (anchorOffset, headOffset) =>
      Object.freeze({
        anchor: charOffset(anchorOffset),
        head: charOffset(headOffset),
      }),
    ),
  );
}

/**
 * Convert a single character offset to a byte offset using the line index.
 * Uses subtreeCharLength for O(log n) line lookup, then reads only the
 * target line to find the exact byte position.
 * O(log n + line_length) — contract-faithful.
 */
function charOffsetToByteOffset(state: DocumentState, charPos: number): LinearCost<ByteOffset> {
  if (charPos <= 0) {
    return $proveCtx($beginCost("O(n)"), byteOffset(0));
  }

  const location = findLineAtCharPosition(state.lineIndex.root, charPos);
  if (location === null) {
    // charPos is at or past end of document
    return $proveCtx($beginCost("O(n)"), byteOffset(state.pieceTable.totalLength));
  }

  // Get the byte range of the target line
  const range = getLineRangePrecise(state.lineIndex, location.lineNumber);
  if (range === null) {
    return $proveCtx($beginCost("O(n)"), byteOffset(state.pieceTable.totalLength));
  }

  return $proveCtx(
    $beginCost("O(n)"),
    byteOffset(
      lineCharToByte(
        state.pieceTable,
        range.start,
        range.start + range.length,
        location.charOffsetInLine,
      ),
    ),
  );
}

/**
 * Convert a character-offset CharSelectionRange to a byte-offset SelectionRange.
 * Uses the line index for O(log n + line_length) per offset — contract-faithful.
 */
export function charOffsetsToSelection(
  state: DocumentState,
  range: CharSelectionRange,
): LinearCost<SelectionRange> {
  const anchor = charOffsetToByteOffset(state, range.anchor);
  const head = charOffsetToByteOffset(state, range.head);
  return $proveCtx(
    "O(n)",
    $zipCtx($from(anchor), $from(head), (anchorOffset, headOffset) =>
      Object.freeze({
        anchor: anchorOffset,
        head: headOffset,
      }),
    ),
  );
}
