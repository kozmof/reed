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
  DirtyLineRangeEntry,
  DirtyLineRangeList,
  EvaluationMode,
} from "../../types/state.js";
import { END_OF_DOCUMENT } from "../../types/state.js";
import {
  byteOffset,
  byteLength as toByteLengthBrand,
  type ByteOffset,
  type ByteLength,
  type CharOffset,
} from "../../types/branded.js";
import type { ReadTextFn, DeleteBoundaryContext } from "../../types/operations.js";
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
} from "../../types/cost-doc.js";
import { createLineIndexNode, withLineIndexNode, withLineIndexState } from "./state.js";
import {
  fixInsertWithPath,
  fixRedViolations,
  isRed,
  type WithNodeFn,
  type InsertionPathEntry,
  type RootToLeafInsertPath,
} from "./rb-tree.js";
import {
  mergeDirtyRanges,
  reconcileRange,
  reconcileFull,
  reconcileViewport,
  type ReconciliationConfig,
} from "./reconcile.js";
import {
  findNewlineBytePositions,
  countDeletedLineBreaks,
  findNewlineCharPositions,
  getInsertBoundaryContext,
  hasCrossBoundaryCRLFMerge,
} from "./line-index-text-scan.js";

const withLine: WithNodeFn<LineIndexNode> = withLineIndexNode;

// =============================================================================
// Shared Helpers
// =============================================================================
//
// Pure text/boundary scanning helpers (findNewlineBytePositions, countNewlines,
// countDeletedLineBreaks, findNewlineCharPositions, getInsertBoundaryContext,
// hasCrossBoundaryCRLFMerge) live in ./line-index-text-scan.ts. They are
// imported above and used throughout this module.

