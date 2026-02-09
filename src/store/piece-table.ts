/**
 * Piece Table operations with immutable Red-Black tree.
 * All operations return new tree structures with structural sharing.
 */

import type {
  PieceNode,
  PieceTableState,
  BufferType,
  BufferReference,
} from '../types/state.ts';
import { byteOffset, type ByteOffset } from '../types/branded.ts';
import { createPieceNode, withPieceNode } from './state.ts';
import { fixInsert, fixRedViolations, isRed, type WithNodeFn } from './rb-tree.ts';
import { textEncoder, textDecoder } from './encoding.ts';

// Type-safe wrapper for withPieceNode to use with generic R-B tree functions
const withPiece: WithNodeFn<PieceNode> = withPieceNode;

// =============================================================================
// Buffer Access Helpers
// =============================================================================

/**
 * Create a BufferReference from a piece node.
 * Provides a type-safe way to reference buffer locations.
 */
export function getPieceBufferRef(piece: PieceNode): BufferReference {
  return { bufferType: piece.bufferType, start: piece.start, length: piece.length };
}

/**
 * Get the raw buffer (Uint8Array) for a buffer reference.
 * Use this when you need direct buffer access.
 */
export function getBuffer(
  state: PieceTableState,
  ref: BufferReference
): Uint8Array {
  return ref.bufferType === 'original' ? state.originalBuffer : state.addBuffer;
}

/**
 * Get a subarray slice from the appropriate buffer.
 * This is the most common operation - extracting bytes from a piece.
 */
export function getBufferSlice(
  state: PieceTableState,
  ref: BufferReference
): Uint8Array {
  const buffer = ref.bufferType === 'original' ? state.originalBuffer : state.addBuffer;
  return buffer.subarray(ref.start, ref.start + ref.length);
}

/**
 * Get the buffer for a piece node directly.
 * Convenience function that combines getPieceBufferRef and getBuffer.
 */
