/** Read-only traversal helpers for the immutable line-index tree. */
import type { LineIndexNode } from "../../types/state.js";
import type { ByteOffset, CharOffset } from "../../types/branded.js";
import { $beginCost, $proveCtx, type LinearCost, type LogCost } from "../../types/cost-doc.js";

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
      const location = $proveCtx($beginCost("O(log n)"), {
        node,
        lineNumber: lineNumber + leftLineCount,
        offsetInLine: pos - lineStart,
      });
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
      const line = $proveCtx($beginCost("O(log n)"), current);
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
    return $proveCtx($beginCost("O(log n)"), 0 as ByteOffset);
  }
  if (lineNumber < 0) {
    return $proveCtx($beginCost("O(log n)"), 0 as ByteOffset);
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
      return $proveCtx($beginCost("O(log n)"), (offset + leftByteLength) as ByteOffset);
    }
  }

  return $proveCtx($beginCost("O(log n)"), offset as ByteOffset);
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
    return $proveCtx($beginCost("O(log n)"), 0 as CharOffset);
  }
  if (lineNumber < 0) {
    return $proveCtx($beginCost("O(log n)"), 0 as CharOffset);
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
      return $proveCtx($beginCost("O(log n)"), (offset + leftCharLength) as CharOffset);
    }
  }

  return $proveCtx($beginCost("O(log n)"), offset as CharOffset);
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
      const location = $proveCtx($beginCost("O(log n)"), {
        lineNumber: lineNumber + leftLineCount,
        charOffsetInLine: pos - lineStart,
      });
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

  return $proveCtx($beginCost("O(n)"), result);
}
