/**
 * Line Index operations with immutable Red-Black tree.
 * Maintains line positions for O(log n) line lookups.
 * All operations return new tree structures with structural sharing.
 *
 * Cost typing policy: use explicit boundaries (`$declare`, `$prove`, `$proveCtx`)
 * for compute regions (see `src/types/cost-doc.ts`).
 */

import type {
  LineIndexNode,
  LineIndexState,
  DirtyLineRange,
  DirtyLineRangeEntry,
  EvaluationMode,
} from '../../types/state.ts';
import { END_OF_DOCUMENT } from '../../types/state.ts';
import { byteOffset, byteLength as toByteLengthBrand, type ByteOffset, type ByteLength } from '../../types/branded.ts';
import type { ReadTextFn, DeleteBoundaryContext } from '../../types/operations.ts';
import {
  $prove,
  $proveCtx,
  $checked,
  $lift,
  $declare,
  $from,
  $pipe,
  $andThen,
  $map,
  type ConstCost,
  type LinearCost,
  type LogCost,
  type NLogNCost,
} from '../../types/cost-doc.ts';
import { asEagerLineIndex, createLineIndexNode, withLineIndexNode, withLineIndexState } from './state.ts';
import { fixInsertWithPath, fixRedViolations, isRed, type WithNodeFn, type InsertionPathEntry, type RootToLeafInsertPath } from './rb-tree.ts';

// Type-safe wrapper for withLineIndexNode to use with generic R-B tree functions
import { textEncoder } from './encoding.ts';

const withLine: WithNodeFn<LineIndexNode> = withLineIndexNode;

// =============================================================================
// Shared Helpers
// =============================================================================

/**
 * Find byte-offset positions of all line breaks in text,
 * and compute the total UTF-8 byte length.
 *
 * Supports LF (\n), CR (\r), and CRLF (\r\n) line endings.
 * For CRLF, records the position of '\n' so the break width is included.
 *
 * Encodes text to UTF-8 bytes once, then scans for 0x0A/0x0D.
 * This is correct because these ASCII bytes never appear in UTF-8 continuation bytes.
 */
function findNewlineBytePositions(text: string): { positions: number[]; byteLength: number } {
  const bytes = textEncoder.encode(text);
  const positions: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0D) {
      if (i + 1 < bytes.length && bytes[i + 1] === 0x0A) {
        positions.push(i + 1);
        i++;
      } else {
        positions.push(i);
      }
    } else if (bytes[i] === 0x0A) {
      positions.push(i);
    }
  }
  return { positions, byteLength: bytes.length };
}

/**
 * Count logical line breaks in text.
 * Treats LF, CR, and CRLF as one line break each.
 * Shared between eager and lazy delete operations.
 */
function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r') {
      count++;
      if (i + 1 < text.length && text[i + 1] === '\n') {
        i++;
      }
    } else if (text[i] === '\n') {
      count++;
    }
  }
  return count;
}

/**
 * Count how many logical line breaks are actually removed by a delete.
 * Uses optional one-char boundary context to correctly handle partial CRLF deletes.
 *
 * The context is needed when `lineIndexDelete`/`lineIndexDeleteLazy` is called
 * directly (e.g. in tests or undo/redo) with boundary characters that span a CRLF.
 * For example, deleting '\r' when nextChar='\n' removes 0 net line breaks (the
 * CRLF becomes a lone LF, which is still 1 line break). The before/after string
 * approach handles all such boundary effects correctly without special-casing.
 */
function countDeletedLineBreaks(
  deletedText: string,
  context?: DeleteBoundaryContext
): number {
  if (context === undefined || (context.prevChar === undefined && context.nextChar === undefined)) {
    return countNewlines(deletedText);
  }

  const before = `${context.prevChar ?? ''}${deletedText}${context.nextChar ?? ''}`;
  const after = `${context.prevChar ?? ''}${context.nextChar ?? ''}`;
  return Math.max(0, countNewlines(before) - countNewlines(after));
}

/**
 * Find UTF-16 positions of line-break endpoints in a string.
 * Supports LF, CR, and CRLF.
 */
function findNewlineCharPositions(text: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r') {
      if (i + 1 < text.length && text[i + 1] === '\n') {
        positions.push(i + 1);
        i++;
      } else {
        positions.push(i);
      }
    } else if (text[i] === '\n') {
      positions.push(i);
    }
  }
  return positions;
}

interface InsertBoundaryContext {
  prevChar?: string;
  nextChar?: string;
}

function getInsertBoundaryContext(
  position: ByteOffset,
  insertedByteLength: number,
  readText?: ReadTextFn
): InsertBoundaryContext {
  if (!readText) return {};

  const pos = position;

  // Reading pos-1 is safe here: only '\r' (0x0D, single-byte ASCII) is ever
  // checked against prevChar, and ASCII bytes never appear as UTF-8 continuation
  // bytes, so pos-1 is always a valid character boundary for our purposes.
  const prevChar = pos > 0
    ? readText(byteOffset(pos - 1), position)
    : '';
  const nextChar = readText(
    byteOffset(pos + insertedByteLength),
    byteOffset(pos + insertedByteLength + 1)
  );

  return {
    prevChar: prevChar.length > 0 ? prevChar : undefined,
    nextChar: nextChar.length > 0 ? nextChar : undefined,
  };
}

function hasCrossBoundaryCRLFMerge(text: string, context: InsertBoundaryContext): boolean {
  if (text.length === 0) return false;
  const mergesWithPrev = text[0] === '\n' && context.prevChar === '\r';
  const mergesWithNext = text[text.length - 1] === '\r' && context.nextChar === '\n';
  // Inserting between an existing CRLF pair breaks one logical separator into two
  // independent separators, which changes line count outside inserted text.
  const splitsExistingCRLF = context.prevChar === '\r' && context.nextChar === '\n';
  return mergesWithPrev || mergesWithNext || splitsExistingCRLF;
}

function rebuildFromReadText(
  state: LineIndexState,
  readText: ReadTextFn,
  reconciledVersion: number
): LineIndexState {
  const content = readText(byteOffset(0), byteOffset(END_OF_DOCUMENT));
  const rebuilt = buildLineIndexFromText(content, 0);
  return withLineIndexState(state, {
    root: rebuilt.root,
    lineCount: rebuilt.lineCount,
    dirtyRanges: Object.freeze([]),
    lastReconciledVersion: reconciledVersion,
    rebuildPending: false,
  });
}

// =============================================================================
// Types
// =============================================================================

/**
 * Result of finding a line at a document position.
 */
export interface LineLocation {
  /** The line node */
  node: LineIndexNode;
  /** Line number (0-indexed) */
  lineNumber: number;
  /** Offset within the line */
  offsetInLine: number;
}

// =============================================================================
// Tree Traversal
// =============================================================================

/**
 * Find the line containing a document position.
 * Returns the line number and offset within the line.
 */
export function findLineAtPosition(
  root: LineIndexNode | null,
  position: ByteOffset
): LogCost<LineLocation> | null {
  if (root === null) return null;
  if (position < 0) return null;

  let lineNumber = 0;
  let current: LineIndexNode | null = root;
  let pos: number = position; // Local mutable copy for tree traversal

  while (current !== null) {
    const leftLineCount = current.left?.subtreeLineCount ?? 0;
    const leftByteLength = current.left?.subtreeByteLength ?? 0;

    // Calculate the byte range of this line
    const lineStart = leftByteLength;
    const lineEnd = lineStart + current.lineLength;

    if (pos < lineStart) {
      // Position is in left subtree
      current = current.left;
    } else if (pos >= lineEnd && current.right !== null) {
      // Position is in right subtree
      lineNumber += leftLineCount + 1;
      pos -= lineEnd;
      current = current.right;
    } else {
      // Position is in this line (or at end and no right subtree)
      const node = current;
      const location = $proveCtx(
        'O(log n)',
        $lift('O(log n)', {
          node,
          lineNumber: lineNumber + leftLineCount,
          offsetInLine: pos - lineStart,
        })
      );
      return location;
    }
  }

  return null;
}

/**
 * Find a line by its line number (0-indexed).
 */
export function findLineByNumber(
  root: LineIndexNode | null,
  lineNumber: number
): LogCost<LineIndexNode> | null {
  if (root === null) return null;
  if (lineNumber < 0) return null;

  let current: LineIndexNode | null = root;

  while (current !== null) {
    const leftLineCount = current.left?.subtreeLineCount ?? 0;

    if (lineNumber < leftLineCount) {
      // Target is in left subtree
      current = current.left;
    } else if (lineNumber > leftLineCount) {
      // Target is in right subtree
      lineNumber -= leftLineCount + 1;
      current = current.right;
    } else {
      // This is the target line
      const line = $proveCtx('O(log n)', $lift('O(log n)', current));
      return line;
    }
  }

  return null;
}

/**
 * Get the document offset where a line starts.
 */
export function getLineStartOffset(
  root: LineIndexNode | null,
  lineNumber: number
): LogCost<number> {
  if (root === null) {
    const emptyOffset = $proveCtx('O(log n)', $lift('O(1)', 0));
    return emptyOffset;
  }
  if (lineNumber < 0) {
    const invalidOffset = $proveCtx('O(log n)', $lift('O(1)', 0));
    return invalidOffset;
  }

  let offset = 0;
  let current: LineIndexNode | null = root;
  let targetLine = lineNumber;
  let foundOffset: number | null = null;

  while (current !== null) {
    const leftLineCount = current.left?.subtreeLineCount ?? 0;
    const leftByteLength = current.left?.subtreeByteLength ?? 0;

    if (targetLine < leftLineCount) {
      // Target is in left subtree
      current = current.left;
    } else if (targetLine > leftLineCount) {
      // Target is in right subtree
      offset += leftByteLength + current.lineLength;
      targetLine -= leftLineCount + 1;
      current = current.right;
    } else {
      // This is the target line
      foundOffset = offset + leftByteLength;
      break;
    }
  }

  const startOffset = $proveCtx('O(log n)', $lift('O(log n)', foundOffset ?? offset));
  return startOffset;
}

