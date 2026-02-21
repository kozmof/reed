/**
 * Line Index operations with immutable Red-Black tree.
 * Maintains line positions for O(log n) line lookups.
 * All operations return new tree structures with structural sharing.
 *
 * Cost typing policy: use `$` boundaries with `$cost/$checked` for explicit
 * compute regions (see `src/types/cost.ts`).
 */

import type {
  LineIndexNode,
  LineIndexState,
  DirtyLineRange,
  EvaluationMode,
} from '../../types/state.ts';
import type { ByteOffset, ByteLength } from '../../types/branded.ts';
import type { ReadTextFn } from '../../types/store.ts';
import {
  $,
  $checked,
  $cost,
  $fromCosted,
  $pipe,
  $andThen,
  $map,
  byteOffset,
  byteLength as toByteLengthBrand,
  type ConstCost,
  type LinearCost,
  type LogCost,
  type NLogNCost,
} from '../../types/branded.ts';
import { createLineIndexNode, withLineIndexNode, withLineIndexState } from './state.ts';
import { fixInsertWithPath, fixRedViolations, isRed, type WithNodeFn, type InsertionPathEntry } from './rb-tree.ts';

// Type-safe wrapper for withLineIndexNode to use with generic R-B tree functions
import { textEncoder } from './encoding.ts';

const withLine: WithNodeFn<LineIndexNode> = withLineIndexNode;

// =============================================================================
// Shared Helpers
// =============================================================================

/**
 * Find byte-offset positions of all newline characters in text,
 * and compute the total UTF-8 byte length.
 *
 * Encodes text to UTF-8 bytes once, then scans for 0x0A.
 * This is correct because '\n' is always a single byte (0x0A) in UTF-8
 * and never appears as part of a multi-byte sequence.
 */
function findNewlineBytePositions(text: string): { positions: number[]; byteLength: number } {
  const bytes = textEncoder.encode(text);
  const positions: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0A) positions.push(i);
  }
  return { positions, byteLength: bytes.length };
}

/**
 * Count newline characters in text.
 * Shared between eager and lazy delete operations.
 */
function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}

/**
 * Find char (UTF-16) positions of newlines in a string.
 */
