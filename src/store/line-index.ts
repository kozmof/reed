/**
 * Line Index operations with immutable Red-Black tree.
 * Maintains line positions for O(log n) line lookups.
 * All operations return new tree structures with structural sharing.
 */

import type {
  LineIndexNode,
  LineIndexState,
} from '../types/state.ts';
import { createLineIndexNode, withLineIndexNode } from './state.ts';

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

/**
 * Information about lines affected by a text change.
 */
interface AffectedLines {
  /** First affected line number */
  startLine: number;
  /** Offset within first line where change starts */
  startOffset: number;
  /** Last affected line number (for deletions spanning multiple lines) */
  endLine: number;
  /** Offset within last line where change ends */
  endOffset: number;
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
  position: number
): LineLocation | null {
  if (root === null) return null;
  if (position < 0) return null;

  let lineNumber = 0;
  let current: LineIndexNode | null = root;

  while (current !== null) {
    const leftLineCount = current.left?.subtreeLineCount ?? 0;
    const leftByteLength = current.left?.subtreeByteLength ?? 0;

    // Calculate the byte range of this line
    const lineStart = leftByteLength;
    const lineEnd = lineStart + current.lineLength;

    if (position < lineStart) {
      // Position is in left subtree
      current = current.left;
    } else if (position >= lineEnd && current.right !== null) {
      // Position is in right subtree
      lineNumber += leftLineCount + 1;
      position -= lineEnd;
      current = current.right;
    } else {
      // Position is in this line (or at end and no right subtree)
      return {
        node: current,
        lineNumber: lineNumber + leftLineCount,
        offsetInLine: position - lineStart,
      };
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
): LineIndexNode | null {
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
      return current;
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
): number {
  if (root === null) return 0;
  if (lineNumber < 0) return 0;

  let offset = 0;
  let current: LineIndexNode | null = root;
  let targetLine = lineNumber;

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
      return offset + leftByteLength;
    }
  }

  return offset;
}

/**
 * Collect all lines in order (in-order traversal).
 */
export function collectLines(root: LineIndexNode | null): LineIndexNode[] {
  const result: LineIndexNode[] = [];

  function inOrder(node: LineIndexNode | null) {
    if (node === null) return;
    inOrder(node.left);
    result.push(node);
    inOrder(node.right);
  }

  inOrder(root);
  return result;
}

// =============================================================================
// Red-Black Tree Rotations (Immutable)
// =============================================================================

/**
 * Rotate left at the given node. Returns the new subtree root.
 */
function rotateLeft(node: LineIndexNode): LineIndexNode {
  const right = node.right;
  if (right === null) return node;

  const newNode = withLineIndexNode(node, {
    right: right.left,
  });

  return withLineIndexNode(right, {
    left: newNode,
  });
}

/**
 * Rotate right at the given node. Returns the new subtree root.
 */
function rotateRight(node: LineIndexNode): LineIndexNode {
  const left = node.left;
  if (left === null) return node;

  const newNode = withLineIndexNode(node, {
    left: left.right,
  });

  return withLineIndexNode(left, {
    right: newNode,
  });
}

/**
 * Check if a node is red.
 */
function isRed(node: LineIndexNode | null | undefined): boolean {
  return node != null && node.color === 'red';
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
  documentOffset: number,
  lineLength: number
): LineIndexNode {
  const newNode = createLineIndexNode(documentOffset, lineLength, 'red');

  if (root === null) {
    return withLineIndexNode(newNode, { color: 'black' });
  }

  const newRoot = bstInsertLine(root, lineNumber, newNode);
  return ensureBlackRoot(rebalanceAfterInsert(newRoot));
}

/**
 * BST insertion for line index.
 */
function bstInsertLine(
  node: LineIndexNode,
  lineNumber: number,
  newNode: LineIndexNode
): LineIndexNode {
  const leftLineCount = node.left?.subtreeLineCount ?? 0;

  if (lineNumber <= leftLineCount) {
    // Insert in left subtree
    if (node.left === null) {
      return withLineIndexNode(node, { left: newNode });
    }
    return withLineIndexNode(node, {
      left: bstInsertLine(node.left, lineNumber, newNode),
    });
  } else {
    // Insert in right subtree
    const rightLineNumber = lineNumber - leftLineCount - 1;
    if (node.right === null) {
      return withLineIndexNode(node, { right: newNode });
    }
    return withLineIndexNode(node, {
      right: bstInsertLine(node.right, rightLineNumber, newNode),
    });
  }
}

