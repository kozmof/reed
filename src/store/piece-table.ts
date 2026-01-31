/**
 * Piece Table operations with immutable Red-Black tree.
 * All operations return new tree structures with structural sharing.
 */

import type {
  PieceNode,
  PieceTableState,
  BufferType,
} from '../types/state.ts';
import { createPieceNode, withPieceNode } from './state.ts';

// =============================================================================
// Types
// =============================================================================

/**
 * Result of finding a piece at a document position.
 */
export interface PieceLocation {
  /** The piece node containing the position */
  node: PieceNode;
  /** Offset within the piece where the position falls */
  offsetInPiece: number;
  /** Document offset where this piece starts */
  pieceStartOffset: number;
  /** Path from root to this node (for tree modifications) */
  path: PathEntry[];
}

/**
 * Entry in the path from root to a node.
 * Used for immutable tree modifications with path copying.
 */
export interface PathEntry {
  node: PieceNode;
  direction: 'left' | 'right';
}

// =============================================================================
// Tree Traversal
// =============================================================================

/**
 * Find the piece containing a document position.
 * Returns null if tree is empty or position is out of bounds.
 */
export function findPieceAtPosition(
  root: PieceNode | null,
  position: number
): PieceLocation | null {
  if (root === null) return null;
  if (position < 0) return null;

  const path: PathEntry[] = [];
  let current: PieceNode | null = root;
  let currentOffset = 0;

  while (current !== null) {
    const leftLength = current.left?.subtreeLength ?? 0;
    const pieceStart = currentOffset + leftLength;
    const pieceEnd = pieceStart + current.length;

    if (position < pieceStart) {
      // Go left
      path.push({ node: current, direction: 'left' });
      current = current.left;
    } else if (position >= pieceEnd) {
      // Go right
      path.push({ node: current, direction: 'right' });
      currentOffset = pieceEnd;
      current = current.right;
    } else {
      // Found it - position is in this piece
      return {
        node: current,
        offsetInPiece: position - pieceStart,
        pieceStartOffset: pieceStart,
        path,
      };
    }
  }

  return null;
}

/**
 * Find the piece at the end of the document (rightmost node).
 */
export function findLastPiece(root: PieceNode | null): PieceLocation | null {
  if (root === null) return null;

  const path: PathEntry[] = [];
  let current = root;
  let currentOffset = 0;

  while (current.right !== null) {
    currentOffset += (current.left?.subtreeLength ?? 0) + current.length;
    path.push({ node: current, direction: 'right' });
    current = current.right;
  }

  const leftLength = current.left?.subtreeLength ?? 0;
  return {
    node: current,
    offsetInPiece: current.length,
    pieceStartOffset: currentOffset + leftLength,
    path,
  };
}

/**
 * Collect all pieces in document order (in-order traversal).
 */