/**
 * Get the character offset where a line starts.
 * O(log n) using subtreeCharLength aggregates.
 */
export function getCharStartOffset(
  root: LineIndexNode | null,
  lineNumber: number
): LogCost<number> {
  if (root === null) {
    const emptyOffset = $proveCtx('O(log n)', $lift('O(1)', 0));
    return emptyOffset;
  }
  if (lineNumber < 0) {
    const invalidOffset = $proveCtx('O(log n)', $lift('O(1)', 0));
    return invalidOffset;
  }

  let offset = 0;
  let current: LineIndexNode | null = root;
  let targetLine = lineNumber;
  let foundOffset: number | null = null;

  while (current !== null) {
    const leftLineCount = current.left?.subtreeLineCount ?? 0;
    const leftCharLength = current.left?.subtreeCharLength ?? 0;

    if (targetLine < leftLineCount) {
      current = current.left;
    } else if (targetLine > leftLineCount) {
      offset += leftCharLength + current.charLength;
      targetLine -= leftLineCount + 1;
      current = current.right;
    } else {
      foundOffset = offset + leftCharLength;
      break;
    }
  }

  const startOffset = $proveCtx('O(log n)', $lift('O(log n)', foundOffset ?? offset));
  return startOffset;
}

/**
 * Find the line containing a character offset.
 * O(log n) using subtreeCharLength aggregates.
 */
export function findLineAtCharPosition(
  root: LineIndexNode | null,
  charPosition: number
): LogCost<{ lineNumber: number; charOffsetInLine: number }> | null {
  if (root === null) return null;
  if (charPosition < 0) return null;

  let lineNumber = 0;
  let current: LineIndexNode | null = root;
  let pos = charPosition;

  while (current !== null) {
    const leftLineCount = current.left?.subtreeLineCount ?? 0;
    const leftCharLength = current.left?.subtreeCharLength ?? 0;

    const lineStart = leftCharLength;
    const lineEnd = lineStart + current.charLength;

    if (pos < lineStart) {
      current = current.left;
    } else if (pos >= lineEnd && current.right !== null) {
      lineNumber += leftLineCount + 1;
      pos -= lineEnd;
      current = current.right;
    } else {
      const location = $proveCtx(
        'O(log n)',
        $lift('O(log n)', {
          lineNumber: lineNumber + leftLineCount,
          charOffsetInLine: pos - lineStart,
        })
      );
      return location;
    }
  }

  return null;
}

/**
 * Collect all lines in order (in-order traversal).
 */
export function collectLines(root: LineIndexNode | null): LinearCost<readonly LineIndexNode[]> {
  const result: LineIndexNode[] = [];

  function inOrder(node: LineIndexNode | null) {
    if (node === null) return;
    inOrder(node.left);
    result.push(node);
    inOrder(node.right);
  }

  inOrder(root);
  return $proveCtx('O(n)', $lift('O(n)', result));
}

// =============================================================================
// Red-Black Tree Insert
// =============================================================================

/**
 * Insert a new line into the tree at the given line number.
 */
function rbInsertLine(
  root: LineIndexNode | null,
  lineNumber: number,
  documentOffset: number | null,
  lineLength: number,
  charLength: number = 0
): LineIndexNode {
  const newNode = createLineIndexNode(documentOffset, lineLength, 'red', null, null, charLength);

  if (root === null) {
    return withLineIndexNode(newNode, { color: 'black' });
  }

  // Insert using BST, collecting new nodes along insertion path
  const insertPath = bstInsertLine(root, lineNumber, newNode);
  // Fix Red-Black violations using path-based O(log n) approach
  return fixInsertWithPath(insertPath, withLine);
}

/**
 * BST insertion for line index that returns the insertion path of newly-created nodes.
 * The path is ordered root-to-leaf-parent.
 */
function bstInsertLine(
  root: LineIndexNode,
  lineNumber: number,
  newNode: LineIndexNode
): RootToLeafInsertPath<LineIndexNode> {
  const insertPath: InsertionPathEntry<LineIndexNode>[] = [];

  function insert(node: LineIndexNode, lineNum: number): LineIndexNode {
    const leftLineCount = node.left?.subtreeLineCount ?? 0;

    let result: LineIndexNode;
    let direction: 'left' | 'right';
    if (lineNum <= leftLineCount) {
      direction = 'left';
      if (node.left === null) {
        result = withLineIndexNode(node, { left: newNode });
      } else {
        result = withLineIndexNode(node, {
          left: insert(node.left, lineNum),
        });
      }
    } else {
      direction = 'right';
      const rightLineNumber = lineNum - leftLineCount - 1;
      if (node.right === null) {
        result = withLineIndexNode(node, { right: newNode });
      } else {
        result = withLineIndexNode(node, {
          right: insert(node.right, rightLineNumber),
        });
      }
    }
    insertPath.push({ node: result, direction });
    return result;
  }

  insert(root, lineNumber);
  insertPath.reverse(); // root-to-leaf-parent order
  return insertPath as RootToLeafInsertPath<LineIndexNode>;
}

// =============================================================================
// Line Index Update Operations
// =============================================================================

/**
 * Update the line index after text insertion.
 *
 * @param state - Current line index state
 * @param position - Document position where text was inserted
 * @param text - The inserted text
 * @returns New line index state
 */
export function lineIndexInsert(
  state: LineIndexState,
  position: ByteOffset,
  text: string,
  readText?: ReadTextFn
): LinearCost<LineIndexState> {
  if (text.length === 0) return $proveCtx('O(n)', $lift('O(n)', state));

  const { positions: newlinePositions, byteLength } = findNewlineBytePositions(text);
  const insertContext = getInsertBoundaryContext(position, byteLength, readText);

  // Boundary merge case (e.g. inserting '\r' before existing '\n').
  // Structural incremental logic assumes inserted line breaks are self-contained;
  // cross-boundary CRLF composition violates that assumption. Rebuild for correctness.
  if (readText && hasCrossBoundaryCRLFMerge(text, insertContext)) {
    return $proveCtx('O(n)', $lift('O(n)', rebuildFromReadText(state, readText, state.lastReconciledVersion)));
  }

  // If no newlines, just update the length of the affected line
  if (newlinePositions.length === 0) {
    return $proveCtx('O(n)', $lift('O(n)', updateLineLength(state, position, byteLength, text.length)));
  }

  const location: LogCost<LineLocation | null> =
    findLineAtPosition(state.root, position) ?? $proveCtx('O(log n)', $lift('O(log n)', null));

  return $prove('O(n)', $checked(() => $pipe(
    $from(location),
    $map((resolvedLocation) => {
      if (resolvedLocation === null) {
        // Position is at or past end - append to last line or create new
        return appendLines(state, position, text, newlinePositions, byteLength);
      }

      // Split the current line and insert new lines
      return insertLinesAtPosition(state, resolvedLocation, text, newlinePositions, byteLength, readText);
    }),
  )));
}

/**
 * Update line length when inserting text without newlines.
 */
function updateLineLength(
  state: LineIndexState,
  position: ByteOffset,
  lengthDelta: number,
  charLengthDelta: number = 0
): LineIndexState {
  if (state.root === null) {
    // Create first line
    const root = createLineIndexNode(0, lengthDelta, 'black', null, null, charLengthDelta);
    return withLineIndexState(state, {
      root,
      lineCount: 1,
      dirtyRanges: Object.freeze([]),
      rebuildPending: false,
    });
  }

  const newRoot = updateLineLengthInTree(state.root, position, lengthDelta, charLengthDelta);
  return withLineIndexState(state, {
    root: newRoot,
  });
}

/**
 * Update line length in the tree at the given position.
 */
function updateLineLengthInTree(
  node: LineIndexNode,
  position: number,
  lengthDelta: number,
  charLengthDelta: number = 0
): LineIndexNode {
  const leftByteLength = node.left?.subtreeByteLength ?? 0;
  const lineStart = leftByteLength;
  const lineEnd = lineStart + node.lineLength;

  if (position < lineStart && node.left !== null) {
    // Position is in left subtree
    return withLineIndexNode(node, {
      left: updateLineLengthInTree(node.left, position, lengthDelta, charLengthDelta),
    });
  } else if (position >= lineEnd && node.right !== null) {
    // Position is in right subtree
    return withLineIndexNode(node, {
      right: updateLineLengthInTree(node.right, position - lineEnd, lengthDelta, charLengthDelta),
    });
  } else {
    // Position is in this line - update its length
    return withLineIndexNode(node, {
      lineLength: node.lineLength + lengthDelta,
      charLength: node.charLength + charLengthDelta,
    });
  }
}

/**
 * Shared structural append: updates first line, inserts middle/last lines.
 * Handles the core logic shared between eager and lazy append operations.
 * Caller must handle the null-root case before calling this.
 */