/**
 * Ensure the root is black.
 */
function ensureBlackRoot(node: LineIndexNode): LineIndexNode {
  if (node.color === 'red') {
    return withLineIndexNode(node, { color: 'black' });
  }
  return node;
}

/**
 * Rebalance tree after insert to fix red-red violations.
 */
function rebalanceAfterInsert(node: LineIndexNode): LineIndexNode {
  let newLeft = node.left;
  if (newLeft !== null) {
    newLeft = rebalanceAfterInsert(newLeft);
  }

  let newRight = node.right;
  if (newRight !== null) {
    newRight = rebalanceAfterInsert(newRight);
  }

  let result = node;
  if (newLeft !== node.left || newRight !== node.right) {
    result = withLineIndexNode(node, { left: newLeft, right: newRight });
  }

  return fixRedViolations(result);
}

/**
 * Fix red-red violations at a node.
 */
function fixRedViolations(node: LineIndexNode): LineIndexNode {
  let result = node;

  // Case 1: Left-Left (right rotation)
  if (isRed(result.left) && isRed(result.left?.left)) {
    result = rotateRight(result);
    result = withLineIndexNode(result, {
      color: 'black',
      right: result.right ? withLineIndexNode(result.right, { color: 'red' }) : null,
    });
  }
  // Case 2: Left-Right (left-right rotation)
  else if (isRed(result.left) && isRed(result.left?.right)) {
    const newLeft = rotateLeft(result.left!);
    result = withLineIndexNode(result, { left: newLeft });
    result = rotateRight(result);
    result = withLineIndexNode(result, {
      color: 'black',
      right: result.right ? withLineIndexNode(result.right, { color: 'red' }) : null,
    });
  }
  // Case 3: Right-Right (left rotation)
  else if (isRed(result.right) && isRed(result.right?.right)) {
    result = rotateLeft(result);
    result = withLineIndexNode(result, {
      color: 'black',
      left: result.left ? withLineIndexNode(result.left, { color: 'red' }) : null,
    });
  }
  // Case 4: Right-Left (right-left rotation)
  else if (isRed(result.right) && isRed(result.right?.left)) {
    const newRight = rotateRight(result.right!);
    result = withLineIndexNode(result, { right: newRight });
    result = rotateLeft(result);
    result = withLineIndexNode(result, {
      color: 'black',
      left: result.left ? withLineIndexNode(result.left, { color: 'red' }) : null,
    });
  }

  return result;
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
  position: number,
  text: string
): LineIndexState {
  if (text.length === 0) return state;

  // Count newlines and find their positions
  const newlinePositions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      newlinePositions.push(i);
    }
  }

  // If no newlines, just update the length of the affected line
  if (newlinePositions.length === 0) {
    return updateLineLength(state, position, text.length);
  }

  // Find the line where insertion happens
  const location = findLineAtPosition(state.root, position);
  if (location === null) {
    // Position is at or past end - append to last line or create new
    return appendLines(state, position, text, newlinePositions);
  }

  // Split the current line and insert new lines
  return insertLinesAtPosition(state, location, text, newlinePositions);
}

/**
 * Update line length when inserting text without newlines.
 */
function updateLineLength(
  state: LineIndexState,
  position: number,
  lengthDelta: number
): LineIndexState {
  if (state.root === null) {
    // Create first line
    const root = createLineIndexNode(0, lengthDelta, 'black');
    return Object.freeze({ root, lineCount: 1 });
  }

  const newRoot = updateLineLengthInTree(state.root, position, lengthDelta);
  return Object.freeze({ root: newRoot, lineCount: state.lineCount });
}

/**
 * Update line length in the tree at the given position.
 */