export function getPieceBuffer(
  state: PieceTableState,
  piece: PieceNode
): Uint8Array {
  return piece.bufferType === 'original' ? state.originalBuffer : state.addBuffer;
}

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
  position: ByteOffset
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
export function collectPieces(root: PieceNode | null): readonly PieceNode[] {
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
  start: ByteOffset,
  length: ByteOffset
): PieceNode {
  // Create the new node (always red initially)
  const newPiece = createPieceNode(bufferType, start, length, 'red');

  if (root === null) {
    // Empty tree - new node becomes black root
    return withPieceNode(newPiece, { color: 'black' });
  }

  // Insert using standard BST insertion, tracking the path
  const { newRoot } = bstInsert(root, position, newPiece);

  // Fix Red-Black violations using shared R-B tree utilities
  return fixInsert(newRoot, withPiece);
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
    byteOffset(offsetInPiece),
    piece.color,
    piece.left,
    null
  );

  const rightPiece = createPieceNode(
    piece.bufferType,
    byteOffset(piece.start + offsetInPiece),
    byteOffset(piece.length - offsetInPiece),
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
  position: ByteOffset,
  text: string
): PieceTableState {
  if (text.length === 0) return state;

  const textBytes = textEncoder.encode(text);

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
    const newRoot = createPieceNode('add', byteOffset(newAddStart), byteOffset(textBytes.length), 'black');
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
      byteOffset(newAddStart),
      byteOffset(textBytes.length)
    );
  } else if (location.offsetInPiece === 0) {
    // Insert at the beginning of a piece
    newRoot = rbInsertPiece(
      state.root,
      location.pieceStartOffset,
      'add',
      byteOffset(newAddStart),
      byteOffset(textBytes.length)
    );
  } else if (location.offsetInPiece === location.node.length) {
    // Insert at the end of a piece
    newRoot = rbInsertPiece(
      state.root,
      location.pieceStartOffset + location.node.length,
      'add',
      byteOffset(newAddStart),
      byteOffset(textBytes.length)
    );
  } else {
    // Split the piece and insert in between
    newRoot = insertWithSplit(
      state.root,
      location,
      'add',
      byteOffset(newAddStart),
      byteOffset(textBytes.length)
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
  start: ByteOffset,
  length: ByteOffset
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
 * Replace a piece in the tree using the path for O(log n) performance.
 *
 * Instead of traversing the entire tree O(n), we walk back up the path
 * that was built during findPieceAtPosition, creating only O(log n) new nodes.
 */
function replacePieceInTree(
  _root: PieceNode,
  path: PathEntry[],
  oldNode: PieceNode,
  newNode: PieceNode
): PieceNode {
  // Start with the new node, preserving the old node's children
  let current = withPieceNode(newNode, {
    left: oldNode.left,
    right: oldNode.right,
  });

  // Walk back up the path in reverse, creating new parent nodes
  // This only touches O(log n) nodes - the ones on the path from root to target
  for (let i = path.length - 1; i >= 0; i--) {
    const { node: parent, direction } = path[i];

    if (direction === 'left') {
      current = withPieceNode(parent, { left: current });
    } else {
      current = withPieceNode(parent, { right: current });
    }
  }

  return current;
}

/**
 * Delete text from the piece table in the range [start, end).
 * Returns a new PieceTableState.
 */
export function pieceTableDelete(
  state: PieceTableState,
  start: ByteOffset,
  end: ByteOffset
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

  // Early return: entire subtree is outside delete range
  const subtreeEnd = offset + node.subtreeLength;
  if (subtreeEnd <= deleteStart || offset >= deleteEnd) {
    return node;
  }

  const leftLength = node.left?.subtreeLength ?? 0;
  const pieceStart = offset + leftLength;
  const pieceEnd = pieceStart + node.length;

  // Only recurse into children whose ranges overlap the delete range
  const newLeft = (node.left !== null && deleteStart < pieceStart && deleteEnd > offset)
    ? deleteRange(node.left, offset, deleteStart, deleteEnd)
    : node.left;

  const newRight = (node.right !== null && deleteStart < subtreeEnd && deleteEnd > pieceEnd)
    ? deleteRange(node.right, pieceEnd, deleteStart, deleteEnd)
    : node.right;

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
      byteOffset(keepBefore),
      node.color,
      newLeft,
      null
    );

    const rightPiece = createPieceNode(
      node.bufferType,
      byteOffset(node.start + node.length - keepAfter),
      byteOffset(keepAfter),
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
      length: byteOffset(keepBefore),
    });
  }

  // Keep right part only
  return withPieceNode(node, {
    left: newLeft,
    right: newRight,
    start: byteOffset(node.start + (node.length - keepAfter)),
    length: byteOffset(keepAfter),
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
  let current = withPieceNode(rightmost, { right });

  // Rebuild path, fixing red-red violations at each level
  for (let i = path.length - 1; i >= 0; i--) {
    current = withPieceNode(path[i], { right: current });
    current = fixRedViolations(current, withPiece);
  }

  // Ensure root is black
  if (isRed(current)) {
    current = withPieceNode(current, { color: 'black' });
  }

  return current;
}

// =============================================================================
// Read Operations
// =============================================================================

/**
 * Get the entire document content as a string.
 */
export function getValue(state: PieceTableState): string {
  if (state.root === null) return '';

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
    const buffer = getPieceBuffer(state, piece);
    result.set(buffer.subarray(piece.start, piece.start + piece.length), offset);
    offset += piece.length;
  }

  return textDecoder.decode(result);
}

/**
 * Get text in the range [start, end).
 */
export function getText(
  state: PieceTableState,
  start: ByteOffset,
  end: ByteOffset
): string {
  if (state.root === null) return '';
  if (start < 0) return '';
  if (start >= end) return '';
  if (start >= state.totalLength) return '';

  const actualEnd = Math.min(end, state.totalLength);

  // Pre-allocate result buffer for the exact range size
  const rangeLength = actualEnd - start;
  const result = new Uint8Array(rangeLength);
  const writeState = { offset: 0 };
  collectBytesInRange(state, state.root, 0, start, actualEnd, result, writeState);

  return textDecoder.decode(result.subarray(0, writeState.offset));
}

/**
 * Collect bytes in a range from the tree into a pre-allocated Uint8Array.
 */