function rebuildFromReadText(
  state: LineIndexState,
  readText: ReadTextFn,
  reconciledRevision: number,
): LineIndexState {
  const content = readText(byteOffset(0), byteOffset(END_OF_DOCUMENT));
  const rebuilt = buildLineIndexFromText(content, 0);
  return withLineIndexState(state, {
    root: rebuilt.root,
    lineCount: rebuilt.lineCount,
    dirtyRanges: Object.freeze([]),
    lastReconciledRevision: reconciledRevision,
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
  position: ByteOffset,
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
        "O(log n)",
        $lift("O(log n)", {
          node,
          lineNumber: lineNumber + leftLineCount,
          offsetInLine: pos - lineStart,
        }),
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
  lineNumber: number,
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
      const line = $proveCtx("O(log n)", $lift("O(log n)", current));
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
  lineNumber: number,
): LogCost<ByteOffset> {
  if (root === null) {
    return $proveCtx("O(log n)", $lift("O(1)", 0 as ByteOffset));
  }
  if (lineNumber < 0) {
    return $proveCtx("O(log n)", $lift("O(1)", 0 as ByteOffset));
  }

  let offset = 0;
  let current: LineIndexNode | null = root;
  let targetLine = lineNumber;

  while (current !== null) {
    const left: LineIndexNode | null = current.left;
    const leftLineCount = left?.subtreeLineCount ?? 0;

    if (targetLine < leftLineCount) {
      // Target is in left subtree
      current = left;
      continue;
    }

    const leftByteLength = left?.subtreeByteLength ?? 0;
    if (targetLine > leftLineCount) {
      // Target is in right subtree
      offset += leftByteLength + current.lineLength;
      targetLine -= leftLineCount + 1;
      current = current.right;
    } else {
      // This is the target line
      return $proveCtx("O(log n)", $lift("O(log n)", (offset + leftByteLength) as ByteOffset));
    }
  }

  return $proveCtx("O(log n)", $lift("O(log n)", offset as ByteOffset));
}

/**
 * Get the character offset where a line starts.
 * O(log n) using subtreeCharLength aggregates.
 */
export function getCharStartOffset(
  root: LineIndexNode | null,
  lineNumber: number,
): LogCost<CharOffset> {
  if (root === null) {
    return $proveCtx("O(log n)", $lift("O(1)", 0 as CharOffset));
  }
  if (lineNumber < 0) {
    return $proveCtx("O(log n)", $lift("O(1)", 0 as CharOffset));
  }

  let offset = 0;
  let current: LineIndexNode | null = root;
  let targetLine = lineNumber;

  while (current !== null) {
    const left: LineIndexNode | null = current.left;
    const leftLineCount = left?.subtreeLineCount ?? 0;

    if (targetLine < leftLineCount) {
      current = left;
      continue;
    }

    const leftCharLength = left?.subtreeCharLength ?? 0;
    if (targetLine > leftLineCount) {
      offset += leftCharLength + current.charLength;
      targetLine -= leftLineCount + 1;
      current = current.right;
    } else {
      return $proveCtx("O(log n)", $lift("O(log n)", (offset + leftCharLength) as CharOffset));
    }
  }

  return $proveCtx("O(log n)", $lift("O(log n)", offset as CharOffset));
}

/**
 * Find the line containing a character offset.
 * O(log n) using subtreeCharLength aggregates.
 */
export function findLineAtCharPosition(
  root: LineIndexNode | null,
  charPosition: number,
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
        "O(log n)",
        $lift("O(log n)", {
          lineNumber: lineNumber + leftLineCount,
          charOffsetInLine: pos - lineStart,
        }),
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
  const stack: LineIndexNode[] = [];
  let current: LineIndexNode | null = root;

  while (current !== null || stack.length > 0) {
    while (current !== null) {
      stack.push(current);
      current = current.left;
    }
    current = stack.pop()!;
    result.push(current);
    current = current.right;
  }

  return $proveCtx("O(n)", $lift("O(n)", result));
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
  charLength: number = 0,
): LineIndexNode {
  const newNode = createLineIndexNode(documentOffset, lineLength, "red", null, null, charLength);

  if (root === null) {
    return withLineIndexNode(newNode, { color: "black" });
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
  newNode: LineIndexNode,
): RootToLeafInsertPath<LineIndexNode> {
  // Phase 1: descend root-to-leaf, collecting (node, direction) in document order.
  const descent: InsertionPathEntry<LineIndexNode>[] = [];
  let current: LineIndexNode = root;
  let lineNum = lineNumber;

  while (true) {
    const leftLineCount = current.left?.subtreeLineCount ?? 0;
    if (lineNum <= leftLineCount) {
      descent.push({ node: current, direction: "left" });
      if (current.left === null) break;
      current = current.left;
    } else {
      lineNum = lineNum - leftLineCount - 1;
      descent.push({ node: current, direction: "right" });
      if (current.right === null) break;
      current = current.right;
    }
  }

  // Phase 2: rebuild bottom-up with path-copied nodes; result is already root-to-leaf.
  const insertPath: InsertionPathEntry<LineIndexNode>[] = Array.from({ length: descent.length });
  let child: LineIndexNode = newNode;

  for (let i = descent.length - 1; i >= 0; i--) {
    const { node, direction } = descent[i]!;
    const rebuilt =
      direction === "left"
        ? withLineIndexNode(node, { left: child })
        : withLineIndexNode(node, { right: child });
    insertPath[i] = { node: rebuilt, direction };
    child = rebuilt;
  }

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
  readText?: ReadTextFn,
): LinearCost<LineIndexState> {
  if (text.length === 0) return $proveCtx("O(n)", $lift("O(n)", state));

  const { positions: newlinePositions, byteLength } = findNewlineBytePositions(text);
  const insertContext = getInsertBoundaryContext(position, byteLength, readText);

  // Boundary merge case (e.g. inserting '\r' before existing '\n').
  // Structural incremental logic assumes inserted line breaks are self-contained;
  // cross-boundary CRLF composition violates that assumption. Rebuild for correctness.
  if (readText && hasCrossBoundaryCRLFMerge(text, insertContext)) {
    return $proveCtx(
      "O(n)",
      $lift("O(n)", rebuildFromReadText(state, readText, state.lastReconciledRevision)),
    );
  }

  // If no newlines, just update the length of the affected line
  if (newlinePositions.length === 0) {
    return $proveCtx(
      "O(n)",
      $lift("O(n)", updateLineLength(state, position, byteLength, text.length)),
    );
  }

  const location: LogCost<LineLocation | null> =
    findLineAtPosition(state.root, position) ?? $proveCtx("O(log n)", $lift("O(log n)", null));

  return $prove(
    "O(n)",
    $checked(() =>
      $pipe(
        $from(location),
        $map((resolvedLocation) => {
          if (resolvedLocation === null) {
            // Position is at or past end - append to last line or create new
            return appendLines(state, position, text, newlinePositions, byteLength);
          }

          // Split the current line and insert new lines
          return insertLinesAtPosition(
            state,
            resolvedLocation,
            text,
            newlinePositions,
            byteLength,
            readText,
          );
        }),
      ),
    ),
  );
}

/**
 * Update line length when inserting text without newlines.
 */
function updateLineLength(
  state: LineIndexState,
  position: ByteOffset,
  lengthDelta: number,
  charLengthDelta: number = 0,
): LineIndexState {
  if (state.root === null) {
    // Create first line
    const root = createLineIndexNode(0, lengthDelta, "black", null, null, charLengthDelta);
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
  charLengthDelta: number = 0,
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
  text?: string,
): { root: LineIndexNode; lineCount: number } {
  const totalLength = root.subtreeByteLength;

  // Compute char positions from text if available
  const charPositions = text ? findNewlineCharPositions(text) : [];
  const hasCharInfo = charPositions.length === newlinePositions.length;

  // Update the last line's length for text before first newline.
  // Callers only invoke this with at least one newline, so index 0 is present.
  const firstNewlinePos = newlinePositions[0]!;
  const textBeforeFirstNewline = firstNewlinePos + 1; // Include the newline
  const firstCharDelta = hasCharInfo ? charPositions[0]! + 1 : 0;

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
    const lineLength = newlinePositions[i]! - newlinePositions[i - 1]!;
    const lineCharLength = hasCharInfo ? charPositions[i]! - charPositions[i - 1]! : 0;
    newRoot = rbInsertLine(newRoot, lineCount, currentOffset, lineLength, lineCharLength);
    lineCount++;
    currentOffset += lineLength;
  }

  // Insert final line (text after last newline)
  const textAfterLastNewline = byteLength - newlinePositions[newlinePositions.length - 1]! - 1;
  const lastCharLength = hasCharInfo
    ? text!.length - charPositions[charPositions.length - 1]! - 1
    : 0;
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
  byteLength: number,
): LineIndexState {
  if (state.root === null) {
    return withLineIndexState(state, buildLineIndexFromText(text, 0));
  }

  const result = appendLinesStructural(
    state.root,
    state.lineCount,
    position,
    newlinePositions,
    byteLength,
    text,
  );

  return withLineIndexState(state, {
    root: result.root,
    lineCount: result.lineCount,
  });
}

/**
 * Add length to the last line in the tree.
 */
function addToLastLine(
  node: LineIndexNode,
  lengthDelta: number,
  charLengthDelta: number = 0,
): LineIndexNode {
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
  charsBefore?: number,
): { root: LineIndexNode; lineCount: number } {
  const { lineNumber, offsetInLine, node } = location;

  // Compute char positions from text if available
  const charPositions = text ? findNewlineCharPositions(text) : [];
  const hasCharInfo =
    text !== undefined &&
    charsBefore !== undefined &&
    charPositions.length === newlinePositions.length;

  // Calculate the parts of the split line
  const originalLineLength = node.lineLength;
  const beforeInsert = offsetInLine; // Text before insertion point
  const afterInsert = originalLineLength - offsetInLine; // Text after insertion point

  // First line: original text before insert + text up to first newline (including \n)
  const firstNewlinePos = newlinePositions[0]!;
  const firstLineLength = beforeInsert + firstNewlinePos + 1;
  const firstLineCharLength = hasCharInfo ? charsBefore! + charPositions[0]! + 1 : undefined;

  // Update the current line to be the first part
  let newRoot = updateLineAtNumber(root, lineNumber, firstLineLength, firstLineCharLength);

  // Track cumulative offset for middle/last line insertion
  let prevOffset = firstLineLength;

  // Insert middle lines (between first and last newline)
  for (let i = 1; i < newlinePositions.length; i++) {
    const lineLength = newlinePositions[i]! - newlinePositions[i - 1]!;
    const lineCharLength = hasCharInfo ? charPositions[i]! - charPositions[i - 1]! : 0;
    const offset = computeOffset(lineNumber + i, prevOffset);
    newRoot = rbInsertLine(newRoot, lineNumber + i, offset, lineLength, lineCharLength);
    lineCount++;
    prevOffset += lineLength;
  }

  // Last line: text after last newline + remaining original text
  const textAfterLastNewline = byteLength - newlinePositions[newlinePositions.length - 1]! - 1;
  const lastLineLength = textAfterLastNewline + afterInsert;
  const lastCharLength = hasCharInfo
    ? text!.length - charPositions[charPositions.length - 1]! - 1 + (node.charLength - charsBefore!)
    : 0;

  const lastOffset = computeOffset(lineNumber + newlinePositions.length, prevOffset);
  newRoot = rbInsertLine(
    newRoot,
    lineNumber + newlinePositions.length,
    lastOffset,
    lastLineLength,
    lastCharLength,
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
  readText?: ReadTextFn,
): LineIndexState {
  // Eager: compute real offsets relative to line start
  const lineStart = getLineStartOffset(state.root, location.lineNumber);

  // Compute charsBefore using readText if available
  let charsBefore: number | undefined;
  if (readText && location.offsetInLine > 0) {
    const prefixText = readText(
      byteOffset(lineStart),
      byteOffset(lineStart + location.offsetInLine),
    );
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
    charsBefore,
  );

  // Update offsets for all lines after the inserted ones
  const newRoot = updateOffsetsAfterLine(
    result.root,
    location.lineNumber + newlinePositions.length,
    byteLength,
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
  newCharLength?: number,
): LineIndexNode {
  const leftLineCount = node.left?.subtreeLineCount ?? 0;

  if (lineNumber < leftLineCount && node.left !== null) {
    return withLineIndexNode(node, {
      left: updateLineAtNumber(node.left, lineNumber, newLength, newCharLength),
    });
  } else if (lineNumber > leftLineCount && node.right !== null) {
    return withLineIndexNode(node, {
      right: updateLineAtNumber(
        node.right,
        lineNumber - leftLineCount - 1,
        newLength,
        newCharLength,
      ),
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
  offsetDelta: number,
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
  if (
    node.right !== null &&
    afterLineNumber <= currentLineNumber + (node.right.subtreeLineCount ?? 0)
  ) {
    newRight = updateOffsetsAfterLine(
      node.right,
      afterLineNumber - currentLineNumber - 1,
      offsetDelta,
    );
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
    const endByte = breakBytes[i]! + 1; // Include the line-break endpoint byte
    const endChar = breakChars[i]! + 1; // Include the line-break endpoint char
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
      lastReconciledRevision: 0,
      rebuildPending: false,
      maxDirtyRanges: 32,
      unloadedLineCountsByChunk: new Map<number, number>(),
    });
  }

  const root = buildBalancedTreeWithChars(lines, 0, lines.length - 1);
  return Object.freeze({
    root,
    lineCount: lines.length,
    dirtyRanges: Object.freeze([]),
    lastReconciledRevision: 0,
    rebuildPending: false,
    maxDirtyRanges: 32,
    unloadedLineCountsByChunk: new Map<number, number>(),
  });
}

/**
 * Build a balanced Red-Black tree from sorted line data with char lengths.
 *
 * Median-split recursion creates a near-complete tree. Coloring the deepest
 * real nodes red equalizes black-height across paths while keeping red nodes
 * childless.
 */
function buildBalancedTreeWithChars(
  lines: { offset: number; length: number; charLength: number }[],
  start: number,
  end: number,
  depth: number = 0,
  deepestDepth: number = Math.floor(Math.log2(lines.length)),
): LineIndexNode | null {
  if (start > end) return null;

  const mid = Math.floor((start + end) / 2);
  const line = lines[mid]!; // start <= mid <= end, guarded by start > end above

  const left = buildBalancedTreeWithChars(lines, start, mid - 1, depth + 1, deepestDepth);
  const right = buildBalancedTreeWithChars(lines, mid + 1, end, depth + 1, deepestDepth);

  const color = depth > 0 && depth === deepestDepth ? "red" : "black";
  return createLineIndexNode(line.offset, line.length, color, left, right, line.charLength);
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
  deleteContext?: DeleteBoundaryContext,
): NLogNCost<LineIndexState> {
  if (start >= end) return $proveCtx("O(n log n)", $lift("O(n log n)", state));
  if (state.root === null) return $proveCtx("O(n log n)", $lift("O(n log n)", state));

  const deleteLength = end - start;
  const deletedNewlines = countDeletedLineBreaks(deletedText, deleteContext);

  // If no newlines deleted, just update line length
  if (deletedNewlines === 0) {
    return $proveCtx(
      "O(n log n)",
      $lift("O(n log n)", updateLineLength(state, start, -deleteLength, -deletedText.length)),
    );
  }

  const startLocation: LogCost<LineLocation | null> =
    findLineAtPosition(state.root, start) ?? $proveCtx("O(log n)", $lift("O(log n)", null));

  return $prove(
    "O(n log n)",
    $checked(() =>
      $pipe(
        $from(startLocation),
        $map((resolvedLocation) => {
          if (resolvedLocation === null) return state;
          // Merge lines and remove deleted lines
          return deleteLineRange(
            state,
            resolvedLocation,
            deletedNewlines,
            deleteLength,
            deletedText.length,
          );
        }),
      ),
    ),
  );
}

/**
 * Compute merged line metrics for a multi-line deletion, and rebuild the tree.
 * Returns the rebuilt state, or null if the end line is out of range (caller
 * should fall back to removeLinesToEnd / removeLinesToEndLazy).
 */
function applyDeleteLineRange(
  state: LineIndexState,
  startLine: number,
  startOffset: number,
  endLine: number,
  deleteLength: number,
  deletedCharLength: number,
): LineIndexState | null {
  const endNode = findLineByNumber(state.root, endLine);
  if (endNode === null) return null;

  const startNode = findLineByNumber(state.root, startLine);
  if (startNode === null) return state;

  const startLineLength = startNode.lineLength;
  const endLineLength = endNode.lineLength;
  const deleteOnStartLine = startLineLength - startOffset;

  const startLineStart = getLineStartOffset(state.root, startLine);
  const endLineStart = getLineStartOffset(state.root, endLine);
  const middleLinesTotal = endLineStart - startLineStart - startLineLength;
  const remainingDelete = deleteLength - deleteOnStartLine - middleLinesTotal;

  const deleteOnEndLine = Math.max(0, remainingDelete);
  const keepFromEndLine = Math.max(0, endLineLength - deleteOnEndLine);
  const mergedLength = startOffset + keepFromEndLine;

  const startLineCharStart = getCharStartOffset(state.root, startLine);
  let endBound: number;
  if (endLine + 1 < state.lineCount) {
    endBound = getCharStartOffset(state.root, endLine + 1);
  } else {
    endBound = state.root!.subtreeCharLength;
  }
  const mergedCharLength = Math.max(0, endBound - startLineCharStart - deletedCharLength);

  return rebuildWithDeletedRange(
    state,
    state.root!,
    startLine,
    endLine,
    mergedLength,
    mergedCharLength,
  );
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
  deletedCharLength: number,
): LineIndexState {
  const { lineNumber: startLine, offsetInLine: startOffset } = startLocation;
  const endLine = startLine + deletedNewlines;

  const result = applyDeleteLineRange(
    state,
    startLine,
    startOffset,
    endLine,
    deleteLength,
    deletedCharLength,
  );
  if (result === null) {
    return removeLinesToEnd(state, startLine, startOffset, deletedCharLength);
  }
  return result;
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
  mergedCharLength: number = 0,
): LineIndexState {
  const totalLines = root.subtreeLineCount;
  const deletedCount = endLine - startLine; // Lines being merged/removed
  const newLineCount = totalLines - deletedCount;

  if (newLineCount <= 0) {
    return withLineIndexState(state, {
      root: null,
      lineCount: 1,
      dirtyRanges: Object.freeze([]),
      lastReconciledRevision: 0,
      rebuildPending: false,
    });
  }

  // Use incremental deletion: O(k * log n) where k = deletedCount
  // 1. Update the start line's length to the merged length
  let newRoot: LineIndexNode | null = updateLineAtNumber(
    root,
    startLine,
    mergedLength,
    mergedCharLength,
  );

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
      lastReconciledRevision: 0,
      rebuildPending: false,
    });
  }

  // Ensure root is black
  if (newRoot.color !== "black") {
    newRoot = withLineIndexNode(newRoot, { color: "black" });
  }

  return withLineIndexState(state, {
    root: newRoot,
    lineCount: newLineCount,
    dirtyRanges: Object.freeze([]),
    lastReconciledRevision: 0,
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
function rbDeleteLineByNumber(root: LineIndexNode, lineNumber: number): LineIndexNode | null {
  const result = deleteNode(root, lineNumber);
  if (result === null) return null;
  // Ensure root is black
  if (result.color === "red") {
    return withLineIndexNode(result, { color: "black" });
  }
  return result;
}

/**
 * Recursively delete a node by line number.
 * Returns { node, needsFixup } where needsFixup indicates a double-black case.
 */
function deleteNode(node: LineIndexNode | null, lineNumber: number): LineIndexNode | null {
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
    return withLineIndexNode(node.right!, { color: "black" });
  }
  if (node.right === null) {
    // Replace with left child, make it black
    return withLineIndexNode(node.left!, { color: "black" });
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
    successor.charLength,
  );

  return fixDeleteViolations(replacement);
}

/**
 * Extract the minimum (leftmost) node from a subtree.
 * Returns the extracted node and the remaining tree.
 */
function extractMin(node: LineIndexNode): {
  successor: LineIndexNode;
  newRight: LineIndexNode | null;
} {
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
  deletedCharLength?: number,
): LineIndexState {
  // Collect only the kept prefix [0, startLine) using an early-stopping traversal.
  // O(startLine) allocation instead of O(n) from collectLines.
  const newLines: { offset: number; length: number; charLength: number }[] = [];
  const stack: LineIndexNode[] = [];
  let cur: LineIndexNode | null = state.root;
  let currentOffset = 0;
  let prefixCharLength = 0;

  outer: while (cur !== null || stack.length > 0) {
    while (cur !== null) {
      stack.push(cur);
      cur = cur.left;
    }
    cur = stack.pop()!;
    if (newLines.length >= startLine) break outer;
    newLines.push({ offset: currentOffset, length: cur.lineLength, charLength: cur.charLength });
    currentOffset += cur.lineLength;
    prefixCharLength += cur.charLength;
    cur = cur.right;
  }

  // Add partial last line if there's content before the deletion point.
  if (startOffset > 0 && startLine < state.lineCount) {
    // Suffix char length = total - already-counted prefix chars.
    const totalCharLength = state.root?.subtreeCharLength ?? 0;
    const totalCharsFromStartToEnd = totalCharLength - prefixCharLength;
    const truncatedCharLength =
      deletedCharLength !== undefined ? totalCharsFromStartToEnd - deletedCharLength : 0;
    newLines.push({
      offset: currentOffset,
      length: startOffset,
      charLength: Math.max(0, truncatedCharLength),
    });
  }

  if (newLines.length === 0) {
    return withLineIndexState(state, {
      root: null,
      lineCount: 1,
      dirtyRanges: Object.freeze([]),
      lastReconciledRevision: 0,
      rebuildPending: false,
    });
  }

  const root = buildBalancedTreeWithChars(newLines, 0, newLines.length - 1);
  return withLineIndexState(state, {
    root,
    lineCount: newLines.length,
    dirtyRanges: Object.freeze([]),
    lastReconciledRevision: 0,
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
  return $proveCtx("O(n)", $lift("O(n)", buildLineIndexFromText(content, 0)));
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
  return $declare("O(1)", total);
}

/**
 * Get a line's content range (start offset and length).
 * Requires eager state — calling on lazy state with dirty ranges is a compile error.
 * Use `getLineRangePrecise` for state that may have dirty ranges.
 */
export function getLineRange(
  state: LineIndexState<"eager">,
  lineNumber: number,
): LogCost<{ start: ByteOffset; length: ByteLength }> | null {
  const node = findLineByNumber(state.root, lineNumber);
  if (node === null) return null;

  return $prove(
    "O(log n)",
    $checked(() =>
      $pipe(
        $from(node),
        $andThen((resolvedNode) =>
          $pipe(
            $from(getLineStartOffset(state.root, lineNumber)),
            $map((start) => ({
              start: byteOffset(start),
              length: toByteLengthBrand(resolvedNode.lineLength),
            })),
          ),
        ),
      ),
    ),
  );
}

// =============================================================================
// Dirty Range Utilities (isLineDirty, getOffsetDeltaForLine)
// Dirty range management (mergeDirtyRanges) and reconciliation functions
// (reconcileRange, reconcileFull, reconcileViewport) live in ./reconcile.ts.
// They are imported above and re-exported below to preserve the public API.
// =============================================================================

/**
 * Check if a line number falls within any dirty range.
 */
export function isLineDirty(
  dirtyRanges: DirtyLineRangeList,
  lineNumber: number,
): LinearCost<boolean> {
  if (dirtyRanges === "full-rebuild-needed") {
    return $proveCtx("O(n)", $lift("O(n)", true));
  }
  return $proveCtx(
    "O(n)",
    $lift(
      "O(n)",
      dirtyRanges.some((r) => lineNumber >= r.startLine && lineNumber <= r.endLine),
    ),
  );
}

/**
 * Get the cumulative offset delta for a line number.
 */
export function getOffsetDeltaForLine(
  dirtyRanges: DirtyLineRangeList,
  lineNumber: number,
): LinearCost<number> {
  if (dirtyRanges === "full-rebuild-needed") {
    // Delta information is lost; caller must reconcile before relying on offsets.
    return $proveCtx("O(n)", $lift("O(n)", 0));
  }
  let delta = 0;
  for (const range of dirtyRanges) {
    if (lineNumber >= range.startLine && lineNumber <= range.endLine) {
      delta += range.offsetDelta;
    }
  }
  return $proveCtx("O(n)", $lift("O(n)", delta));
}

/**
 * Create a new dirty range.
 */
function createDirtyRange(
  startLine: number,
  endLine: number,
  offsetDelta: number,
): DirtyLineRangeEntry {
  return Object.freeze({
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
  ranges: DirtyLineRangeList,
  insertionLine: number,
  insertedCount: number,
): DirtyLineRangeList {
  if (ranges === "full-rebuild-needed") return "full-rebuild-needed";
  if (ranges.length === 0 || insertedCount === 0) return ranges;
  const result: DirtyLineRangeEntry[] = [];
  for (const range of ranges) {
    const { startLine: s, endLine: e, offsetDelta: d } = range;
    if (e < insertionLine + 1) {
      // Entirely at or before insertionLine — indices unchanged
      result.push(range);
    } else if (s > insertionLine) {
      // Entirely after insertionLine — shift both bounds up
      result.push(
        Object.freeze({
          startLine: s + insertedCount,
          endLine: e === END_OF_DOCUMENT ? e : e + insertedCount,
          offsetDelta: d,
        }),
      );
    } else {
      // Spans the insertion: s <= insertionLine < insertionLine+1 <= e
      // Before part: s..insertionLine — indices unchanged
      result.push(
        Object.freeze({
          startLine: s,
          endLine: insertionLine,
          offsetDelta: d,
        }),
      );
      // After part: old insertionLine+1..e → new insertionLine+insertedCount+1..e+insertedCount
      result.push(
        Object.freeze({
          startLine: insertionLine + 1 + insertedCount,
          endLine: e === END_OF_DOCUMENT ? e : e + insertedCount,
          offsetDelta: d,
        }),
      );
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
  ranges: DirtyLineRangeList,
  deleteZoneStart: number,
  deleteZoneEnd: number,
): DirtyLineRangeList {
  if (ranges === "full-rebuild-needed") return "full-rebuild-needed";
  const deletedCount = deleteZoneEnd - deleteZoneStart + 1;
  if (ranges.length === 0 || deletedCount <= 0) return ranges;
  const result: DirtyLineRangeEntry[] = [];
  for (const range of ranges) {
    const { startLine: s, endLine: e, offsetDelta: d } = range;
    // Before zone: keep s..min(e, deleteZoneStart-1) unchanged
    if (s < deleteZoneStart) {
      result.push(
        Object.freeze({
          startLine: s,
          endLine: Math.min(e, deleteZoneStart - 1),
          offsetDelta: d,
        }),
      );
    }
    // After zone: shift max(s, deleteZoneEnd+1)..e down by deletedCount
    const postStart = Math.max(s, deleteZoneEnd + 1);
    if (postStart <= e) {
      result.push(
        Object.freeze({
          startLine: postStart - deletedCount,
          endLine: e === END_OF_DOCUMENT ? e : e - deletedCount,
          offsetDelta: d,
        }),
      );
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
  currentRevision: number,
  readText?: ReadTextFn,
): LinearCost<LineIndexState> {
  if (text.length === 0) return $proveCtx("O(n)", $lift("O(n)", state));

  const { positions: newlinePositions, byteLength } = findNewlineBytePositions(text);
  const insertContext = getInsertBoundaryContext(position, byteLength, readText);

  // Same cross-boundary CRLF case as eager insert; rebuild to guarantee correctness.
  if (readText && hasCrossBoundaryCRLFMerge(text, insertContext)) {
    return $proveCtx("O(n)", $lift("O(n)", rebuildFromReadText(state, readText, currentRevision)));
  }

  // No newlines: simple length update (O(log n), no lazy needed)
  if (newlinePositions.length === 0) {
    return $proveCtx(
      "O(n)",
      $lift("O(n)", updateLineLengthLazy(state, position, byteLength, text.length)),
    );
  }

  const location: LogCost<LineLocation | null> =
    findLineAtPosition(state.root, position) ?? $proveCtx("O(log n)", $lift("O(log n)", null));

  return $prove(
    "O(n)",
    $checked(() =>
      $pipe(
        $from(location),
        $map((resolvedLocation) => {
          if (resolvedLocation === null) {
            // Position at or past end - use eager approach for simplicity
            return appendLinesLazy(
              state,
              position,
              text,
              newlinePositions,
              byteLength,
              currentRevision,
            );
          }

          // Insert new lines and mark downstream as dirty
          return insertLinesAtPositionLazy(
            state,
            resolvedLocation,
            text,
            newlinePositions,
            byteLength,
            currentRevision,
            readText,
          );
        }),
      ),
    ),
  );
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
  currentRevision: number,
): LineIndexState {
  if (state.root === null) {
    const newState = buildLineIndexFromText(text, 0);
    return withLineIndexState(state, {
      root: newState.root,
      lineCount: newState.lineCount,
      dirtyRanges: Object.freeze([]),
      lastReconciledRevision: currentRevision,
      rebuildPending: false,
    });
  }

  // For appending at end, offsets are naturally correct (no dirty ranges needed)
  const result = appendLinesStructural(
    state.root,
    state.lineCount,
    position,
    newlinePositions,
    byteLength,
    text,
  );

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
  _currentRevision: number,
  readText?: ReadTextFn,
): LineIndexState {
  // Compute charsBefore using readText if available
  let charsBefore: number | undefined;
  if (readText && location.offsetInLine > 0) {
    const lineStart = getLineStartOffset(state.root, location.lineNumber);
    const prefixText = readText(
      byteOffset(lineStart),
      byteOffset(lineStart + location.offsetInLine),
    );
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
    charsBefore,
  );

  // Remap existing dirty ranges to new tree line numbering before merging
  const remappedRanges = remapDirtyRangesForInsert(
    state.dirtyRanges,
    location.lineNumber,
    newlinePositions.length,
  );

  // Mark all lines after the insertion as dirty (they have stale offsets)
  const newDirtyRange = createDirtyRange(
    location.lineNumber + 1, // First inserted line and all after
    END_OF_DOCUMENT, // To end of document
    byteLength, // Offset delta
  );

  const mergedRanges: DirtyLineRangeList =
    remappedRanges === "full-rebuild-needed"
      ? "full-rebuild-needed"
      : mergeDirtyRanges([...remappedRanges, newDirtyRange], state.maxDirtyRanges);

  return withLineIndexState(state, {
    root: result.root,
    lineCount: result.lineCount,
    dirtyRanges: mergedRanges,
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
  currentRevision: number,
  deleteContext?: DeleteBoundaryContext,
): NLogNCost<LineIndexState> {
  if (start >= end) return $proveCtx("O(n log n)", $lift("O(n log n)", state));
  if (state.root === null) return $proveCtx("O(n log n)", $lift("O(n log n)", state));

  const deleteLength = end - start;
  const deletedNewlines = countDeletedLineBreaks(deletedText, deleteContext);

  // No newlines: just update line length
  if (deletedNewlines === 0) {
    return $proveCtx(
      "O(n log n)",
      $lift("O(n log n)", updateLineLengthLazy(state, start, -deleteLength, -deletedText.length)),
    );
  }

  const startLocation: LogCost<LineLocation | null> =
    findLineAtPosition(state.root, start) ?? $proveCtx("O(log n)", $lift("O(log n)", null));

  return $prove(
    "O(n log n)",
    $checked(() =>
      $pipe(
        $from(startLocation),
        $map((resolvedLocation) => {
          if (resolvedLocation === null) return state;
          // Delete lines and mark remaining as dirty
          return deleteLineRangeLazy(
            state,
            resolvedLocation,
            deletedNewlines,
            deleteLength,
            currentRevision,
            deletedText.length,
          );
        }),
      ),
    ),
  );
}

/**
 * Delete a range of lines with lazy offset tracking.
 */
function deleteLineRangeLazy(
  state: LineIndexState,
  startLocation: LineLocation,
  deletedNewlines: number,
  deleteLength: number,
  currentRevision: number,
  deletedCharLength: number,
): LineIndexState {
  const { lineNumber: startLine, offsetInLine: startOffset } = startLocation;
  const endLine = startLine + deletedNewlines;

  // Multi-line deletions always require O(n) structural rebalancing via rebuildWithDeletedRange,
  // even in lazy mode. RB-tree node removal must rebalance the tree immediately — that structural
  // work cannot be deferred the way offset recalculation can. "Lazy" defers only documentOffset
  // updates, not the tree shape itself, so this path carries the same cost as eager deletion.
  const newState = applyDeleteLineRange(
    state,
    startLine,
    startOffset,
    endLine,
    deleteLength,
    deletedCharLength,
  );
  if (newState === null) {
    return removeLinesToEndLazy(state, startLine, startOffset, currentRevision, deletedCharLength);
  }

  // Remap existing dirty ranges to new tree line numbering before merging
  const remappedRanges = remapDirtyRangesForDelete(state.dirtyRanges, startLine + 1, endLine);

  // Mark lines after deletion as dirty
  const newDirtyRange = createDirtyRange(startLine + 1, END_OF_DOCUMENT, -deleteLength);

  const mergedRanges: DirtyLineRangeList =
    remappedRanges === "full-rebuild-needed"
      ? "full-rebuild-needed"
      : mergeDirtyRanges([...remappedRanges, newDirtyRange], state.maxDirtyRanges);

  return withLineIndexState(state, {
    root: newState.root,
    lineCount: newState.lineCount,
    dirtyRanges: mergedRanges,
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
  currentRevision: number,
  deletedCharLength?: number,
): LineIndexState {
  const newState = removeLinesToEnd(state, startLine, startOffset, deletedCharLength);
  return withLineIndexState(state, {
    root: newState.root,
    lineCount: newState.lineCount,
    dirtyRanges: Object.freeze([]),
    lastReconciledRevision: currentRevision,
    rebuildPending: false,
  });
}

// =============================================================================
// Reconciliation Functions (implementations live in ./reconcile.ts)
// =============================================================================

/**
 * Get a line's content range with on-demand precision.
 * If the line is dirty, computes correct offset before returning.
 */
export function getLineRangePrecise(
  state: LineIndexState<"eager">,
  lineNumber: number,
): LogCost<{ start: ByteOffset; length: ByteLength }> | null;
export function getLineRangePrecise<M extends EvaluationMode>(
  state: LineIndexState<M>,
  lineNumber: number,
): LogCost<{ start: ByteOffset; length: ByteLength }> | null;
export function getLineRangePrecise(
  state: LineIndexState,
  lineNumber: number,
): LogCost<{ start: ByteOffset; length: ByteLength }> | null {
  const node = findLineByNumber(state.root, lineNumber);
  if (node === null) return null;

  // getLineStartOffset uses subtreeByteLength aggregates, which withLineIndexNode
  // keeps current on every tree mutation. The offset it returns is correct in both
  // clean (eager) and dirty (lazy) states — no dirty-range delta adjustment needed.
  return $prove(
    "O(log n)",
    $checked(() =>
      $pipe(
        $from(node),
        $andThen((resolvedNode) =>
          $pipe(
            $from(getLineStartOffset(state.root, lineNumber)),
            $map((start) => ({
              start: byteOffset(start),
              length: toByteLengthBrand(resolvedNode.lineLength),
            })),
          ),
        ),
      ),
    ),
  );
}

// reconcileRange, reconcileFull, reconcileViewport, ReconciliationConfig, and
// mergeDirtyRanges are imported from ./reconcile.ts and re-exported here so
// the public API of line-index.ts is unchanged.
export { reconcileRange, reconcileFull, reconcileViewport, mergeDirtyRanges };
export type { ReconciliationConfig };

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
export function assertEagerOffsets(state: LineIndexState<"eager">, sampleSize = 10): void {
  if (state.root === null || state.lineCount <= 0) return;

  const step = Math.max(1, Math.floor(state.lineCount / sampleSize));
  for (let i = 0; i < state.lineCount; i += step) {
    const node = findLineByNumber(state.root, i);
    if (node === null) continue;

    const expectedOffset = getLineStartOffset(state.root, i);
    if (node.documentOffset !== expectedOffset) {
      throw new Error(
        `assertEagerOffsets: line ${i} has documentOffset=${node.documentOffset} ` +
          `but expected ${expectedOffset}`,
      );
    }
  }
}