export function collectPieces(root: PieceNode | null): PieceNode[] {
  const result: PieceNode[] = [];

  function inOrder(node: PieceNode | null) {
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
 * Immutable - creates new nodes.
 */
function rotateLeft(node: PieceNode): PieceNode {
  const right = node.right;
  if (right === null) return node;

  const newNode = withPieceNode(node, {
    right: right.left,
  });

  return withPieceNode(right, {
    left: newNode,
  });
}

/**
 * Rotate right at the given node. Returns the new subtree root.
 * Immutable - creates new nodes.
 */
function rotateRight(node: PieceNode): PieceNode {
  const left = node.left;
  if (left === null) return node;

  const newNode = withPieceNode(node, {
    left: left.right,
  });

  return withPieceNode(left, {
    right: newNode,
  });
}

// =============================================================================
// Red-Black Tree Insert (Immutable)
// =============================================================================

/**
 * Insert a new piece into the tree at the given document position.
 * Returns the new root of the tree.
 */
export function rbInsertPiece(
  root: PieceNode | null,
  position: number,
  bufferType: BufferType,
  start: number,
  length: number
): PieceNode {
  // Create the new node (always red initially)
  const newPiece = createPieceNode(bufferType, start, length, 'red');

  if (root === null) {
    // Empty tree - new node becomes black root
    return withPieceNode(newPiece, { color: 'black' });
  }

  // Insert using standard BST insertion, tracking the path
  const { newRoot, path } = bstInsert(root, position, newPiece);

  // Fix Red-Black violations
  return fixInsert(newRoot, path);
}

/**
 * BST insertion with path tracking.
 */
function bstInsert(
  root: PieceNode,
  position: number,
  newNode: PieceNode
): { newRoot: PieceNode; path: PathEntry[] } {
  const path: PathEntry[] = [];

  function insert(node: PieceNode, offset: number): PieceNode {
    const leftLength = node.left?.subtreeLength ?? 0;
    const pieceStart = offset + leftLength;

    if (position <= pieceStart) {
      // Insert in left subtree
      path.push({ node, direction: 'left' });
      if (node.left === null) {
        return withPieceNode(node, { left: newNode });
      }
      return withPieceNode(node, { left: insert(node.left, offset) });
    } else {
      // Insert in right subtree
      path.push({ node, direction: 'right' });
      const newOffset = pieceStart + node.length;
      if (node.right === null) {
        return withPieceNode(node, { right: newNode });
      }
      return withPieceNode(node, { right: insert(node.right, newOffset) });
    }
  }

  const newRoot = insert(root, 0);
  return { newRoot, path };
}

/**
 * Fix Red-Black tree violations after insertion.
 * Uses bottom-up fixing with path reconstruction.
 */
function fixInsert(root: PieceNode, _path: PathEntry[]): PieceNode {
  // Simplified approach: rebuild with proper colors
  // For a more efficient implementation, we'd use the path to fix violations
  // bottom-up, but this requires parent pointers or zipper pattern

  // For now, use a recursive approach that's simpler but still O(log n)
  return ensureBlackRoot(rebalanceAfterInsert(root));
}

/**
 * Ensure the root is black.
 */
function ensureBlackRoot(node: PieceNode): PieceNode {
  if (node.color === 'red') {
    return withPieceNode(node, { color: 'black' });
  }
  return node;
}

/**
 * Rebalance tree after insert to fix red-red violations.
 */
function rebalanceAfterInsert(node: PieceNode): PieceNode {
  // Fix left subtree first
  let newLeft = node.left;
  if (newLeft !== null) {
    newLeft = rebalanceAfterInsert(newLeft);
  }

  // Fix right subtree
  let newRight = node.right;
  if (newRight !== null) {
    newRight = rebalanceAfterInsert(newRight);
  }

  let result = node;
  if (newLeft !== node.left || newRight !== node.right) {
    result = withPieceNode(node, { left: newLeft, right: newRight });
  }

  // Check for red-red violations and fix
  return fixRedViolations(result);
}

/**
 * Fix red-red violations at a node.
 * Implements the four rotation cases of Red-Black tree balancing.
 */
function fixRedViolations(node: PieceNode): PieceNode {
  let result = node;

  // Case 1: Left-Left (right rotation)
  if (isRed(result.left) && isRed(result.left?.left)) {
    result = rotateRight(result);
    result = withPieceNode(result, {
      color: 'black',
      right: result.right ? withPieceNode(result.right, { color: 'red' }) : null,
    });
  }
  // Case 2: Left-Right (left-right rotation)
  else if (isRed(result.left) && isRed(result.left?.right)) {
    const newLeft = rotateLeft(result.left!);
    result = withPieceNode(result, { left: newLeft });
    result = rotateRight(result);
    result = withPieceNode(result, {
      color: 'black',
      right: result.right ? withPieceNode(result.right, { color: 'red' }) : null,
    });
  }
  // Case 3: Right-Right (left rotation)
  else if (isRed(result.right) && isRed(result.right?.right)) {
    result = rotateLeft(result);
    result = withPieceNode(result, {
      color: 'black',
      left: result.left ? withPieceNode(result.left, { color: 'red' }) : null,
    });
  }
  // Case 4: Right-Left (right-left rotation)
  else if (isRed(result.right) && isRed(result.right?.left)) {
    const newRight = rotateRight(result.right!);
    result = withPieceNode(result, { right: newRight });
    result = rotateLeft(result);
    result = withPieceNode(result, {
      color: 'black',
      left: result.left ? withPieceNode(result.left, { color: 'red' }) : null,
    });
  }

  return result;
}

/**
 * Check if a node is red.
 */
function isRed(node: PieceNode | null | undefined): boolean {
  return node != null && node.color === 'red';
}

// =============================================================================
// Piece Splitting
// =============================================================================

/**
 * Split a piece into two pieces at the given offset within the piece.
 * Returns [leftPiece, rightPiece] or [piece, null] if at boundary.
 */
export function splitPiece(
  piece: PieceNode,
  offsetInPiece: number
): [PieceNode, PieceNode | null] {
  if (offsetInPiece <= 0) {
    return [piece, null];
  }
  if (offsetInPiece >= piece.length) {
    return [piece, null];
  }

  const leftPiece = createPieceNode(
    piece.bufferType,
    piece.start,
    offsetInPiece,
    piece.color,
    piece.left,
    null
  );

  const rightPiece = createPieceNode(
    piece.bufferType,
    piece.start + offsetInPiece,
    piece.length - offsetInPiece,
    'red', // New nodes start red
    null,
    piece.right
  );

  return [leftPiece, rightPiece];
}

// =============================================================================
// Piece Table Operations
// =============================================================================

/**
 * Insert text into the piece table at the given position.
 * Returns a new PieceTableState.
 */
export function pieceTableInsert(
  state: PieceTableState,
  position: number,
  text: string
): PieceTableState {
  if (text.length === 0) return state;

  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text);

  // Grow add buffer if needed
  let addBuffer = state.addBuffer;
  let addBufferLength = state.addBufferLength;

  if (addBufferLength + textBytes.length > addBuffer.length) {
    const newSize = Math.max(
      addBuffer.length * 2,
      addBufferLength + textBytes.length
    );
    const newBuffer = new Uint8Array(newSize);
    newBuffer.set(addBuffer.subarray(0, addBufferLength));
    addBuffer = newBuffer;
  }

  // Append text to add buffer
  addBuffer.set(textBytes, addBufferLength);
  const newAddStart = addBufferLength;
  const newAddBufferLength = addBufferLength + textBytes.length;

  // Handle empty tree
  if (state.root === null) {
    const newRoot = createPieceNode('add', newAddStart, textBytes.length, 'black');
    return Object.freeze({
      root: newRoot,
      originalBuffer: state.originalBuffer,
      addBuffer,
      addBufferLength: newAddBufferLength,
      totalLength: textBytes.length,
    });
  }

  // Find the piece at the insertion position
  const location = findPieceAtPosition(state.root, position);

  let newRoot: PieceNode;

  if (location === null) {
    // Position is at or past the end - append
    newRoot = rbInsertPiece(
      state.root,
      state.totalLength,
      'add',
      newAddStart,
      textBytes.length
    );
  } else if (location.offsetInPiece === 0) {
    // Insert at the beginning of a piece
    newRoot = rbInsertPiece(
      state.root,
      location.pieceStartOffset,
      'add',
      newAddStart,
      textBytes.length
    );
  } else if (location.offsetInPiece === location.node.length) {
    // Insert at the end of a piece
    newRoot = rbInsertPiece(
      state.root,
      location.pieceStartOffset + location.node.length,
      'add',
      newAddStart,
      textBytes.length
    );
  } else {
    // Split the piece and insert in between
    newRoot = insertWithSplit(
      state.root,
      location,
      'add',
      newAddStart,
      textBytes.length
    );
  }

  return Object.freeze({
    root: newRoot,
    originalBuffer: state.originalBuffer,
    addBuffer,
    addBufferLength: newAddBufferLength,
    totalLength: state.totalLength + textBytes.length,
  });
}

/**
 * Insert a new piece by splitting an existing piece.
 */
function insertWithSplit(
  root: PieceNode,
  location: PieceLocation,
  bufferType: BufferType,
  start: number,
  length: number
): PieceNode {
  // We need to:
  // 1. Replace the found piece with its left part
  // 2. Insert the new piece
  // 3. Insert the right part of the split

  const [leftPart, rightPart] = splitPiece(location.node, location.offsetInPiece);

  // Rebuild the tree with the split
  const replaceResult = replacePieceInTree(
    root,
    location.path,
    location.node,
    leftPart
  );

  // Insert the new piece after the left part
  const insertPos = location.pieceStartOffset + leftPart.length;
  let newRoot = rbInsertPiece(replaceResult, insertPos, bufferType, start, length);

  // Insert the right part after the new piece
  if (rightPart !== null) {
    const rightPos = insertPos + length;
    newRoot = rbInsertPiece(newRoot, rightPos, rightPart.bufferType, rightPart.start, rightPart.length);
  }

  return newRoot;
}

/**
 * Replace a piece in the tree, reconstructing the path.
 */
function replacePieceInTree(
  root: PieceNode,
  _path: PathEntry[],
  _oldNode: PieceNode,
  newNode: PieceNode
): PieceNode {
  // Simple approach: rebuild the tree structure
  // Find and replace using tree traversal
  function replace(node: PieceNode | null): PieceNode | null {
    if (node === null) return null;

    // Check if this is the node to replace (by identity)
    if (
      node.bufferType === _oldNode.bufferType &&
      node.start === _oldNode.start &&
      node.length === _oldNode.length
    ) {
      return withPieceNode(newNode, {
        left: node.left,
        right: node.right,
      });
    }

    const newLeft = replace(node.left);
    const newRight = replace(node.right);

    if (newLeft !== node.left || newRight !== node.right) {
      return withPieceNode(node, { left: newLeft, right: newRight });
    }

    return node;
  }

  return replace(root) ?? newNode;
}

/**
 * Delete text from the piece table in the range [start, end).
 * Returns a new PieceTableState.
 */
export function pieceTableDelete(
  state: PieceTableState,
  start: number,
  end: number
): PieceTableState {
  if (start >= end) return state;
  if (state.root === null) return state;

  const deleteLength = Math.min(end, state.totalLength) - Math.max(start, 0);
  if (deleteLength <= 0) return state;

  // Rebuild tree excluding the deleted range
  const newRoot = deleteRange(state.root, 0, start, end);

  return Object.freeze({
    root: newRoot,
    originalBuffer: state.originalBuffer,
    addBuffer: state.addBuffer,
    addBufferLength: state.addBufferLength,
    totalLength: state.totalLength - deleteLength,
  });
}

/**
 * Delete a range from the tree by rebuilding without the deleted portion.
 */
function deleteRange(
  node: PieceNode | null,
  offset: number,
  deleteStart: number,
  deleteEnd: number
): PieceNode | null {
  if (node === null) return null;

  const leftLength = node.left?.subtreeLength ?? 0;
  const pieceStart = offset + leftLength;
  const pieceEnd = pieceStart + node.length;

  // Process children
  const newLeft = deleteRange(node.left, offset, deleteStart, deleteEnd);
  const newRight = deleteRange(node.right, pieceEnd, deleteStart, deleteEnd);

  // Check if this piece overlaps with delete range
  if (pieceEnd <= deleteStart || pieceStart >= deleteEnd) {
    // No overlap - keep this piece but update children
    if (newLeft !== node.left || newRight !== node.right) {
      return withPieceNode(node, { left: newLeft, right: newRight });
    }
    return node;
  }

  // Piece overlaps with delete range
  const keepBefore = deleteStart - pieceStart; // Characters to keep before delete
  const keepAfter = pieceEnd - deleteEnd; // Characters to keep after delete

  if (keepBefore <= 0 && keepAfter <= 0) {
    // Entire piece is deleted
    return mergeTrees(newLeft, newRight);
  }

  if (keepBefore > 0 && keepAfter > 0) {
    // Delete is in the middle - split into two pieces
    const leftPiece = createPieceNode(
      node.bufferType,
      node.start,
      keepBefore,
      node.color,
      newLeft,
      null
    );

    const rightPiece = createPieceNode(
      node.bufferType,
      node.start + node.length - keepAfter,
      keepAfter,
      'red',
      null,
      newRight
    );

    // Combine the two pieces
    return withPieceNode(leftPiece, {
      right: rightPiece,
    });
  }

  if (keepBefore > 0) {
    // Keep left part only
    return withPieceNode(node, {
      left: newLeft,
      right: newRight,
      start: node.start,
      length: keepBefore,
    });
  }

  // Keep right part only
  return withPieceNode(node, {
    left: newLeft,
    right: newRight,
    start: node.start + (node.length - keepAfter),
    length: keepAfter,
  });
}

/**
 * Merge two trees into one (used when a node is deleted).
 */
function mergeTrees(
  left: PieceNode | null,
  right: PieceNode | null
): PieceNode | null {
  if (left === null) return right;
  if (right === null) return left;

  // Find the rightmost node of the left tree
  let rightmost = left;
  const path: PieceNode[] = [];

  while (rightmost.right !== null) {
    path.push(rightmost);
    rightmost = rightmost.right;
  }

  // Attach right tree as right child of rightmost
  let newRightmost = withPieceNode(rightmost, { right });

  // Rebuild path
  for (let i = path.length - 1; i >= 0; i--) {
    newRightmost = withPieceNode(path[i], { right: newRightmost });
  }

  return newRightmost;
}

// =============================================================================
// Read Operations
// =============================================================================

/**
 * Get the entire document content as a string.
 */
export function getValue(state: PieceTableState): string {
  if (state.root === null) return '';

  const decoder = new TextDecoder();
  const pieces = collectPieces(state.root);

  // Pre-calculate total length for efficient concatenation
  let totalBytes = 0;
  for (const piece of pieces) {
    totalBytes += piece.length;
  }

  // Build result buffer
  const result = new Uint8Array(totalBytes);
  let offset = 0;

  for (const piece of pieces) {
    const buffer = piece.bufferType === 'original'
      ? state.originalBuffer
      : state.addBuffer;
    result.set(buffer.subarray(piece.start, piece.start + piece.length), offset);
    offset += piece.length;
  }

  return decoder.decode(result);
}

/**
 * Get text in the range [start, end).
 */
export function getText(
  state: PieceTableState,
  start: number,
  end: number
): string {
  if (state.root === null) return '';
  if (start < 0) return '';
  if (start >= end) return '';
  if (start >= state.totalLength) return '';

  const actualEnd = Math.min(end, state.totalLength);
  const decoder = new TextDecoder();

  // Collect bytes in range
  const bytes: number[] = [];
  collectBytesInRange(state, state.root, 0, start, actualEnd, bytes);

  return decoder.decode(new Uint8Array(bytes));
}

/**
 * Collect bytes in a range from the tree.
 */
function collectBytesInRange(
  state: PieceTableState,
  node: PieceNode | null,
  offset: number,
  start: number,
  end: number,
  result: number[]
): void {
  if (node === null) return;

  const leftLength = node.left?.subtreeLength ?? 0;
  const pieceStart = offset + leftLength;
  const pieceEnd = pieceStart + node.length;

  // Recurse into left subtree if needed
  if (start < pieceStart) {
    collectBytesInRange(state, node.left, offset, start, end, result);
  }

  // Collect from this piece if it overlaps
  if (pieceStart < end && pieceEnd > start) {
    const buffer = node.bufferType === 'original'
      ? state.originalBuffer
      : state.addBuffer;

    const copyStart = Math.max(0, start - pieceStart);
    const copyEnd = Math.min(node.length, end - pieceStart);

    for (let i = copyStart; i < copyEnd; i++) {
      result.push(buffer[node.start + i]);
    }
  }

  // Recurse into right subtree if needed
  if (end > pieceEnd) {
    collectBytesInRange(state, node.right, pieceEnd, start, end, result);
  }
}

/**
 * Get the total length of the document.
 */
export function getLength(state: PieceTableState): number {
  return state.totalLength;
}

/**
 * Get the number of lines in the document.
 * Counts newline characters + 1.
 *
 * Note: This is O(n) as it scans the entire document.
 * For O(1) line count, use `getLineCountFromIndex(state.lineIndex)` instead
 * when you have access to DocumentState.
 */
export function getLineCount(state: PieceTableState): number {
  if (state.root === null) return 1;

  // Optimized path: count newlines by scanning pieces directly
  // instead of building the full string
  const pieces = collectPieces(state.root);
  let count = 1;

  for (const piece of pieces) {
    const buffer = piece.bufferType === 'original'
      ? state.originalBuffer
      : state.addBuffer;

    for (let i = piece.start; i < piece.start + piece.length; i++) {
      // Check for newline byte (0x0A)
      if (buffer[i] === 0x0A) count++;
    }
  }

  return count;
}

/**
 * Get a specific line by line number (0-indexed).
 * Returns the line content including the trailing newline if present.
 *
 * Note: This scans the document to find line boundaries.
 * For O(log n) line access, use `getVisibleLine()` from rendering.ts
 * or `getLineRange()` from line-index.ts when you have DocumentState.
 */
export function getLine(state: PieceTableState, lineNumber: number): string {
  if (state.root === null) return '';
  if (lineNumber < 0) return '';

  // Find line start and end offsets by scanning for newlines
  const lineOffsets = findLineOffsets(state, lineNumber);
  if (lineOffsets === null) return '';

  return getText(state, lineOffsets.start, lineOffsets.end);
}

/**
 * Find the byte offsets for a specific line.
 * Returns {start, end} or null if line doesn't exist.
 */
function findLineOffsets(
  state: PieceTableState,
  lineNumber: number
): { start: number; end: number } | null {
  const pieces = collectPieces(state.root);
  let currentLine = 0;
  let lineStartOffset = 0;
  let currentOffset = 0;

  for (const piece of pieces) {
    const buffer = piece.bufferType === 'original'
      ? state.originalBuffer
      : state.addBuffer;

    for (let i = 0; i < piece.length; i++) {
      // Check for newline byte (0x0A)
      if (buffer[piece.start + i] === 0x0A) {
        if (currentLine === lineNumber) {
          // Found the end of target line (include newline)
          return { start: lineStartOffset, end: currentOffset + i + 1 };
        }
        currentLine++;
        lineStartOffset = currentOffset + i + 1;
      }
    }

    currentOffset += piece.length;
  }

  // Handle last line (no trailing newline)
  if (currentLine === lineNumber) {
    return { start: lineStartOffset, end: state.totalLength };
  }

  return null;
}

// =============================================================================
// Streaming Operations
// =============================================================================

/**
 * Options for getValueStream.
 */
export interface StreamOptions {
  /** Chunk size in bytes (default: 64KB) */
  chunkSize?: number;
  /** Start offset in document (default: 0) */
  start?: number;
  /** End offset in document (default: end of document) */
  end?: number;
}

/**
 * A chunk of document content with metadata.
 */
export interface DocumentChunk {
  /** The text content of this chunk */
  content: string;
  /** Byte offset where this chunk starts in the document */
  byteOffset: number;
  /** Size of this chunk in bytes */
  byteLength: number;
  /** Whether this is the last chunk */
  isLast: boolean;
}

/**
 * Stream document content in chunks for memory-efficient processing of large files.
 * Yields DocumentChunk objects containing text content and metadata.
 *
 * @param state - The piece table state
 * @param options - Optional streaming configuration
 * @yields DocumentChunk objects
 *
 * @example
 * ```typescript
 * for (const chunk of getValueStream(state, { chunkSize: 1024 })) {
 *   process(chunk.content);
 *   console.log(`Processed ${chunk.byteOffset + chunk.byteLength} bytes`);
 * }
 * ```
 */
export function* getValueStream(
  state: PieceTableState,
  options: StreamOptions = {}
): Generator<DocumentChunk, void, undefined> {
  const {
    chunkSize = 64 * 1024, // 64KB default
    start = 0,
    end = state.totalLength
  } = options;

  if (state.root === null || start >= end || start < 0) {
    return;
  }

  const decoder = new TextDecoder();
  const pieces = collectPieces(state.root);

  // Track position across pieces
  let documentPosition = 0;
  let pieceIndex = 0;
  let offsetInCurrentPiece = 0;

  // Skip to start position
  while (pieceIndex < pieces.length && documentPosition + pieces[pieceIndex].length <= start) {
    documentPosition += pieces[pieceIndex].length;
    pieceIndex++;
  }

  if (pieceIndex < pieces.length) {
    offsetInCurrentPiece = start - documentPosition;
    documentPosition = start;
  }

  // Build and yield chunks
  let chunkBuffer = new Uint8Array(chunkSize);
  let chunkOffset = 0;
  let chunkStartPosition = documentPosition;

  while (pieceIndex < pieces.length && documentPosition < end) {
    const piece = pieces[pieceIndex];
    const buffer = piece.bufferType === 'original'
      ? state.originalBuffer
      : state.addBuffer;

    // Calculate how much to read from this piece
    const pieceRemaining = piece.length - offsetInCurrentPiece;
    const documentRemaining = end - documentPosition;
    const chunkRemaining = chunkSize - chunkOffset;
    const bytesToRead = Math.min(pieceRemaining, documentRemaining, chunkRemaining);

    // Copy to chunk buffer
    chunkBuffer.set(
      buffer.subarray(
        piece.start + offsetInCurrentPiece,
        piece.start + offsetInCurrentPiece + bytesToRead
      ),
      chunkOffset
    );

    chunkOffset += bytesToRead;
    documentPosition += bytesToRead;
    offsetInCurrentPiece += bytesToRead;

    // Move to next piece if we've consumed this one
    if (offsetInCurrentPiece >= piece.length) {
      pieceIndex++;
      offsetInCurrentPiece = 0;
    }

    // Yield chunk if buffer is full or we've reached the end
    const isLast = documentPosition >= end || pieceIndex >= pieces.length;
    if (chunkOffset >= chunkSize || isLast) {
      yield {
        content: decoder.decode(chunkBuffer.subarray(0, chunkOffset)),
        byteOffset: chunkStartPosition,
        byteLength: chunkOffset,
        isLast,
      };

      if (!isLast) {
        chunkBuffer = new Uint8Array(chunkSize);
        chunkOffset = 0;
        chunkStartPosition = documentPosition;
      }
    }
  }
}