function updateLineLengthInTree(
  node: LineIndexNode,
  position: number,
  lengthDelta: number
): LineIndexNode {
  const leftByteLength = node.left?.subtreeByteLength ?? 0;
  const lineStart = leftByteLength;
  const lineEnd = lineStart + node.lineLength;

  if (position < lineStart && node.left !== null) {
    // Position is in left subtree
    return withLineIndexNode(node, {
      left: updateLineLengthInTree(node.left, position, lengthDelta),
    });
  } else if (position >= lineEnd && node.right !== null) {
    // Position is in right subtree
    return withLineIndexNode(node, {
      right: updateLineLengthInTree(node.right, position - lineEnd, lengthDelta),
    });
  } else {
    // Position is in this line - update its length
    return withLineIndexNode(node, {
      lineLength: node.lineLength + lengthDelta,
    });
  }
}

/**
 * Append lines at the end of the document.
 */
function appendLines(
  state: LineIndexState,
  position: number,
  text: string,
  newlinePositions: number[]
): LineIndexState {
  // Get total document length from root
  const totalLength = state.root?.subtreeByteLength ?? 0;

  if (state.root === null) {
    // Build tree from scratch
    return buildLineIndexFromText(text, 0);
  }

  // Update the last line's length for text before first newline
  const firstNewlinePos = newlinePositions[0];
  const textBeforeFirstNewline = firstNewlinePos + 1; // Include the newline

  let newRoot = state.root;
  let lineCount = state.lineCount;

  // If inserting at end, we need to add to the last line
  if (position >= totalLength) {
    // Find and update the last line
    newRoot = addToLastLine(newRoot, textBeforeFirstNewline);
  } else {
    // Update the line at position
    newRoot = updateLineLengthInTree(newRoot, position, textBeforeFirstNewline);
  }

  // Insert new lines for remaining newlines
  let currentOffset = position + textBeforeFirstNewline;
  for (let i = 1; i < newlinePositions.length; i++) {
    const lineLength = newlinePositions[i] - newlinePositions[i - 1];
    newRoot = rbInsertLine(newRoot, lineCount, currentOffset, lineLength);
    lineCount++;
    currentOffset += lineLength;
  }

  // Insert final line (text after last newline)
  const textAfterLastNewline = text.length - newlinePositions[newlinePositions.length - 1] - 1;
  if (textAfterLastNewline > 0 || newlinePositions.length > 0) {
    newRoot = rbInsertLine(newRoot, lineCount, currentOffset, textAfterLastNewline);
    lineCount++;
  }

  return Object.freeze({ root: newRoot, lineCount });
}

/**
 * Add length to the last line in the tree.
 */
function addToLastLine(node: LineIndexNode, lengthDelta: number): LineIndexNode {
  if (node.right !== null) {
    return withLineIndexNode(node, {
      right: addToLastLine(node.right, lengthDelta),
    });
  }
  return withLineIndexNode(node, {
    lineLength: node.lineLength + lengthDelta,
  });
}

/**
 * Insert lines at a specific position (splitting existing line).
 */
function insertLinesAtPosition(
  state: LineIndexState,
  location: LineLocation,
  text: string,
  newlinePositions: number[]
): LineIndexState {
  const { lineNumber, offsetInLine, node } = location;

  // Calculate the parts of the split line
  const originalLineLength = node.lineLength;
  const beforeInsert = offsetInLine; // Text before insertion point
  const afterInsert = originalLineLength - offsetInLine; // Text after insertion point

  // First line: original text before insert + text up to first newline (including \n)
  const firstNewlinePos = newlinePositions[0];
  const firstLineLength = beforeInsert + firstNewlinePos + 1;

  // Update the current line to be the first part
  let newRoot = updateLineAtNumber(state.root!, lineNumber, firstLineLength);
  let lineCount = state.lineCount;

  // Get the document offset for new lines
  const lineStartOffset = getLineStartOffset(state.root, lineNumber);
  let currentOffset = lineStartOffset + firstLineLength;

  // Insert middle lines (between first and last newline)
  for (let i = 1; i < newlinePositions.length; i++) {
    const lineLength = newlinePositions[i] - newlinePositions[i - 1];
    newRoot = rbInsertLine(newRoot, lineNumber + i, currentOffset, lineLength);
    lineCount++;
    currentOffset += lineLength;
  }

  // Last line: text after last newline + remaining original text
  const textAfterLastNewline = text.length - newlinePositions[newlinePositions.length - 1] - 1;
  const lastLineLength = textAfterLastNewline + afterInsert;

  newRoot = rbInsertLine(
    newRoot,
    lineNumber + newlinePositions.length,
    currentOffset,
    lastLineLength
  );
  lineCount++;

  // Update offsets for all lines after the inserted ones
  const insertedBytes = text.length;
  newRoot = updateOffsetsAfterLine(
    newRoot,
    lineNumber + newlinePositions.length,
    insertedBytes
  );

  return Object.freeze({ root: newRoot, lineCount });
}