function appendLinesStructural(
  root: LineIndexNode,
  lineCount: number,
  position: number,
  newlinePositions: number[],
  byteLength: number,
  text?: string
): { root: LineIndexNode; lineCount: number } {
  const totalLength = root.subtreeByteLength;

  // Compute char positions from text if available
  const charPositions = text ? findNewlineCharPositions(text) : [];
  const hasCharInfo = charPositions.length === newlinePositions.length;

  // Update the last line's length for text before first newline
  const firstNewlinePos = newlinePositions[0];
  const textBeforeFirstNewline = firstNewlinePos + 1; // Include the newline
  const firstCharDelta = hasCharInfo ? charPositions[0] + 1 : 0;

  let newRoot = root;

  // If inserting at end, we need to add to the last line
  if (position >= totalLength) {
    newRoot = addToLastLine(newRoot, textBeforeFirstNewline, firstCharDelta);
  } else {
    newRoot = updateLineLengthInTree(newRoot, position, textBeforeFirstNewline, firstCharDelta);
  }

  // Insert new lines for remaining newlines
  let currentOffset = position + textBeforeFirstNewline;
  for (let i = 1; i < newlinePositions.length; i++) {
    const lineLength = newlinePositions[i] - newlinePositions[i - 1];
    const lineCharLength = hasCharInfo ? charPositions[i] - charPositions[i - 1] : 0;
    newRoot = rbInsertLine(newRoot, lineCount, currentOffset, lineLength, lineCharLength);
    lineCount++;
    currentOffset += lineLength;
  }

  // Insert final line (text after last newline)
  const textAfterLastNewline = byteLength - newlinePositions[newlinePositions.length - 1] - 1;
  const lastCharLength = hasCharInfo ? (text!.length - charPositions[charPositions.length - 1] - 1) : 0;
  if (textAfterLastNewline > 0 || newlinePositions.length > 0) {
    newRoot = rbInsertLine(newRoot, lineCount, currentOffset, textAfterLastNewline, lastCharLength);
    lineCount++;
  }

  return { root: newRoot, lineCount };
}

/**
 * Append lines at the end of the document.
 */
function appendLines(
  state: LineIndexState,
  position: number,
  text: string,
  newlinePositions: number[],
  byteLength: number
): LineIndexState {
  if (state.root === null) {
    return withLineIndexState(state, buildLineIndexFromText(text, 0));
  }

  const result = appendLinesStructural(state.root, state.lineCount, position, newlinePositions, byteLength, text);

  return withLineIndexState(state, {
    root: result.root,
    lineCount: result.lineCount,
  });
}

/**
 * Add length to the last line in the tree.
 */
function addToLastLine(node: LineIndexNode, lengthDelta: number, charLengthDelta: number = 0): LineIndexNode {
  if (node.right !== null) {
    return withLineIndexNode(node, {
      right: addToLastLine(node.right, lengthDelta, charLengthDelta),
    });
  }
  return withLineIndexNode(node, {
    lineLength: node.lineLength + lengthDelta,
    charLength: node.charLength + charLengthDelta,
  });
}

/**
 * Shared structural insert: splits line at location, inserts middle/last lines.
 * `computeOffset` controls whether exact offsets or null placeholders are used.
 */
function insertLinesStructural(
  root: LineIndexNode,
  lineCount: number,
  location: LineLocation,
  newlinePositions: number[],
  byteLength: number,
  computeOffset: (lineNumber: number, prevOffset: number) => number | null,
  text?: string,
  charsBefore?: number
): { root: LineIndexNode; lineCount: number } {
  const { lineNumber, offsetInLine, node } = location;

  // Compute char positions from text if available
  const charPositions = text ? findNewlineCharPositions(text) : [];
  const hasCharInfo = text !== undefined && charsBefore !== undefined && charPositions.length === newlinePositions.length;

  // Calculate the parts of the split line
  const originalLineLength = node.lineLength;
  const beforeInsert = offsetInLine; // Text before insertion point
  const afterInsert = originalLineLength - offsetInLine; // Text after insertion point

  // First line: original text before insert + text up to first newline (including \n)
  const firstNewlinePos = newlinePositions[0];
  const firstLineLength = beforeInsert + firstNewlinePos + 1;
  const firstLineCharLength = hasCharInfo ? charsBefore! + charPositions[0] + 1 : undefined;

  // Update the current line to be the first part
  let newRoot = updateLineAtNumber(root, lineNumber, firstLineLength, firstLineCharLength);

  // Track cumulative offset for middle/last line insertion
  let prevOffset = firstLineLength;

  // Insert middle lines (between first and last newline)
  for (let i = 1; i < newlinePositions.length; i++) {
    const lineLength = newlinePositions[i] - newlinePositions[i - 1];
    const lineCharLength = hasCharInfo ? charPositions[i] - charPositions[i - 1] : 0;
    const offset = computeOffset(lineNumber + i, prevOffset);
    newRoot = rbInsertLine(newRoot, lineNumber + i, offset, lineLength, lineCharLength);
    lineCount++;
    prevOffset += lineLength;
  }

  // Last line: text after last newline + remaining original text
  const textAfterLastNewline = byteLength - newlinePositions[newlinePositions.length - 1] - 1;
  const lastLineLength = textAfterLastNewline + afterInsert;
  const lastCharLength = hasCharInfo
    ? (text!.length - charPositions[charPositions.length - 1] - 1) + (node.charLength - charsBefore!)
    : 0;

  const lastOffset = computeOffset(lineNumber + newlinePositions.length, prevOffset);
  newRoot = rbInsertLine(
    newRoot,
    lineNumber + newlinePositions.length,
    lastOffset,
    lastLineLength,
    lastCharLength
  );
  lineCount++;

  return { root: newRoot, lineCount };
}

/**
 * Insert lines at a specific position (splitting existing line).
 */
function insertLinesAtPosition(
  state: LineIndexState,
  location: LineLocation,
  text: string,
  newlinePositions: number[],
  byteLength: number,
  readText?: ReadTextFn
): LineIndexState {
  // Eager: compute real offsets relative to line start
  const lineStart = getLineStartOffset(state.root, location.lineNumber);

  // Compute charsBefore using readText if available
  let charsBefore: number | undefined;
  if (readText && location.offsetInLine > 0) {
    const prefixText = readText(byteOffset(lineStart), byteOffset(lineStart + location.offsetInLine));
    charsBefore = prefixText.length;
  } else if (location.offsetInLine === 0) {
    charsBefore = 0;
  }

  const result = insertLinesStructural(
    state.root!,
    state.lineCount,
    location,
    newlinePositions,
    byteLength,
    (_lineNumber, cumulativeFromFirstLine) => lineStart + cumulativeFromFirstLine,
    text,
    charsBefore
  );

  // Update offsets for all lines after the inserted ones
  const newRoot = updateOffsetsAfterLine(
    result.root,
    location.lineNumber + newlinePositions.length,
    byteLength
  );

  return withLineIndexState(state, {
    root: newRoot,
    lineCount: result.lineCount,
  });
}

/**
 * Update the line at a specific line number.
 */
function updateLineAtNumber(
  node: LineIndexNode,
  lineNumber: number,
  newLength: number,
  newCharLength?: number
): LineIndexNode {
  const leftLineCount = node.left?.subtreeLineCount ?? 0;

  if (lineNumber < leftLineCount && node.left !== null) {
    return withLineIndexNode(node, {
      left: updateLineAtNumber(node.left, lineNumber, newLength, newCharLength),
    });
  } else if (lineNumber > leftLineCount && node.right !== null) {
    return withLineIndexNode(node, {
      right: updateLineAtNumber(node.right, lineNumber - leftLineCount - 1, newLength, newCharLength),
    });
  } else {
    const updates: { lineLength: number; charLength?: number } = { lineLength: newLength };
    if (newCharLength !== undefined) updates.charLength = newCharLength;
    return withLineIndexNode(node, updates);
  }
}

/**
 * Update document offsets for all lines after a given line number.
 */
function updateOffsetsAfterLine(
  node: LineIndexNode,
  afterLineNumber: number,
  offsetDelta: number
): LineIndexNode {
  const leftLineCount = node.left?.subtreeLineCount ?? 0;
  const currentLineNumber = leftLineCount;

  let newLeft = node.left;
  let newRight = node.right;
  let newOffset = node.documentOffset;

  // Update left subtree if it contains lines after the threshold
  if (node.left !== null && afterLineNumber < leftLineCount) {
    newLeft = updateOffsetsAfterLine(node.left, afterLineNumber, offsetDelta);
  }

  // Update this node if it's after the threshold (skip null/pending nodes)
  if (currentLineNumber > afterLineNumber && newOffset !== null) {
    newOffset = newOffset + offsetDelta;
  }

  // Update right subtree (all lines in right are after current)
  if (node.right !== null && afterLineNumber <= currentLineNumber + (node.right.subtreeLineCount ?? 0)) {
    newRight = updateOffsetsAfterLine(node.right, afterLineNumber - currentLineNumber - 1, offsetDelta);
  }

  if (newLeft !== node.left || newRight !== node.right || newOffset !== node.documentOffset) {
    return withLineIndexNode(node, {
      left: newLeft,
      right: newRight,
      documentOffset: newOffset,
    });
  }

  return node;
}

/**
 * Build a line index from text content.
 */