function findNewlineCharPositions(text: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') positions.push(i);
  }
  return positions;
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
      const location = $('O(log n)', $cost({
        node,
        lineNumber: lineNumber + leftLineCount,
        offsetInLine: pos - lineStart,
      }));
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
      const line = $('O(log n)', $cost(current));
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
    const emptyOffset = $('O(log n)', $cost(0));
    return emptyOffset;
  }
  if (lineNumber < 0) {
    const invalidOffset = $('O(log n)', $cost(0));
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

  const startOffset = $('O(log n)', $cost(foundOffset ?? offset));
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
    const emptyOffset = $('O(log n)', $cost(0));
    return emptyOffset;
  }
  if (lineNumber < 0) {
    const invalidOffset = $('O(log n)', $cost(0));
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

  const startOffset = $('O(log n)', $cost(foundOffset ?? offset));
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
      const location = $('O(log n)', $cost({
        lineNumber: lineNumber + leftLineCount,
        charOffsetInLine: pos - lineStart,
      }));
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
  return $('O(n)', $cost(result as readonly LineIndexNode[]));
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
): InsertionPathEntry<LineIndexNode>[] {
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
  return insertPath;
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
  if (text.length === 0) return $('O(n)', $cost(state));

  const { positions: newlinePositions, byteLength } = findNewlineBytePositions(text);

  // If no newlines, just update the length of the affected line
  if (newlinePositions.length === 0) {
    return $('O(n)', $cost(updateLineLength(state, position, byteLength, text.length)));
  }

  const location: LogCost<LineLocation | null> =
    findLineAtPosition(state.root, position) ?? $('O(log n)', $cost<LineLocation | null>(null));

  return $('O(n)', $checked(() => $pipe(
    $fromCosted(location),
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

  const newRoot = updateLineLengthInTree(state.root, position as number, lengthDelta, charLengthDelta);
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
    return buildLineIndexFromText(text, 0);
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
    const updates: any = { lineLength: newLength };
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

  // Split by newline to compute both byte and char lengths per line
  const textLines = text.split('\n');
  let bytePos = 0;

  for (let i = 0; i < textLines.length; i++) {
    const lineText = i < textLines.length - 1 ? textLines[i] + '\n' : textLines[i];
    const lineBytes = textEncoder.encode(lineText);
    lines.push({
      offset: startOffset + bytePos,
      length: lineBytes.length,
      charLength: lineText.length,
    });
    bytePos += lineBytes.length;
  }

  if (lines.length === 0) {
    return Object.freeze({
      root: null,
      lineCount: 1,
      dirtyRanges: Object.freeze([]),
      lastReconciledVersion: 0,
      rebuildPending: false,
    });
  }

  const root = buildBalancedTreeWithChars(lines, 0, lines.length - 1);
  return Object.freeze({
    root,
    lineCount: lines.length,
    dirtyRanges: Object.freeze([]),
    lastReconciledVersion: 0,
    rebuildPending: false,
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
  deletedText: string
): NLogNCost<LineIndexState> {
  if (start >= end) return $('O(n log n)', $cost(state));
  if (state.root === null) return $('O(n log n)', $cost(state));

  const deleteLength = end - start;
  const deletedNewlines = countNewlines(deletedText);

  // If no newlines deleted, just update line length
  if (deletedNewlines === 0) {
    return $('O(n log n)', $cost(updateLineLength(state, start, -deleteLength, -deletedText.length)));
  }

  const startLocation: LogCost<LineLocation | null> =
    findLineAtPosition(state.root, start) ?? $('O(log n)', $cost<LineLocation | null>(null));

  return $('O(n log n)', $checked(() => $pipe(
    $fromCosted(startLocation),
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
  return rebuildWithDeletedRange(state.root!, startLine, endLine, mergedLength, mergedCharLength);
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
    return Object.freeze({
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
    return Object.freeze({
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

  return Object.freeze({
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
  return $('O(n)', $cost(buildLineIndexFromText(content, 0)));
}

/**
 * Get line count from the state.
 */
export function getLineCountFromIndex(state: LineIndexState): ConstCost<number> {
  const lineCount = $('O(1)', $cost(state.lineCount));
  return lineCount;
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

  return $('O(log n)', $checked(() => $pipe(
    $fromCosted(node),
    $andThen((resolvedNode) => $pipe(
      $fromCosted(getLineStartOffset(state.root, lineNumber)),
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
  if (ranges.length <= 1) return $('O(n log n)', $cost([...ranges]));

  // Sort by startLine
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
  const merged: DirtyLineRange[] = [];
  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next.startLine <= current.endLine + 1) {
      if (next.offsetDelta === current.offsetDelta) {
        // Same delta — merge as before
        current = Object.freeze({
          startLine: current.startLine,
          endLine: Math.max(current.endLine, next.endLine),
          offsetDelta: current.offsetDelta,
          createdAtVersion: Math.max(current.createdAtVersion, next.createdAtVersion),
        });
      } else if (next.startLine === current.startLine) {
        // Same start, different delta — sum deltas (equivalent to applying both)
        current = Object.freeze({
          startLine: current.startLine,
          endLine: Math.max(current.endLine, next.endLine),
          offsetDelta: current.offsetDelta + next.offsetDelta,
          createdAtVersion: Math.max(current.createdAtVersion, next.createdAtVersion),
        });
      } else {
        merged.push(current);
        current = next;
      }
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);

  // Safety cap: if too many ranges accumulated, collapse to full-document rebuild
  if (merged.length > 32) {
    const maxVersion = merged.reduce((v, r) => Math.max(v, r.createdAtVersion), 0);
    return $('O(n log n)', $cost([Object.freeze({
      startLine: 0,
      endLine: Number.MAX_SAFE_INTEGER,
      offsetDelta: 0,
      createdAtVersion: maxVersion,
    })] as readonly DirtyLineRange[]));
  }

  return $('O(n log n)', $cost(merged as readonly DirtyLineRange[]));
}

/**
 * Check if a line number falls within any dirty range.
 */
export function isLineDirty(
  dirtyRanges: readonly DirtyLineRange[],
  lineNumber: number
): LinearCost<boolean> {
  return $('O(n)', $cost(dirtyRanges.some(
    r => lineNumber >= r.startLine && lineNumber <= r.endLine
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
    if (lineNumber >= range.startLine && lineNumber <= range.endLine) {
      delta += range.offsetDelta;
    }
  }
  return $('O(n)', $cost(delta));
}

/**
 * Create a new dirty range.
 */
function createDirtyRange(
  startLine: number,
  endLine: number,
  offsetDelta: number,
  version: number
): DirtyLineRange {
  return Object.freeze({
    startLine,
    endLine,
    offsetDelta,
    createdAtVersion: version,
  });
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
  if (text.length === 0) return $('O(n)', $cost(state));

  const { positions: newlinePositions, byteLength } = findNewlineBytePositions(text);

  // No newlines: simple length update (O(log n), no lazy needed)
  if (newlinePositions.length === 0) {
    return $('O(n)', $cost(updateLineLengthLazy(state, position, byteLength, text.length)));
  }

  const location: LogCost<LineLocation | null> =
    findLineAtPosition(state.root, position) ?? $('O(log n)', $cost<LineLocation | null>(null));

  return $('O(n)', $checked(() => $pipe(
    $fromCosted(location),
    $map((resolvedLocation) => {
      if (resolvedLocation === null) {
        // Position at or past end - use eager approach for simplicity
        return appendLinesLazy(state, position as number, text, newlinePositions, byteLength, currentVersion);
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
  currentVersion: number,
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

  // Mark all lines after the insertion as dirty (they have stale offsets)
  const newDirtyRange = createDirtyRange(
    location.lineNumber + 1, // First inserted line and all after
    Number.MAX_SAFE_INTEGER, // To end of document
    byteLength, // Offset delta
    currentVersion
  );

  const mergedRanges = mergeDirtyRanges([...state.dirtyRanges, newDirtyRange]);

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
  currentVersion: number
): NLogNCost<LineIndexState> {
  if (start >= end) return $('O(n log n)', $cost(state));
  if (state.root === null) return $('O(n log n)', $cost(state));

  const deleteLength = end - start;
  const deletedNewlines = countNewlines(deletedText);

  // No newlines: just update line length
  if (deletedNewlines === 0) {
    return $('O(n log n)', $cost(updateLineLengthLazy(state, start, -deleteLength, -deletedText.length)));
  }

  const startLocation: LogCost<LineLocation | null> =
    findLineAtPosition(state.root, start) ?? $('O(log n)', $cost<LineLocation | null>(null));

  return $('O(n log n)', $checked(() => $pipe(
    $fromCosted(startLocation),
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
  const newState = rebuildWithDeletedRange(state.root!, startLine, endLine, mergedLength, mergedCharLength);

  // Mark lines after deletion as dirty
  const newDirtyRange = createDirtyRange(
    startLine + 1,
    Number.MAX_SAFE_INTEGER,
    -deleteLength,
    currentVersion
  );

  const mergedRanges = mergeDirtyRanges([...state.dirtyRanges, newDirtyRange]);

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
): LinearCost<{ start: ByteOffset; length: ByteLength }> | null;
export function getLineRangePrecise(
  state: LineIndexState,
  lineNumber: number
): LogCost<{ start: ByteOffset; length: ByteLength }> | LinearCost<{ start: ByteOffset; length: ByteLength }> | null {
  const node = findLineByNumber(state.root, lineNumber);
  if (node === null) return null;

  // Eager state guarantees clean offsets; this remains O(log n).
  if (state.dirtyRanges.length === 0) {
    return $('O(log n)', $checked(() => $pipe(
      $fromCosted(node),
      $andThen((resolvedNode) => $pipe(
        $fromCosted(getLineStartOffset(state.root, lineNumber)),
        $map((start) => ({ start: byteOffset(start), length: toByteLengthBrand(resolvedNode.lineLength) })),
      )),
    )));
  }

  // Lazy/union states may require dirty-range scanning (O(dirtyRanges)).
  return $('O(n)', $checked(() => $pipe(
    $fromCosted(node),
    $andThen((resolvedNode) => $pipe(
      $fromCosted(getLineStartOffset(state.root, lineNumber)),
      $andThen((start) => $pipe(
        $fromCosted(getOffsetDeltaForLine(state.dirtyRanges, lineNumber)),
        $map((delta) => ({ start: byteOffset(start + delta), length: toByteLengthBrand(resolvedNode.lineLength) })),
      )),
    )),
  )));
}

/**
 * Reconcile a specific range of lines.
 * Updates offsets for lines in [startLine, endLine].
 */
export function reconcileRange(
  state: LineIndexState,
  startLine: number,
  endLine: number,
  version: number
): NLogNCost<LineIndexState> {
  if (state.root === null || state.dirtyRanges.length === 0) return $('O(n log n)', $cost(state));

  // For each line in range, compute correct offset and update
  let newRoot = state.root!;
  for (let line = startLine; line <= endLine && line < state.lineCount; line++) {
    const delta = getOffsetDeltaForLine(state.dirtyRanges, line);
    if (delta !== 0) {
      newRoot = updateLineOffsetByNumber(newRoot, line, delta);
    }
  }

  // Filter out ranges that are now reconciled
  const remainingRanges = state.dirtyRanges.filter(range => {
    const rangeEnd = Math.min(range.endLine, state.lineCount - 1);
    // Keep if range extends beyond reconciled area
    return rangeEnd > endLine || range.startLine < startLine;
  }).map(range => {
    // Adjust ranges that partially overlap
    if (range.startLine <= endLine &&
        range.endLine > endLine) {
      return Object.freeze({
        ...range,
        startLine: endLine + 1,
      });
    }
    return range;
  });

  return $('O(n log n)', $cost(withLineIndexState(state, {
    root: newRoot,
    dirtyRanges: Object.freeze(remainingRanges),
    lastReconciledVersion: version,
    rebuildPending: remainingRanges.length > 0,
  })));
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

const defaultThresholdFn = (lineCount: number): number =>
  Math.max(64, Math.floor(lineCount / Math.log2(lineCount + 1)));

export function reconcileFull(
  state: LineIndexState,
  version: number,
  config?: ReconciliationConfig
): NLogNCost<LineIndexState<'eager'>> {
  if (state.dirtyRanges.length === 0) return $('O(n log n)', $cost(state as LineIndexState<'eager'>));

  if (state.root === null) {
    return $('O(n log n)', $cost(withLineIndexState(state, {
      lineCount: 1,
      dirtyRanges: Object.freeze([]) as readonly [],
      lastReconciledVersion: version,
      rebuildPending: false as const,
    }) as LineIndexState<'eager'>));
  }

  // Fast path: incremental for small dirty ranges — O(k * log n)
  const totalDirty = computeTotalDirtyLines(state.dirtyRanges, state.lineCount);
  const thresholdFn = config?.thresholdFn ?? defaultThresholdFn;
  const threshold = thresholdFn(state.lineCount);

  if (totalDirty <= threshold) {
    let current: LineIndexState = state;
    for (const range of state.dirtyRanges) {
      const endLine = Math.min(range.endLine, current.lineCount - 1);
      current = reconcileRange(current, range.startLine, endLine, version);
    }
    return $('O(n log n)', $cost(current as LineIndexState<'eager'>));
  }

  // Slow path: in-place O(n) walk with structural sharing (no collect-rebuild)
  const newRoot = reconcileInPlace(state.root, { offset: 0 });

  return $('O(n log n)', $cost(withLineIndexState(state, {
    root: newRoot,
    dirtyRanges: Object.freeze([]) as readonly [],
    lastReconciledVersion: version,
    rebuildPending: false as const,
  }) as LineIndexState<'eager'>));
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
  if (state.dirtyRanges.length === 0) return $('O(n log n)', $cost(state));

  // Check if any viewport lines are dirty
  const viewportDirty = state.dirtyRanges.some(range => {
    const rangeEnd = range.endLine;
    return range.startLine <= endLine && rangeEnd >= startLine;
  });

  if (!viewportDirty) return $('O(n log n)', $cost(state));

  // Reconcile only the viewport range
  return reconcileRange(state, startLine, endLine, version);
}