/**
 * Update the line at a specific line number.
 */
function updateLineAtNumber(
  node: LineIndexNode,
  lineNumber: number,
  newLength: number
): LineIndexNode {
  const leftLineCount = node.left?.subtreeLineCount ?? 0;

  if (lineNumber < leftLineCount && node.left !== null) {
    return withLineIndexNode(node, {
      left: updateLineAtNumber(node.left, lineNumber, newLength),
    });
  } else if (lineNumber > leftLineCount && node.right !== null) {
    return withLineIndexNode(node, {
      right: updateLineAtNumber(node.right, lineNumber - leftLineCount - 1, newLength),
    });
  } else {
    return withLineIndexNode(node, { lineLength: newLength });
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

  // Update this node if it's after the threshold
  if (currentLineNumber > afterLineNumber) {
    newOffset = node.documentOffset + offsetDelta;
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
  const lines: { offset: number; length: number }[] = [];
  let lineStart = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push({
        offset: startOffset + lineStart,
        length: i - lineStart + 1,
      });
      lineStart = i + 1;
    }
  }

  // Add final line
  if (lineStart <= text.length) {
    lines.push({
      offset: startOffset + lineStart,
      length: text.length - lineStart,
    });
  }

  if (lines.length === 0) {
    return Object.freeze({ root: null, lineCount: 1 });
  }

  const root = buildBalancedTree(lines, 0, lines.length - 1);
  return Object.freeze({ root, lineCount: lines.length });
}

/**
 * Build a balanced tree from sorted line data.
 */
function buildBalancedTree(
  lines: { offset: number; length: number }[],
  start: number,
  end: number
): LineIndexNode | null {
  if (start > end) return null;

  const mid = Math.floor((start + end) / 2);
  const line = lines[mid];

  const left = buildBalancedTree(lines, start, mid - 1);
  const right = buildBalancedTree(lines, mid + 1, end);

  return createLineIndexNode(line.offset, line.length, 'black', left, right);
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
  start: number,
  end: number,
  deletedText: string
): LineIndexState {
  if (start >= end) return state;
  if (state.root === null) return state;

  const deleteLength = end - start;

  // Count newlines in deleted text
  let deletedNewlines = 0;
  for (let i = 0; i < deletedText.length; i++) {
    if (deletedText[i] === '\n') {
      deletedNewlines++;
    }
  }

  // If no newlines deleted, just update line length
  if (deletedNewlines === 0) {
    return updateLineLength(state, start, -deleteLength);
  }

  // Find the start and end lines
  const startLocation = findLineAtPosition(state.root, start);
  if (startLocation === null) return state;

  // Merge lines and remove deleted lines
  return deleteLineRange(state, startLocation, deletedNewlines, deleteLength);
}

/**
 * Delete a range of lines and merge.
 */