function buildLineIndexFromText(text: string, startOffset: number): LineIndexState {
  const lines: { offset: number; length: number; charLength: number }[] = [];
  const { positions: breakBytes, byteLength } = findNewlineBytePositions(text);
  const breakChars = findNewlineCharPositions(text);

  let prevByte = 0;
  let prevChar = 0;

  for (let i = 0; i < breakBytes.length; i++) {
    const endByte = breakBytes[i] + 1; // Include the line-break endpoint byte
    const endChar = breakChars[i] + 1; // Include the line-break endpoint char
    lines.push({
      offset: startOffset + prevByte,
      length: endByte - prevByte,
      charLength: endChar - prevChar,
    });
    prevByte = endByte;
    prevChar = endChar;
  }

  // Final line (possibly empty when content ends with a line break).
  lines.push({
    offset: startOffset + prevByte,
    length: byteLength - prevByte,
    charLength: text.length - prevChar,
  });

  if (lines.length === 0) {
    return Object.freeze({
      root: null,
      lineCount: 1,
      dirtyRanges: Object.freeze([]),
      lastReconciledVersion: 0,
      rebuildPending: false,
      unloadedLineCountsByChunk: new Map<number, number>(),
    });
  }

  const root = buildBalancedTreeWithChars(lines, 0, lines.length - 1);
  return Object.freeze({
    root,
    lineCount: lines.length,
    dirtyRanges: Object.freeze([]),
    lastReconciledVersion: 0,
    rebuildPending: false,
    unloadedLineCountsByChunk: new Map<number, number>(),
  });
}

/**
 * Build a balanced tree from sorted line data with char lengths.
 */
function buildBalancedTreeWithChars(
  lines: { offset: number; length: number; charLength: number }[],
  start: number,
  end: number
): LineIndexNode | null {
  if (start > end) return null;

  const mid = Math.floor((start + end) / 2);
  const line = lines[mid];

  const left = buildBalancedTreeWithChars(lines, start, mid - 1);
  const right = buildBalancedTreeWithChars(lines, mid + 1, end);

  return createLineIndexNode(line.offset, line.length, 'black', left, right, line.charLength);
}

// =============================================================================
// Line Index Delete Operations
// =============================================================================

/**
 * Update the line index after text deletion.
 *
 * @param state - Current line index state
 * @param start - Start position of deletion
 * @param end - End position of deletion
 * @param deletedText - The text that was deleted (needed to count newlines)
 * @returns New line index state
 */
export function lineIndexDelete(
  state: LineIndexState,
  start: ByteOffset,
  end: ByteOffset,
  deletedText: string,
  deleteContext?: DeleteBoundaryContext
): NLogNCost<LineIndexState> {
  if (start >= end) return $proveCtx('O(n log n)', $lift('O(n log n)', state));
  if (state.root === null) return $proveCtx('O(n log n)', $lift('O(n log n)', state));

  const deleteLength = end - start;
  const deletedNewlines = countDeletedLineBreaks(deletedText, deleteContext);

  // If no newlines deleted, just update line length
  if (deletedNewlines === 0) {
    return $proveCtx('O(n log n)', $lift('O(n log n)', updateLineLength(state, start, -deleteLength, -deletedText.length)));
  }

  const startLocation: LogCost<LineLocation | null> =
    findLineAtPosition(state.root, start) ?? $proveCtx('O(log n)', $lift('O(log n)', null));

  return $prove('O(n log n)', $checked(() => $pipe(
    $from(startLocation),
    $map((resolvedLocation) => {
      if (resolvedLocation === null) return state;
      // Merge lines and remove deleted lines
      return deleteLineRange(state, resolvedLocation, deletedNewlines, deleteLength, deletedText.length);
    }),
  )));
}

/**
 * Delete a range of lines and merge.
 * Optimized to use single-pass tree reconstruction.
 */
function deleteLineRange(
  state: LineIndexState,
  startLocation: LineLocation,
  deletedNewlines: number,
  deleteLength: number,
  deletedCharLength: number
): LineIndexState {
  const { lineNumber: startLine, offsetInLine: startOffset } = startLocation;
  const endLine = startLine + deletedNewlines;

  // Find the end line to get its length
  const endNode = findLineByNumber(state.root, endLine);
  if (endNode === null) {
    // End line doesn't exist - delete to end of document
    return removeLinesToEnd(state, startLine, startOffset, deletedCharLength);
  }

  // Find the start line to get its length
  const startNode = findLineByNumber(state.root, startLine);
  if (startNode === null) {
    return state;
  }

  // Calculate merged line length
  const startLineLength = startNode.lineLength;
  const endLineLength = endNode.lineLength;

  // How much of the deletion falls on the start line (after startOffset)
  const deleteOnStartLine = startLineLength - startOffset;

  // Compute middle lines total via line start offsets — O(log n) instead of O(k * log n) loop
  const startLineStart = getLineStartOffset(state.root, startLine);
  const endLineStart = getLineStartOffset(state.root, endLine);
  const middleLinesTotal = endLineStart - startLineStart - startLineLength;
  const remainingDelete = deleteLength - deleteOnStartLine - middleLinesTotal;

  // What's left is deleted from the end line
  const deleteOnEndLine = Math.max(0, remainingDelete);
  const keepFromEndLine = Math.max(0, endLineLength - deleteOnEndLine);

  // Merged line length = what we keep from start + what we keep from end
  const mergedLength = startOffset + keepFromEndLine;

  // Compute merged char length
  const startLineCharStart = getCharStartOffset(state.root, startLine);
  let endBound: number;
  if (endLine + 1 < state.lineCount) {
    endBound = getCharStartOffset(state.root, endLine + 1);
  } else {
    endBound = state.root!.subtreeCharLength;
  }
  const mergedCharLength = Math.max(0, (endBound - startLineCharStart) - deletedCharLength);

  // Single-pass reconstruction: collect lines, skip deleted range, merge start/end
  return rebuildWithDeletedRange(state, state.root!, startLine, endLine, mergedLength, mergedCharLength);
}

/**
 * Rebuild tree with a range of lines deleted and merged.
 *
 * Uses incremental O(k * log n) approach:
 * 1. Update the start line to the merged length
 * 2. Remove deleted lines one by one via R-B tree deletion
 *
 * Falls back to O(n) rebuild only when removing most lines from the tree.
 */
function rebuildWithDeletedRange(
  state: LineIndexState,
  root: LineIndexNode,
  startLine: number,
  endLine: number,
  mergedLength: number,
  mergedCharLength: number = 0
): LineIndexState {
  const totalLines = root.subtreeLineCount;
  const deletedCount = endLine - startLine; // Lines being merged/removed
  const newLineCount = totalLines - deletedCount;

  if (newLineCount <= 0) {
    return withLineIndexState(state, {
      root: null,
      lineCount: 1,
      dirtyRanges: Object.freeze([]),
      lastReconciledVersion: 0,
      rebuildPending: false,
    });
  }

  // Use incremental deletion: O(k * log n) where k = deletedCount
  // 1. Update the start line's length to the merged length
  let newRoot: LineIndexNode | null = updateLineAtNumber(root, startLine, mergedLength, mergedCharLength);

  // 2. Remove deleted lines from endLine down to startLine+1
  //    (delete in reverse to keep line numbers stable)
  for (let i = endLine; i > startLine; i--) {
    if (newRoot === null) break;
    newRoot = rbDeleteLineByNumber(newRoot, startLine + 1);
  }

  if (newRoot === null) {
    return withLineIndexState(state, {
      root: null,
      lineCount: 1,
      dirtyRanges: Object.freeze([]),
      lastReconciledVersion: 0,
      rebuildPending: false,
    });
  }

  // Ensure root is black
  if (newRoot.color !== 'black') {
    newRoot = withLineIndexNode(newRoot, { color: 'black' });
  }

  return withLineIndexState(state, {
    root: newRoot,
    lineCount: newLineCount,
    dirtyRanges: Object.freeze([]),
    lastReconciledVersion: 0,
    rebuildPending: false,
  });
}

// =============================================================================
// R-B Tree Deletion (Immutable)
// =============================================================================

/**
 * Delete a line by its line number from the R-B tree.
 * Returns the new root, or null if the tree becomes empty.
 * Uses immutable path-copying approach.
 */
function rbDeleteLineByNumber(
  root: LineIndexNode,
  lineNumber: number
): LineIndexNode | null {
  const result = deleteNode(root, lineNumber);
  if (result === null) return null;
  // Ensure root is black
  if (result.color === 'red') {
    return withLineIndexNode(result, { color: 'black' });
  }
  return result;
}

/**
 * Recursively delete a node by line number.
 * Returns { node, needsFixup } where needsFixup indicates a double-black case.
 */
function deleteNode(
  node: LineIndexNode | null,
  lineNumber: number
): LineIndexNode | null {
  if (node === null) return null;

  const leftLineCount = node.left?.subtreeLineCount ?? 0;

  if (lineNumber < leftLineCount) {
    // Target is in left subtree
    const newLeft = deleteNode(node.left, lineNumber);
    const result = withLineIndexNode(node, { left: newLeft });
    return fixDeleteViolations(result);
  } else if (lineNumber > leftLineCount) {
    // Target is in right subtree
    const newRight = deleteNode(node.right, lineNumber - leftLineCount - 1);
    const result = withLineIndexNode(node, { right: newRight });
    return fixDeleteViolations(result);
  } else {
    // This is the node to delete
    return removeNode(node);
  }
}

/**
 * Remove a specific node from the tree.
 * Handles the three cases: leaf, one child, two children.
 */
function removeNode(node: LineIndexNode): LineIndexNode | null {
  // Case 1: Leaf node
  if (node.left === null && node.right === null) {
    return null;
  }

  // Case 2: One child
  if (node.left === null) {
    // Replace with right child, make it black
    return withLineIndexNode(node.right!, { color: 'black' });
  }
  if (node.right === null) {
    // Replace with left child, make it black
    return withLineIndexNode(node.left!, { color: 'black' });
  }

  // Case 3: Two children - replace with in-order successor (leftmost of right subtree)
  const { successor, newRight } = extractMin(node.right);

  // Create new node with successor's data but current node's children
  const replacement = createLineIndexNode(
    successor.documentOffset,
    successor.lineLength,
    node.color,
    node.left,
    newRight,
    successor.charLength
  );

  return fixDeleteViolations(replacement);
}