function collectBytesInRange(
  state: PieceTableState,
  node: PieceNode | null,
  offset: number,
  start: number,
  end: number,
  result: Uint8Array,
  writeState: { offset: number }
): void {
  if (node === null) return;

  const leftLength = node.left?.subtreeLength ?? 0;
  const pieceStart = offset + leftLength;
  const pieceEnd = pieceStart + node.length;

  // Recurse into left subtree if needed
  if (start < pieceStart) {
    collectBytesInRange(state, node.left, offset, start, end, result, writeState);
  }

  // Collect from this piece if it overlaps
  if (pieceStart < end && pieceEnd > start) {
    const buffer = getPieceBuffer(state, node);
    const copyStart = Math.max(0, start - pieceStart);
    const copyEnd = Math.min(node.length, end - pieceStart);

    result.set(
      buffer.subarray(node.start + copyStart, node.start + copyEnd),
      writeState.offset
    );
    writeState.offset += copyEnd - copyStart;
  }

  // Recurse into right subtree if needed
  if (end > pieceEnd) {
    collectBytesInRange(state, node.right, pieceEnd, start, end, result, writeState);
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
    const buffer = getPieceBuffer(state, piece);
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
): { start: ByteOffset; end: ByteOffset } | null {
  const pieces = collectPieces(state.root);
  let currentLine = 0;
  let lineStartOffset = 0;
  let currentOffset = 0;

  for (const piece of pieces) {
    const buffer = getPieceBuffer(state, piece);
    for (let i = 0; i < piece.length; i++) {
      // Check for newline byte (0x0A)
      if (buffer[piece.start + i] === 0x0A) {
        if (currentLine === lineNumber) {
          // Found the end of target line (include newline)
          return { start: byteOffset(lineStartOffset), end: byteOffset(currentOffset + i + 1) };
        }
        currentLine++;
        lineStartOffset = currentOffset + i + 1;
      }
    }

    currentOffset += piece.length;
  }

  // Handle last line (no trailing newline)
  if (currentLine === lineNumber) {
    return { start: byteOffset(lineStartOffset), end: byteOffset(state.totalLength) };
  }

  return null;
}

// =============================================================================
// Buffer Compaction
// =============================================================================

/**
 * Statistics about buffer usage and waste.
 */
export interface BufferStats {
  /** Total bytes in the add buffer */
  addBufferSize: number;
  /** Bytes actually referenced by pieces */
  addBufferUsed: number;
  /** Bytes wasted (allocated but not referenced) */
  addBufferWaste: number;
  /** Waste ratio (0-1) */
  wasteRatio: number;
}

/**
 * Get statistics about buffer usage.
 * Useful for deciding when to compact.
 */
export function getBufferStats(state: PieceTableState): BufferStats {
  const pieces = collectPieces(state.root);

  // Calculate bytes actually used in add buffer
  let addBufferUsed = 0;
  for (const piece of pieces) {
    if (piece.bufferType === 'add') {
      addBufferUsed += piece.length;
    }
  }

  const addBufferSize = state.addBufferLength;
  const addBufferWaste = addBufferSize - addBufferUsed;
  const wasteRatio = addBufferSize > 0 ? addBufferWaste / addBufferSize : 0;

  return {
    addBufferSize,
    addBufferUsed,
    addBufferWaste,
    wasteRatio,
  };
}

/**
 * Compact the add buffer by removing unreferenced bytes.
 * Returns a new PieceTableState with a compacted buffer.
 *
 * This operation is O(n) where n is the document size.
 * Use getBufferStats() to decide when compaction is worthwhile.
 *
 * @param state - Current piece table state
 * @param threshold - Only compact if waste ratio exceeds this (default: 0.5)
 * @returns New state with compacted buffer, or original if no compaction needed
 */
export function compactAddBuffer(
  state: PieceTableState,
  threshold: number = 0.5
): PieceTableState {
  const stats = getBufferStats(state);

  // Don't compact if waste is below threshold
  if (stats.wasteRatio < threshold) {
    return state;
  }

  // Don't compact if there's nothing to compact
  if (stats.addBufferUsed === 0) {
    // No add buffer content - reset to empty
    return Object.freeze({
      root: state.root,
      originalBuffer: state.originalBuffer,
      addBuffer: new Uint8Array(1024), // Start with small buffer
      addBufferLength: 0,
      totalLength: state.totalLength,
    });
  }

  const pieces = collectPieces(state.root);

  // Build mapping from old offsets to new offsets
  const offsetMap = new Map<number, number>();
  let newOffset = 0;

  // First pass: calculate new offsets for each add buffer piece
  for (const piece of pieces) {
    if (piece.bufferType === 'add') {
      offsetMap.set(piece.start, newOffset);
      newOffset += piece.length;
    }
  }

  // Create new compact buffer
  const newBuffer = new Uint8Array(Math.max(newOffset * 2, 1024)); // Leave room to grow
  let writeOffset = 0;

  // Second pass: copy live data to new buffer
  for (const piece of pieces) {
    if (piece.bufferType === 'add') {
      newBuffer.set(
        state.addBuffer.subarray(piece.start, piece.start + piece.length),
        writeOffset
      );
      writeOffset += piece.length;
    }
  }

  // Rebuild tree with updated offsets
  const newRoot = rebuildTreeWithNewOffsets(state.root, offsetMap);

  return Object.freeze({
    root: newRoot,
    originalBuffer: state.originalBuffer,
    addBuffer: newBuffer,
    addBufferLength: writeOffset,
    totalLength: state.totalLength,
  });
}

/**
 * Rebuild tree with updated add buffer offsets.
 */
function rebuildTreeWithNewOffsets(
  node: PieceNode | null,
  offsetMap: Map<number, number>
): PieceNode | null {
  if (node === null) return null;

  const newLeft = rebuildTreeWithNewOffsets(node.left, offsetMap);
  const newRight = rebuildTreeWithNewOffsets(node.right, offsetMap);

  if (node.bufferType === 'add') {
    const newStart = offsetMap.get(node.start);
    if (newStart !== undefined && newStart !== node.start) {
      return withPieceNode(node, {
        start: byteOffset(newStart),
        left: newLeft,
        right: newRight,
      });
    }
  }

  if (newLeft !== node.left || newRight !== node.right) {
    return withPieceNode(node, { left: newLeft, right: newRight });
  }

  return node;
}

// =============================================================================
// Byte/Character Offset Conversion
// =============================================================================

/**
 * Convert a character offset to byte offset within a given text.
 *
 * Use this when converting user input (string indices) to piece table positions.
 * The piece table internally uses UTF-8 byte offsets, but JavaScript strings
 * use UTF-16 code unit indices.
 *
 * @param text - The text to measure
 * @param charOffset - Character offset (UTF-16 code units, i.e. string index)
 * @returns Byte offset (UTF-8 bytes)
 *
 * @example
 * ```typescript
 * charToByteOffset('Hello', 2);     // Returns 2 (ASCII: 1 byte per char)
 * charToByteOffset('你好', 1);       // Returns 3 (CJK: 3 bytes per char)
 * charToByteOffset('Hello 😀', 7);  // Returns 8 (emoji: 4 bytes)
 * ```
 */
export function charToByteOffset(text: string, charOffset: number): number {
  const clampedOffset = Math.max(0, Math.min(charOffset, text.length));
  return textEncoder.encode(text.slice(0, clampedOffset)).length;
}

/**
 * Convert a byte offset to character offset within a given text.
 *
 * Use this when converting piece table positions to user-visible indices.
 * Returns the character index that corresponds to (or is just before) the given byte offset.
 *
 * @param text - The text to measure
 * @param byteOffset - Byte offset (UTF-8 bytes)
 * @returns Character offset (UTF-16 code units, i.e. string index)
 *
 * @example
 * ```typescript
 * byteToCharOffset('Hello', 2);     // Returns 2 (ASCII: 1 byte per char)
 * byteToCharOffset('你好', 3);       // Returns 1 (CJK: 3 bytes per char)
 * byteToCharOffset('你好', 4);       // Returns 1 (mid-character, returns start)
 * ```
 */
export function byteToCharOffset(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;

  const bytes = textEncoder.encode(text);
  if (byteOffset >= bytes.length) return text.length;

  // Linear scan to find character boundary
  // For most text this is fast; for very long strings, could optimize with binary search
  let charPos = 0;
  let bytePos = 0;

  while (bytePos < byteOffset && charPos < text.length) {
    const charBytes = textEncoder.encode(text[charPos]).length;
    if (bytePos + charBytes > byteOffset) break;
    bytePos += charBytes;
    charPos++;
  }

  return charPos;
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
    const buffer = getPieceBuffer(state, piece);

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
        content: textDecoder.decode(chunkBuffer.subarray(0, chunkOffset)),
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