function deleteLineRange(
  state: LineIndexState,
  startLocation: LineLocation,
  deletedNewlines: number,
  deleteLength: number
): LineIndexState {
  const { lineNumber: startLine, offsetInLine: startOffset, node: startNode } = startLocation;
  const endLine = startLine + deletedNewlines;

  // Find the end line
  const endNode = findLineByNumber(state.root, endLine);
  if (endNode === null) {
    // End line doesn't exist - delete to end of document
    return removeLinesToEnd(state, startLine, startOffset);
  }

  // Calculate merged line length:
  // - Text before deletion on start line
  // - Text after deletion on end line
  const textBeforeDeletion = startOffset;
  const endLineStart = getLineStartOffset(state.root, endLine);
  const deletionEndInEndLine = (startLocation.node === endNode)
    ? startOffset + deleteLength
    : deleteLength - (endLineStart - (getLineStartOffset(state.root, startLine) + startOffset));

  // Calculate remaining text after deletion on end line
  const textAfterDeletion = Math.max(0, endNode.lineLength - deletionEndInEndLine + startOffset);
  const mergedLineLength = textBeforeDeletion + (endNode.lineLength - (deleteLength - textBeforeDeletion - (startNode.lineLength - startOffset)));

  // Simpler approach: rebuild the line index
  // This is O(n) but correct - can optimize later with proper tree surgery
  const lines = collectLines(state.root);
  const newLines: { offset: number; length: number }[] = [];

  let currentOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i < startLine) {
      // Lines before deletion - unchanged
      newLines.push({ offset: currentOffset, length: lines[i].lineLength });
      currentOffset += lines[i].lineLength;
    } else if (i === startLine) {
      // Merge start and end lines
      const beforeDelete = startOffset;
      const afterDeleteOnEndLine = (i + deletedNewlines < lines.length)
        ? Math.max(0, lines[i + deletedNewlines].lineLength - (deleteLength - (lines[i].lineLength - startOffset)))
        : 0;

      // Calculate the actual merged length
      let mergedLength = beforeDelete;
      if (i + deletedNewlines < lines.length) {
        const endLineLength = lines[i + deletedNewlines].lineLength;
        const deleteInEndLine = deleteLength - (lines[i].lineLength - startOffset);
        for (let j = i + 1; j < i + deletedNewlines; j++) {
          // Skip fully deleted middle lines
        }
        mergedLength += Math.max(0, endLineLength - deleteInEndLine);
      }

      newLines.push({ offset: currentOffset, length: mergedLength });
      currentOffset += mergedLength;

      // Skip deleted lines
      i += deletedNewlines;
    } else {
      // Lines after deletion - adjust offset
      newLines.push({ offset: currentOffset, length: lines[i].lineLength });
      currentOffset += lines[i].lineLength;
    }
  }

  if (newLines.length === 0) {
    return Object.freeze({ root: null, lineCount: 1 });
  }

  const root = buildBalancedTree(newLines, 0, newLines.length - 1);
  return Object.freeze({ root, lineCount: newLines.length });
}

/**
 * Remove lines from a starting point to the end.
 */
function removeLinesToEnd(
  state: LineIndexState,
  startLine: number,
  startOffset: number
): LineIndexState {
  const lines = collectLines(state.root);
  const newLines: { offset: number; length: number }[] = [];

  let currentOffset = 0;
  for (let i = 0; i < startLine && i < lines.length; i++) {
    newLines.push({ offset: currentOffset, length: lines[i].lineLength });
    currentOffset += lines[i].lineLength;
  }

  // Add partial last line if there's content before the deletion
  if (startOffset > 0 && startLine < lines.length) {
    newLines.push({ offset: currentOffset, length: startOffset });
  }

  if (newLines.length === 0) {
    return Object.freeze({ root: null, lineCount: 1 });
  }

  const root = buildBalancedTree(newLines, 0, newLines.length - 1);
  return Object.freeze({ root, lineCount: newLines.length });
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Rebuild the line index from document content.
 * Use this when the line index gets out of sync.
 */
export function rebuildLineIndex(content: string): LineIndexState {
  return buildLineIndexFromText(content, 0);
}

/**
 * Get line count from the state.
 */
export function getLineCountFromIndex(state: LineIndexState): number {
  return state.lineCount;
}

/**
 * Get a line's content range (start offset and length).
 */
export function getLineRange(
  state: LineIndexState,
  lineNumber: number
): { start: number; length: number } | null {
  const node = findLineByNumber(state.root, lineNumber);
  if (node === null) return null;

  const start = getLineStartOffset(state.root, lineNumber);
  return { start, length: node.lineLength };
}