/**
 * Extract the minimum (leftmost) node from a subtree.
 * Returns the extracted node and the remaining tree.
 */
function extractMin(
  node: LineIndexNode
): { successor: LineIndexNode; newRight: LineIndexNode | null } {
  if (node.left === null) {
    // This is the minimum
    return { successor: node, newRight: node.right };
  }

  const { successor, newRight: newLeft } = extractMin(node.left);
  const result = withLineIndexNode(node, { left: newLeft });
  return { successor, newRight: fixDeleteViolations(result) };
}

/**
 * Fix R-B tree violations after deletion.
 * Handles double-black cases using rotations and recoloring.
 */
function fixDeleteViolations(node: LineIndexNode | null): LineIndexNode | null {
  if (node === null) return null;

  // Case: Red sibling on the left
  if (isRed(node.left) && node.left !== null) {
    // Check for red-red violations in left subtree
    if (isRed(node.left.left) || isRed(node.left.right)) {
      return fixRedViolations(node, withLine);
    }
  }

  // Case: Red sibling on the right
  if (isRed(node.right) && node.right !== null) {
    if (isRed(node.right.left) || isRed(node.right.right)) {
      return fixRedViolations(node, withLine);
    }
  }

  return node;
}

/**
 * Remove lines from a starting point to the end.
 */
function removeLinesToEnd(
  state: LineIndexState,
  startLine: number,
  startOffset: number,
  deletedCharLength?: number
): LineIndexState {
  const lines = collectLines(state.root);
  const newLines: { offset: number; length: number; charLength: number }[] = [];

  let currentOffset = 0;
  for (let i = 0; i < startLine && i < lines.length; i++) {
    newLines.push({ offset: currentOffset, length: lines[i].lineLength, charLength: lines[i].charLength });
    currentOffset += lines[i].lineLength;
  }

  // Add partial last line if there's content before the deletion
  if (startOffset > 0 && startLine < lines.length) {
    // Compute charLength for the truncated line
    let totalCharsFromStartToEnd = 0;
    for (let i = startLine; i < lines.length; i++) {
      totalCharsFromStartToEnd += lines[i].charLength;
    }
    const truncatedCharLength = deletedCharLength !== undefined
      ? totalCharsFromStartToEnd - deletedCharLength
      : 0;
    newLines.push({ offset: currentOffset, length: startOffset, charLength: Math.max(0, truncatedCharLength) });
  }

  if (newLines.length === 0) {
    return withLineIndexState(state, {
      root: null,
      lineCount: 1,
      dirtyRanges: Object.freeze([]),
      lastReconciledVersion: 0,
      rebuildPending: false,
    });
  }

  const root = buildBalancedTreeWithChars(newLines, 0, newLines.length - 1);
  return withLineIndexState(state, {
    root,
    lineCount: newLines.length,
    dirtyRanges: Object.freeze([]),
    lastReconciledVersion: 0,
    rebuildPending: false,
  });
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Rebuild the line index from document content.
 * Use this when the line index gets out of sync.
 */
export function rebuildLineIndex(content: string): LinearCost<LineIndexState> {
  return $proveCtx('O(n)', $lift('O(n)', buildLineIndexFromText(content, 0)));
}

/**
 * Get line count from the state.
 * Includes lines declared via DECLARE_CHUNK_METADATA for chunks not yet loaded,
 * so callers can query the total expected line count before all chunks arrive.
 *
 * Cost: O(k) where k = number of declared-but-unloaded chunks (bounded by total
 * chunk count, not document size). Declared O(1) by convention since k is small.
 */
export function getLineCountFromIndex(state: LineIndexState): ConstCost<number> {
  let total = state.lineCount;
  for (const count of state.unloadedLineCountsByChunk.values()) {
    total += count;
  }
  // k (declared chunks) is document-size-independent; treat as O(1) per policy.
  return $declare('O(1)', total);
}

/**
 * Get a line's content range (start offset and length).
 * Requires eager state — calling on lazy state with dirty ranges is a compile error.
 * Use `getLineRangePrecise` for state that may have dirty ranges.
 */
export function getLineRange(
  state: LineIndexState<'eager'>,
  lineNumber: number
): LogCost<{ start: ByteOffset; length: ByteLength }> | null {
  const node = findLineByNumber(state.root, lineNumber);
  if (node === null) return null;

  return $prove('O(log n)', $checked(() => $pipe(
    $from(node),
    $andThen((resolvedNode) => $pipe(
      $from(getLineStartOffset(state.root, lineNumber)),
      $map((start) => ({ start: byteOffset(start), length: toByteLengthBrand(resolvedNode.lineLength) })),
    )),
  )));
}

// =============================================================================
// Dirty Range Management (Lazy Line Index Maintenance)
// =============================================================================

/**
 * Merge overlapping or adjacent dirty ranges to minimize tracking overhead.
 */
export function mergeDirtyRanges(
  ranges: readonly DirtyLineRange[]
): NLogNCost<readonly DirtyLineRange[]> {
  if (ranges.length <= 1) return $proveCtx('O(n log n)', $lift('O(n log n)', [...ranges]));

  // If any range is a sentinel (full-rebuild marker), the merged result must also be a sentinel.
  // With a discriminated union, no spread accident can silently drop or create a sentinel.
  if (ranges.some(r => r.kind === 'sentinel')) {
    return $proveCtx(
      'O(n log n)',
      $lift<'O(n log n)', readonly DirtyLineRange[]>(
        'O(n log n)',
        [Object.freeze({ kind: 'sentinel' as const })]
      )
    );
  }

  // Sort by startLine — skip sort if already in order (common case: appended sequentially).
  // Safe to narrow: the sentinel early-exit above guarantees all remaining ranges are 'range'.
  let needsSort = false;
  for (let j = 1; j < ranges.length; j++) {
    if ((ranges[j] as DirtyLineRangeEntry).startLine < (ranges[j - 1] as DirtyLineRangeEntry).startLine) { needsSort = true; break; }
  }
  const sorted = (needsSort ? [...ranges].sort((a, b) => (a as DirtyLineRangeEntry).startLine - (b as DirtyLineRangeEntry).startLine) : [...ranges]) as DirtyLineRangeEntry[];
  const merged: DirtyLineRange[] = [];
  let i = 0;
  // Loop invariant: `current` is the "in-flight" range — it has NOT yet been
  // pushed to `merged`. Every range in `merged` is fully resolved and will
  // never be revisited. `current` is finalized either:
  //   (a) post-loop via `if (!exhausted) merged.push(current)`, or
  //   (b) mid-loop in the e1===e2 branch, which sets `exhausted = true` to
  //       prevent (a) from double-counting it.
  let current = sorted[0];
  let exhausted = false;

  while (i < sorted.length - 1) {
    i++;
    const next = sorted[i];
    if (next.startLine <= current.endLine + 1) {
      if (next.offsetDelta === current.offsetDelta && next.startLine > current.endLine) {
        // Adjacent (non-overlapping) same delta — extend current to cover both
        current = Object.freeze({
          kind: 'range' as const,
          startLine: current.startLine,
          endLine: Math.max(current.endLine, next.endLine),
          offsetDelta: current.offsetDelta,
        });
      } else if (next.startLine === current.startLine) {
        // Same start, different delta — sum deltas (equivalent to applying both)
        current = Object.freeze({
          kind: 'range' as const,
          startLine: current.startLine,
          endLine: Math.max(current.endLine, next.endLine),
          offsetDelta: current.offsetDelta + next.offsetDelta,
        });
      } else {
        // True overlap: s1 < s2 <= e1, different deltas.
        // Decompose into: [s1, s2-1, d1], [s2, min(e1,e2), d1+d2], tail.
        merged.push(Object.freeze({
          kind: 'range' as const,
          startLine: current.startLine,
          endLine: next.startLine - 1,
          offsetDelta: current.offsetDelta,
        }));
        const combinedDelta = current.offsetDelta + next.offsetDelta;
        if (current.endLine < next.endLine) {
          // current ends first — overlap ends at current.endLine
          merged.push(Object.freeze({
            kind: 'range' as const,
            startLine: next.startLine,
            endLine: current.endLine,
            offsetDelta: combinedDelta,
          }));
          current = Object.freeze({
            kind: 'range' as const,
            startLine: current.endLine + 1,
            endLine: next.endLine,
            offsetDelta: next.offsetDelta,
          });
        } else if (current.endLine > next.endLine) {
          // next ends first — overlap ends at next.endLine
          merged.push(Object.freeze({
            kind: 'range' as const,
            startLine: next.startLine,
            endLine: next.endLine,
            offsetDelta: combinedDelta,
          }));
          current = Object.freeze({
            kind: 'range' as const,
            startLine: next.endLine + 1,
            endLine: current.endLine,
            offsetDelta: current.offsetDelta,
          });
        } else {
          // e1 === e2: both ranges fully consumed by the overlap — no tail remains.
          // Push `current` into `merged` here (it is now resolved) and advance `i`
          // to the next input range. If that exhausts the input, set `exhausted` so
          // the post-loop push is skipped — `current` is already in `merged`.
          merged.push(Object.freeze({
            kind: 'range' as const,
            startLine: next.startLine,
            endLine: current.endLine,
            offsetDelta: combinedDelta,
          }));
          i++;
          if (i >= sorted.length) { exhausted = true; break; }
          current = sorted[i];
        }
      }
    } else {
      // No overlap — finalize current, start fresh
      merged.push(current);
      current = next;
    }
  }
  // Finalize the last in-flight range, unless the e1===e2 branch already pushed
  // it into `merged` mid-loop (signalled by `exhausted`).
  if (!exhausted) merged.push(current);

  // Safety cap: if too many ranges accumulated, collapse to full-document rebuild
  if (merged.length > 32) {
    return $proveCtx(
      'O(n log n)',
      $lift<'O(n log n)', readonly DirtyLineRange[]>(
        'O(n log n)',
        [Object.freeze({ kind: 'sentinel' as const })]
      )
    );
  }

  return $proveCtx(
    'O(n log n)',
    $lift<'O(n log n)', readonly DirtyLineRange[]>('O(n log n)', merged)
  );
}

/**
 * Check if a line number falls within any dirty range.
 */
export function isLineDirty(
  dirtyRanges: readonly DirtyLineRange[],
  lineNumber: number
): LinearCost<boolean> {
  return $proveCtx('O(n)', $lift('O(n)', dirtyRanges.some(
    r => r.kind === 'sentinel' || (lineNumber >= r.startLine && lineNumber <= r.endLine)
  )));
}

/**
 * Get the cumulative offset delta for a line number.
 */
export function getOffsetDeltaForLine(
  dirtyRanges: readonly DirtyLineRange[],
  lineNumber: number
): LinearCost<number> {
  let delta = 0;
  for (const range of dirtyRanges) {
    if (range.kind === 'sentinel') continue; // Sentinel has no delta info; handled by reconcileFull slow path
    if (lineNumber >= range.startLine && lineNumber <= range.endLine) {
      delta += range.offsetDelta;
    }
  }
  return $proveCtx('O(n)', $lift('O(n)', delta));
}

/**
 * Create a new dirty range.
 */
function createDirtyRange(
  startLine: number,
  endLine: number,
  offsetDelta: number
): DirtyLineRangeEntry {
  return Object.freeze({
    kind: 'range' as const,
    startLine,
    endLine,
    offsetDelta,
  });
}

/**
 * Remap dirty range line numbers after inserting `insertedCount` new lines at `insertionLine+1`.
 * Lines 0..insertionLine keep their indices; lines insertionLine+1..N shift up by insertedCount.
 * Ranges that span the insertion point are split into a before-part and a shifted after-part.
 */
function remapDirtyRangesForInsert(
  ranges: readonly DirtyLineRange[],
  insertionLine: number,
  insertedCount: number
): readonly DirtyLineRange[] {
  if (ranges.length === 0 || insertedCount === 0) return ranges;
  const result: DirtyLineRange[] = [];
  for (const range of ranges) {
    if (range.kind === 'sentinel') { result.push(range); continue; }
    const { startLine: s, endLine: e, offsetDelta: d } = range;
    if (e < insertionLine + 1) {
      // Entirely at or before insertionLine — indices unchanged
      result.push(range);
    } else if (s > insertionLine) {
      // Entirely after insertionLine — shift both bounds up
      result.push(Object.freeze({
        kind: 'range' as const,
        startLine: s + insertedCount,
        endLine: e === END_OF_DOCUMENT ? e : e + insertedCount,
        offsetDelta: d,
      }));
    } else {
      // Spans the insertion: s <= insertionLine < insertionLine+1 <= e
      // Before part: s..insertionLine — indices unchanged
      result.push(Object.freeze({ kind: 'range' as const, startLine: s, endLine: insertionLine, offsetDelta: d }));
      // After part: old insertionLine+1..e → new insertionLine+insertedCount+1..e+insertedCount
      result.push(Object.freeze({
        kind: 'range' as const,
        startLine: insertionLine + 1 + insertedCount,
        endLine: e === END_OF_DOCUMENT ? e : e + insertedCount,
        offsetDelta: d,
      }));
    }
  }
  return result;
}

/**
 * Remap dirty range line numbers after deleting lines deleteZoneStart..deleteZoneEnd (inclusive).
 * Lines 0..deleteZoneStart-1 keep their indices; lines in the deleted zone are dropped;
 * lines deleteZoneEnd+1..N shift down by (deleteZoneEnd - deleteZoneStart + 1).
 */
function remapDirtyRangesForDelete(
  ranges: readonly DirtyLineRange[],
  deleteZoneStart: number,
  deleteZoneEnd: number,
): readonly DirtyLineRange[] {
  const deletedCount = deleteZoneEnd - deleteZoneStart + 1;
  if (ranges.length === 0 || deletedCount <= 0) return ranges;
  const result: DirtyLineRange[] = [];
  for (const range of ranges) {
    if (range.kind === 'sentinel') { result.push(range); continue; }
    const { startLine: s, endLine: e, offsetDelta: d } = range;
    // Before zone: keep s..min(e, deleteZoneStart-1) unchanged
    if (s < deleteZoneStart) {
      result.push(Object.freeze({
        kind: 'range' as const,
        startLine: s,
        endLine: Math.min(e, deleteZoneStart - 1),
        offsetDelta: d,
      }));
    }
    // After zone: shift max(s, deleteZoneEnd+1)..e down by deletedCount
    const postStart = Math.max(s, deleteZoneEnd + 1);
    if (postStart <= e) {
      result.push(Object.freeze({
        kind: 'range' as const,
        startLine: postStart - deletedCount,
        endLine: e === END_OF_DOCUMENT ? e : e - deletedCount,
        offsetDelta: d,
      }));
    }
  }
  return result;
}

// =============================================================================
// Lazy Line Index Operations
// =============================================================================

/**
 * Insert text with lazy offset updates.
 * Updates line lengths and structure immediately, but defers offset recalculation
 * to idle time for lines after the insertion point.
 */
export function lineIndexInsertLazy(
  state: LineIndexState,
  position: ByteOffset,
  text: string,
  currentVersion: number,
  readText?: ReadTextFn
): LinearCost<LineIndexState> {
  if (text.length === 0) return $proveCtx('O(n)', $lift('O(n)', state));

  const { positions: newlinePositions, byteLength } = findNewlineBytePositions(text);
  const insertContext = getInsertBoundaryContext(position, byteLength, readText);

  // Same cross-boundary CRLF case as eager insert; rebuild to guarantee correctness.
  if (readText && hasCrossBoundaryCRLFMerge(text, insertContext)) {
    return $proveCtx('O(n)', $lift('O(n)', rebuildFromReadText(state, readText, currentVersion)));
  }

  // No newlines: simple length update (O(log n), no lazy needed)
  if (newlinePositions.length === 0) {
    return $proveCtx('O(n)', $lift('O(n)', updateLineLengthLazy(state, position, byteLength, text.length)));
  }

  const location: LogCost<LineLocation | null> =
    findLineAtPosition(state.root, position) ?? $proveCtx('O(log n)', $lift('O(log n)', null));

  return $prove('O(n)', $checked(() => $pipe(
    $from(location),
    $map((resolvedLocation) => {
      if (resolvedLocation === null) {
        // Position at or past end - use eager approach for simplicity
        return appendLinesLazy(state, position, text, newlinePositions, byteLength, currentVersion);
      }

      // Insert new lines and mark downstream as dirty
      return insertLinesAtPositionLazy(state, resolvedLocation, text, newlinePositions, byteLength, currentVersion, readText);
    }),
  )));
}

// updateLineLengthLazy is identical to updateLineLength - reuse it directly
const updateLineLengthLazy = updateLineLength;

/**
 * Append lines at the end with lazy tracking.
 */
function appendLinesLazy(
  state: LineIndexState,
  position: number,
  text: string,
  newlinePositions: number[],
  byteLength: number,
  currentVersion: number
): LineIndexState {
  if (state.root === null) {
    const newState = buildLineIndexFromText(text, 0);
    return withLineIndexState(state, {
      root: newState.root,
      lineCount: newState.lineCount,
      dirtyRanges: Object.freeze([]),
      lastReconciledVersion: currentVersion,
      rebuildPending: false,
    });
  }

  // For appending at end, offsets are naturally correct (no dirty ranges needed)
  const result = appendLinesStructural(state.root, state.lineCount, position, newlinePositions, byteLength, text);

  return withLineIndexState(state, {
    root: result.root,
    lineCount: result.lineCount,
  });
}

/**
 * Insert lines at a specific position with lazy offset tracking.
 */
function insertLinesAtPositionLazy(
  state: LineIndexState,
  location: LineLocation,
  text: string,
  newlinePositions: number[],
  byteLength: number,
  _currentVersion: number,
  readText?: ReadTextFn
): LineIndexState {
  // Compute charsBefore using readText if available
  let charsBefore: number | undefined;
  if (readText && location.offsetInLine > 0) {
    const lineStart = getLineStartOffset(state.root, location.lineNumber);
    const prefixText = readText(byteOffset(lineStart), byteOffset(lineStart + location.offsetInLine));
    charsBefore = prefixText.length;
  } else if (location.offsetInLine === 0) {
    charsBefore = 0;
  }

  // Lazy: use null placeholder for all new line offsets
  const result = insertLinesStructural(
    state.root!,
    state.lineCount,
    location,
    newlinePositions,
    byteLength,
    () => null,
    text,
    charsBefore
  );

  // Remap existing dirty ranges to new tree line numbering before merging
  const remappedRanges = remapDirtyRangesForInsert(state.dirtyRanges, location.lineNumber, newlinePositions.length);

  // Mark all lines after the insertion as dirty (they have stale offsets)
  const newDirtyRange = createDirtyRange(
    location.lineNumber + 1, // First inserted line and all after
    END_OF_DOCUMENT, // To end of document
    byteLength // Offset delta
  );

  const mergedRanges = mergeDirtyRanges([...remappedRanges, newDirtyRange]);

  return withLineIndexState(state, {
    root: result.root,
    lineCount: result.lineCount,
    dirtyRanges: Object.freeze(mergedRanges),
    rebuildPending: true,
  });
}

/**
 * Delete text with lazy offset updates.
 */
export function lineIndexDeleteLazy(
  state: LineIndexState,
  start: ByteOffset,
  end: ByteOffset,
  deletedText: string,
  currentVersion: number,
  deleteContext?: DeleteBoundaryContext
): NLogNCost<LineIndexState> {
  if (start >= end) return $proveCtx('O(n log n)', $lift('O(n log n)', state));
  if (state.root === null) return $proveCtx('O(n log n)', $lift('O(n log n)', state));

  const deleteLength = end - start;
  const deletedNewlines = countDeletedLineBreaks(deletedText, deleteContext);

  // No newlines: just update line length
  if (deletedNewlines === 0) {
    return $proveCtx('O(n log n)', $lift('O(n log n)', updateLineLengthLazy(state, start, -deleteLength, -deletedText.length)));
  }

  const startLocation: LogCost<LineLocation | null> =
    findLineAtPosition(state.root, start) ?? $proveCtx('O(log n)', $lift('O(log n)', null));

  return $prove('O(n log n)', $checked(() => $pipe(
    $from(startLocation),
    $map((resolvedLocation) => {
      if (resolvedLocation === null) return state;
      // Delete lines and mark remaining as dirty
      return deleteLineRangeLazy(
        state,
        resolvedLocation,
        deletedNewlines,
        deleteLength,
        currentVersion,
        deletedText.length
      );
    }),
  )));
}

/**
 * Delete a range of lines with lazy offset tracking.
 */
function deleteLineRangeLazy(
  state: LineIndexState,
  startLocation: LineLocation,
  deletedNewlines: number,
  deleteLength: number,
  currentVersion: number,
  deletedCharLength: number
): LineIndexState {
  const { lineNumber: startLine, offsetInLine: startOffset } = startLocation;
  const endLine = startLine + deletedNewlines;

  const endNode = findLineByNumber(state.root, endLine);
  if (endNode === null) {
    return removeLinesToEndLazy(state, startLine, startOffset, currentVersion, deletedCharLength);
  }

  const startNode = findLineByNumber(state.root, startLine);
  if (startNode === null) return state;

  // Calculate merged line length
  const startLineLength = startNode.lineLength;
  const endLineLength = endNode.lineLength;
  const deleteOnStartLine = startLineLength - startOffset;

  // Compute middle lines total via line start offsets — O(log n) instead of O(k * log n) loop
  const startLineStart = getLineStartOffset(state.root, startLine);
  const endLineStart = getLineStartOffset(state.root, endLine);
  const middleLinesTotal = endLineStart - startLineStart - startLineLength;
  const remainingDelete = deleteLength - deleteOnStartLine - middleLinesTotal;

  const deleteOnEndLine = Math.max(0, remainingDelete);
  const keepFromEndLine = Math.max(0, endLineLength - deleteOnEndLine);
  const mergedLength = startOffset + keepFromEndLine;

  // Compute merged char length
  const startLineCharStart = getCharStartOffset(state.root, startLine);
  let endBound: number;
  if (endLine + 1 < state.lineCount) {
    endBound = getCharStartOffset(state.root, endLine + 1);
  } else {
    endBound = state.root!.subtreeCharLength;
  }
  const mergedCharLength = Math.max(0, (endBound - startLineCharStart) - deletedCharLength);

  // Rebuild with deleted range (this is still O(n) for deletions with newlines)
  // Future optimization: track deleted ranges for lazy reconciliation
  const newState = rebuildWithDeletedRange(state, state.root!, startLine, endLine, mergedLength, mergedCharLength);

  // Remap existing dirty ranges to new tree line numbering before merging
  const remappedRanges = remapDirtyRangesForDelete(state.dirtyRanges, startLine + 1, endLine);

  // Mark lines after deletion as dirty
  const newDirtyRange = createDirtyRange(
    startLine + 1,
    END_OF_DOCUMENT,
    -deleteLength
  );

  const mergedRanges = mergeDirtyRanges([...remappedRanges, newDirtyRange]);

  return withLineIndexState(state, {
    root: newState.root,
    lineCount: newState.lineCount,
    dirtyRanges: Object.freeze(mergedRanges),
    rebuildPending: true,
  });
}

/**
 * Remove lines to end with lazy tracking.
 */
function removeLinesToEndLazy(
  state: LineIndexState,
  startLine: number,
  startOffset: number,
  currentVersion: number,
  deletedCharLength?: number
): LineIndexState {
  const newState = removeLinesToEnd(state, startLine, startOffset, deletedCharLength);
  return withLineIndexState(state, {
    root: newState.root,
    lineCount: newState.lineCount,
    dirtyRanges: Object.freeze([]),
    lastReconciledVersion: currentVersion,
    rebuildPending: false,
  });
}

// =============================================================================
// Reconciliation Functions
// =============================================================================

/**
 * Get a line's content range with on-demand precision.
 * If the line is dirty, computes correct offset before returning.
 */
export function getLineRangePrecise(
  state: LineIndexState<'eager'>,
  lineNumber: number
): LogCost<{ start: ByteOffset; length: ByteLength }> | null;
export function getLineRangePrecise<M extends EvaluationMode>(
  state: LineIndexState<M>,
  lineNumber: number
): LogCost<{ start: ByteOffset; length: ByteLength }> | null;
export function getLineRangePrecise(
  state: LineIndexState,
  lineNumber: number
): LogCost<{ start: ByteOffset; length: ByteLength }> | null {
  const node = findLineByNumber(state.root, lineNumber);
  if (node === null) return null;

  // getLineStartOffset uses subtreeByteLength aggregates, which withLineIndexNode
  // keeps current on every tree mutation. The offset it returns is correct in both
  // clean (eager) and dirty (lazy) states — no dirty-range delta adjustment needed.
  return $prove('O(log n)', $checked(() => $pipe(
    $from(node),
    $andThen((resolvedNode) => $pipe(
      $from(getLineStartOffset(state.root, lineNumber)),
      $map((start) => ({ start: byteOffset(start), length: toByteLengthBrand(resolvedNode.lineLength) })),
    )),
  )));
}

/**
 * Reconcile a specific range of lines.
 * Updates offsets for lines in [startLine, endLine].
 *
 * @internal Low-level operation — callers must understand dirty-range semantics:
 * `version` must match the state version, and line bounds must be within
 * `[0, state.lineCount - 1]`. Misuse can leave the line index in a partially
 * reconciled state. Prefer the higher-level entry points:
 * - `reconcileNow()` — immediate full reconciliation (store method)
 * - `setViewport(startLine, endLine)` — priority reconciliation for visible lines
 */
export function reconcileRange(
  state: LineIndexState,
  startLine: number,
  endLine: number,
  version: number
): NLogNCost<LineIndexState> {
  if (state.root === null || state.dirtyRanges.length === 0) return $proveCtx('O(n log n)', $lift('O(n log n)', state));
  const clampedStart = Math.max(0, startLine);
  const clampedEnd = Math.min(endLine, state.lineCount - 1);
  if (clampedStart > clampedEnd) return $proveCtx('O(n log n)', $lift('O(n log n)', state));

  // Build sweep events from sorted, non-overlapping dirty ranges — O(K)
  // Each range contributes a +delta event at its effective start and
  // a -delta event at its effective end+1 within [clampedStart, clampedEnd].
  const events: Array<{ line: number; delta: number }> = [];
  for (const range of state.dirtyRanges) {
    if (range.kind === 'sentinel') continue; // Sentinel triggers slow path in reconcileFull; skip here
    const effectiveStart = Math.max(range.startLine, clampedStart);
    const effectiveEnd = Math.min(range.endLine, clampedEnd);
    if (effectiveStart > effectiveEnd) continue;
    events.push({ line: effectiveStart, delta: range.offsetDelta });
    if (effectiveEnd < clampedEnd) {
      events.push({ line: effectiveEnd + 1, delta: -range.offsetDelta });
    }
  }

  // Sweep [clampedStart, clampedEnd] with a running cumulative delta — O(K + V)
  let newRoot = state.root!;
  let cumDelta = 0;
  let evtIdx = 0;
  for (let line = clampedStart; line <= clampedEnd; line++) {
    while (evtIdx < events.length && events[evtIdx].line === line) {
      cumDelta += events[evtIdx].delta;
      evtIdx++;
    }
    if (cumDelta !== 0) {
      newRoot = updateLineOffsetByNumber(newRoot, line, cumDelta);
    }
  }

  // Keep only the parts of dirty ranges that are outside [clampedStart, clampedEnd].
  const remaining: DirtyLineRange[] = [];
  for (const range of state.dirtyRanges) {
    // Sentinels survive: they signal a full rebuild is needed for the whole document.
    if (range.kind === 'sentinel') { remaining.push(range); continue; }

    const rangeEnd = Math.min(range.endLine, state.lineCount - 1);
    if (range.startLine > rangeEnd) continue;

    // No overlap with reconciled window.
    if (rangeEnd < clampedStart || range.startLine > clampedEnd) {
      remaining.push(range);
      continue;
    }

    // Left-side remainder.
    if (range.startLine < clampedStart) {
      remaining.push(Object.freeze({
        ...range,
        endLine: clampedStart - 1,
      }));
    }

    // Right-side remainder.
    if (rangeEnd > clampedEnd) {
      remaining.push(Object.freeze({
        ...range,
        startLine: clampedEnd + 1,
      }));
    }
  }
  const remainingRanges = mergeDirtyRanges(remaining);

  return $proveCtx(
    'O(n log n)',
    $lift(
      'O(n log n)',
      withLineIndexState(state, {
        root: newRoot,
        dirtyRanges: Object.freeze(remainingRanges),
        lastReconciledVersion: version,
        rebuildPending: remainingRanges.length > 0,
      })
    )
  );
}

/**
 * Update offset for a specific line in the tree.
 */
function updateLineOffsetByNumber(
  node: LineIndexNode,
  lineNumber: number,
  offsetDelta: number
): LineIndexNode {
  const leftLineCount = node.left?.subtreeLineCount ?? 0;

  if (lineNumber < leftLineCount && node.left !== null) {
    return withLineIndexNode(node, {
      left: updateLineOffsetByNumber(node.left, lineNumber, offsetDelta),
    });
  } else if (lineNumber > leftLineCount && node.right !== null) {
    return withLineIndexNode(node, {
      right: updateLineOffsetByNumber(node.right, lineNumber - leftLineCount - 1, offsetDelta),
    });
  } else {
    return withLineIndexNode(node, {
      documentOffset: node.documentOffset === null ? offsetDelta : node.documentOffset + offsetDelta,
    });
  }
}

/**
 * Compute total number of dirty lines across all ranges, clamped to lineCount.
 */
function computeTotalDirtyLines(
  dirtyRanges: readonly DirtyLineRange[],
  lineCount: number
): number {
  let total = 0;
  for (const range of dirtyRanges) {
    if (range.kind === 'sentinel') continue; // Sentinel triggers the slow path via hasCollapsedCapSentinel
    const end = Math.min(range.endLine, lineCount - 1);
    total += Math.max(0, end - range.startLine + 1);
  }
  return total;
}

/**
 * Walk the tree in-order and update offsets by accumulating line lengths.
 * Uses structural sharing — only nodes with incorrect offsets get new allocations.
 */
function reconcileInPlace(
  node: LineIndexNode | null,
  acc: { offset: number }
): LineIndexNode | null {
  if (node === null) return null;

  const newLeft = reconcileInPlace(node.left, acc);
  const correctOffset = acc.offset;
  acc.offset += node.lineLength;
  const newRight = reconcileInPlace(node.right, acc);

  if (newLeft !== node.left || newRight !== node.right || node.documentOffset !== correctOffset) {
    return withLineIndexNode(node, {
      left: newLeft,
      right: newRight,
      documentOffset: correctOffset,
    });
  }
  return node;
}

/**
 * Perform full reconciliation of all dirty ranges.
 * Uses incremental updates for small dirty ranges (O(k * log n)),
 * and an in-place tree walk for large ranges (O(n) with structural sharing).
 * Intended to be called from idle callback.
 */
/**
 * Configuration for reconciliation behavior.
 */
export interface ReconciliationConfig {
  /** Compute the threshold below which incremental reconciliation is used.
   *  Receives lineCount, returns max dirty lines for incremental path.
   *  Default: Math.max(64, Math.floor(lineCount / Math.log2(lineCount + 1)))
   */
  thresholdFn?: (lineCount: number) => number;
}

// Incremental reconciliation total cost: O(K² + totalDirty) where K ≤ 32 (sentinel cap).
// Full-walk cost: O(n). Incremental is cheaper when totalDirty + 1024 ≤ n, i.e. when
// totalDirty ≤ n − 1024 ≈ 0.75n for typical documents. The old formula (n / log₂n) was
// calibrated for the former O(V×K) reconcileRange; the sweep-line O(K+V) implementation
// makes incremental viable up to ~75% dirty lines.
const defaultThresholdFn = (lineCount: number): number =>
  Math.max(256, Math.floor(lineCount * 0.75));

function toEagerLineIndexState(
  state: LineIndexState,
  version: number,
  changes: Partial<LineIndexState> = {}
): LineIndexState<'eager'> {
  const reconciled = withLineIndexState(state, {
    dirtyRanges: Object.freeze([]),
    lastReconciledVersion: version,
    rebuildPending: false,
    ...changes,
  });
  return asEagerLineIndex(reconciled);
}

export function reconcileFull(
  state: LineIndexState,
  version: number,
  config?: ReconciliationConfig
): NLogNCost<LineIndexState<'eager'>> {
  if (state.dirtyRanges.length === 0) {
    return $proveCtx('O(n log n)', $lift('O(n log n)', toEagerLineIndexState(state, version)));
  }

  if (state.root === null) {
    return $proveCtx('O(n log n)', $lift('O(n log n)', toEagerLineIndexState(state, version, {
      lineCount: 1,
    })));
  }

  // Fast path: incremental reconciliation — O(K² + totalDirty) via sweep-line reconcileRange
  const totalDirty = computeTotalDirtyLines(state.dirtyRanges, state.lineCount);
  const thresholdFn = config?.thresholdFn ?? defaultThresholdFn;
  const threshold = thresholdFn(state.lineCount);
  const hasCollapsedCapSentinel = state.dirtyRanges.some(range => range.kind === 'sentinel');

  // mergeDirtyRanges may collapse many heterogeneous ranges into a single
  // full-document sentinel with offsetDelta=0. Delta detail is lost there,
  // so incremental reconciliation cannot repair offsets correctly.
  if (!hasCollapsedCapSentinel && totalDirty <= threshold) {
    let current: LineIndexState = state;
    for (const range of state.dirtyRanges) {
      if (range.kind === 'sentinel') continue; // Guarded by hasCollapsedCapSentinel above; defensive
      const endLine = Math.min(range.endLine, current.lineCount - 1);
      current = reconcileRange(current, range.startLine, endLine, version);
    }
    return $proveCtx(
      'O(n log n)',
      $lift('O(n log n)', toEagerLineIndexState(current, version))
    );
  }

  // Slow path: triggered either by a sentinel (delta information lost) or when
  // totalDirty > threshold (non-sentinel ranges covering most of the document).
  // Both cases are intentional — the O(n) in-place tree walk is cheaper than the
  // O(K²+totalDirty) incremental path when the dirty region is large.
  //
  // IMPORTANT: this path uses reconcileInPlace, which recomputes documentOffset
  // values from each node's stored lineLength via an in-order traversal. It does
  // NOT call getText or rebuildLineIndex — no full document decode occurs here.
  const newRoot = reconcileInPlace(state.root, { offset: 0 });

  return $proveCtx(
    'O(n log n)',
    $lift(
      'O(n log n)',
      toEagerLineIndexState(state, version, {
        root: newRoot,
      })
    )
  );
}

/**
 * Ensure viewport lines are fully reconciled.
 * Called before rendering to guarantee visible content accuracy.
 */
export function reconcileViewport(
  state: LineIndexState,
  startLine: number,
  endLine: number,
  version: number
): NLogNCost<LineIndexState> {
  if (state.dirtyRanges.length === 0) return $proveCtx('O(n log n)', $lift('O(n log n)', state));
  const normalizedStart = Math.min(startLine, endLine);
  const normalizedEnd = Math.max(startLine, endLine);
  const clampedStart = Math.max(0, normalizedStart);
  const clampedEnd = Math.min(normalizedEnd, state.lineCount - 1);
  if (clampedStart > clampedEnd) return $proveCtx('O(n log n)', $lift('O(n log n)', state));

  // Check if any viewport lines are dirty.
  // A sentinel means the entire document is dirty — viewport is always dirty.
  const viewportDirty = state.dirtyRanges.some(range => {
    if (range.kind === 'sentinel') return true;
    return range.startLine <= clampedEnd && range.endLine >= clampedStart;
  });

  if (!viewportDirty) return $proveCtx('O(n log n)', $lift('O(n log n)', state));

  // Reconcile only the viewport range
  return reconcileRange(state, clampedStart, clampedEnd, version);
}

// =============================================================================
// Debug Utilities
// =============================================================================

/**
 * Spot-check that every sampled line in an eager state has a correct documentOffset.
 *
 * Compares each sampled node's `documentOffset` against the value computed by
 * `getLineStartOffset` (an independent O(log n) tree walk that accumulates byte
 * lengths). Throws an `Error` describing the first mismatch found.
 *
 * This does NOT guarantee correctness for un-sampled lines — it is a probabilistic
 * sanity check for use in tests and debug/dev builds. It is never called by
 * production code paths.
 *
 * @param state  Eager line index state to verify.
 * @param sampleSize  Number of evenly-distributed lines to check. Defaults to 10.
 */
export function assertEagerOffsets(
  state: LineIndexState<'eager'>,
  sampleSize = 10
): void {
  if (state.root === null || state.lineCount <= 0) return;

  const step = Math.max(1, Math.floor(state.lineCount / sampleSize));
  for (let i = 0; i < state.lineCount; i += step) {
    const node = findLineByNumber(state.root, i);
    if (node === null) continue;

    const expectedOffset = getLineStartOffset(state.root, i);
    if (node.documentOffset !== expectedOffset) {
      throw new Error(
        `assertEagerOffsets: line ${i} has documentOffset=${node.documentOffset} ` +
        `but expected ${expectedOffset}`
      );
    }
  }
}
