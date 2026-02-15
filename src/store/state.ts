/**
 * State factory functions for the Reed document editor.
 * Creates initial immutable state structures.
 */

import type {
  DocumentState,
  DocumentStoreConfig,
  PieceTableState,
  PieceNode,
  LineIndexState,
  LineIndexNode,
  SelectionState,
  HistoryState,
  DocumentMetadata,
} from '../types/state.ts';
import { byteOffset, byteLength } from '../types/branded.ts';
import type { ByteOffset, ByteLength } from '../types/branded.ts';
import { textEncoder } from './encoding.ts';

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Required<DocumentStoreConfig> = {
  content: '',
  historyLimit: 1000,
  chunkSize: 65536,
  encoding: 'utf-8',
  lineEnding: 'lf',
  undoGroupTimeout: 0,
};

/**
 * Create an empty piece table state.
 */
export function createEmptyPieceTableState(): PieceTableState {
  return Object.freeze({
    root: null,
    originalBuffer: new Uint8Array(0),
    addBuffer: new Uint8Array(0),
    addBufferLength: 0,
    totalLength: 0,
  });
}

/**
 * Create a piece node. Used internally by piece table operations.
 *
 * All node creation (insert, split, compaction) flows through this function,
 * ensuring subtreeAddLength is always computed correctly from the start.
 */
export function createPieceNode(
  bufferType: 'original' | 'add',
  start: ByteOffset,
  length: ByteLength,
  color: 'red' | 'black' = 'black',
  left: PieceNode | null = null,
  right: PieceNode | null = null
): PieceNode {
  const leftLength = left?.subtreeLength ?? 0;
  const rightLength = right?.subtreeLength ?? 0;
  const selfAddLength = bufferType === 'add' ? length : 0;
  const leftAddLength = left?.subtreeAddLength ?? 0;
  const rightAddLength = right?.subtreeAddLength ?? 0;

  return Object.freeze({
    color,
    left,
    right,
    bufferType,
    start,
    length,
    subtreeLength: length + leftLength + rightLength,
    subtreeAddLength: selfAddLength + leftAddLength + rightAddLength,
  });
}

/**
 * Create a piece table state from initial content.
 */
export function createPieceTableState(content: string): PieceTableState {
  if (content.length === 0) {
    return createEmptyPieceTableState();
  }

  // Encode content to original buffer
  const originalBuffer = textEncoder.encode(content);

  // Create single piece spanning entire original buffer
  const root = createPieceNode('original', byteOffset(0), byteLength(originalBuffer.length));

  return Object.freeze({
    root,
    originalBuffer,
    addBuffer: new Uint8Array(1024), // Pre-allocate some space
    addBufferLength: 0,
    totalLength: originalBuffer.length,
  });
}

// TODO(formalization-4.8): Inconsistent sentinel — lineCount:1 but root:null means findLineByNumber(root,0) returns null
/**
 * Create an empty line index state.
 */
export function createEmptyLineIndexState(): LineIndexState {
  return Object.freeze({
    root: null,
    lineCount: 1, // Empty document has 1 line
    dirtyRanges: Object.freeze([]),
    lastReconciledVersion: 0,
    rebuildPending: false,
  });
}

/**
 * Create a line index node. Used internally by line index operations.
 */
export function createLineIndexNode(
  documentOffset: number | 'pending',
  lineLength: number,
  color: 'red' | 'black' = 'black',
  left: LineIndexNode | null = null,
  right: LineIndexNode | null = null
): LineIndexNode {
  const leftLineCount = left?.subtreeLineCount ?? 0;
  const leftByteLength = left?.subtreeByteLength ?? 0;
  const rightLineCount = right?.subtreeLineCount ?? 0;
  const rightByteLength = right?.subtreeByteLength ?? 0;

  return Object.freeze({
    color,
    left,
    right,
    documentOffset,
    lineLength,
    subtreeLineCount: 1 + leftLineCount + rightLineCount,
    subtreeByteLength: lineLength + leftByteLength + rightByteLength,
  });
}

/**
 * Build line index from content string.
 * Returns the line index state with all line positions.
 */
export function createLineIndexState(content: string): LineIndexState {
  if (content.length === 0) {
    return createEmptyLineIndexState();
  }

  // Encode to UTF-8 bytes and scan for line breaks.
  // Line lengths and offsets must be in bytes, not UTF-16 code units.
  const bytes = textEncoder.encode(content);
  const lineStarts: { offset: number; length: number }[] = [];
  let lineStart = 0;

  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0A) { // '\n'
      lineStarts.push({
        offset: lineStart,
        length: i - lineStart + 1, // Include newline
      });
      lineStart = i + 1;
    } else if (bytes[i] === 0x0D) { // '\r'
      // Handle CRLF
      if (i + 1 < bytes.length && bytes[i + 1] === 0x0A) {
        lineStarts.push({
          offset: lineStart,
          length: i - lineStart + 2, // Include \r\n
        });
        i++; // Skip \n
        lineStart = i + 1;
      } else {
        // CR only
        lineStarts.push({
          offset: lineStart,
          length: i - lineStart + 1,
        });
        lineStart = i + 1;
      }
    }
  }

  // Add last line (may not end with newline)
  if (lineStart <= bytes.length) {
    lineStarts.push({
      offset: lineStart,
      length: bytes.length - lineStart,
    });
  }

  // Build balanced tree from line starts
  const root = buildLineIndexTree(lineStarts, 0, lineStarts.length - 1);

  return Object.freeze({
    root,
    lineCount: lineStarts.length,
    dirtyRanges: Object.freeze([]),
    lastReconciledVersion: 0,
    rebuildPending: false,
  });
}

/**
 * Build a balanced Red-Black tree from sorted line data.
 * Uses iterative approach with explicit parent tracking.
 */
function buildLineIndexTree(
  lines: { offset: number; length: number }[],
  start: number,
  end: number
): LineIndexNode | null {
  if (start > end) {
    return null;
  }

  // Use middle element as root for balance
  const mid = Math.floor((start + end) / 2);
  const line = lines[mid];

  const left = buildLineIndexTree(lines, start, mid - 1);
  const right = buildLineIndexTree(lines, mid + 1, end);

  return createLineIndexNode(line.offset, line.length, 'black', left, right);
}

/**
 * Create initial selection state.
 * Default: cursor at position 0.
 */
export function createInitialSelectionState(): SelectionState {
  return Object.freeze({
    ranges: Object.freeze([Object.freeze({ anchor: byteOffset(0), head: byteOffset(0) })]),
    primaryIndex: 0,
  });
}

/**
 * Create initial history state.
 */
export function createInitialHistoryState(limit: number = 1000, coalesceTimeout: number = 0): HistoryState {
  return Object.freeze({
    undoStack: Object.freeze([]),
    redoStack: Object.freeze([]),
    limit,
    coalesceTimeout,
  });
}

/**
 * Create initial document metadata.
 */
export function createInitialMetadata(
  config: Partial<DocumentStoreConfig> = {}
): DocumentMetadata {
  return Object.freeze({
    filePath: undefined,
    encoding: config.encoding ?? DEFAULT_CONFIG.encoding,
    lineEnding: config.lineEnding ?? DEFAULT_CONFIG.lineEnding,
    isDirty: false,
    lastSaved: undefined,
  });
}

/**
 * Create initial document state from configuration.
 */
export function createInitialState(
  config: Partial<DocumentStoreConfig> = {}
): DocumentState {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const content = mergedConfig.content;

  return Object.freeze({
    version: 0,
    pieceTable: createPieceTableState(content),
    lineIndex: createLineIndexState(content),
    selection: createInitialSelectionState(),
    history: createInitialHistoryState(mergedConfig.historyLimit, mergedConfig.undoGroupTimeout),
    metadata: createInitialMetadata(config),
  });
}

/**
 * Helper to create modified state with structural sharing.
 * Only creates new objects for changed properties.
 */
export function withState(
  state: DocumentState,
  changes: Partial<DocumentState>
): DocumentState {
  return Object.freeze({ ...state, ...changes });
}

/**
 * Helper to create modified line index state with structural sharing.
 * Centralizes LineIndexState construction to ensure consistency.
 */
export function withLineIndexState(
  state: LineIndexState,
  changes: Partial<LineIndexState>
): LineIndexState {
  return Object.freeze({ ...state, ...changes });
}

/**
 * Settable fields on a PieceNode.
 * subtreeLength and subtreeAddLength are always recomputed from children and length,
 * so they cannot be set directly.
 */
export type PieceNodeUpdates = Partial<Pick<PieceNode, 'color' | 'left' | 'right' | 'bufferType' | 'start' | 'length'>>;

/**
 * Helper to create modified piece node with structural sharing.
 *
 * All tree mutations (insert, delete, rotations) flow through this function,
 * so subtreeAddLength is automatically maintained without changes to
 * rbInsertPiece, deleteRange, rotateLeft/rotateRight, or fixup logic.
 */
export function withPieceNode(
  node: PieceNode,
  changes: PieceNodeUpdates
): PieceNode {
  const newNode = { ...node, ...changes };

  // Recalculate subtree aggregates if children or length changed
  if ('left' in changes || 'right' in changes || 'length' in changes) {
    const leftLength = newNode.left?.subtreeLength ?? 0;
    const rightLength = newNode.right?.subtreeLength ?? 0;
    newNode.subtreeLength = newNode.length + leftLength + rightLength;

    const selfAddLength = newNode.bufferType === 'add' ? newNode.length : 0;
    const leftAddLength = newNode.left?.subtreeAddLength ?? 0;
    const rightAddLength = newNode.right?.subtreeAddLength ?? 0;
    newNode.subtreeAddLength = selfAddLength + leftAddLength + rightAddLength;
  }

  return Object.freeze(newNode);
}

/**
 * Settable fields on a LineIndexNode.
 * subtreeLineCount and subtreeByteLength are always recomputed from children and lineLength,
 * so they cannot be set directly.
 */
export type LineIndexNodeUpdates = Partial<Pick<LineIndexNode, 'color' | 'left' | 'right' | 'documentOffset' | 'lineLength'>>;

/**
 * Helper to create modified line index node with structural sharing.
 */
export function withLineIndexNode(
  node: LineIndexNode,
  changes: LineIndexNodeUpdates
): LineIndexNode {
  const newNode = { ...node, ...changes };

  // Recalculate subtree metadata if children changed
  if ('left' in changes || 'right' in changes || 'lineLength' in changes) {
    const leftLineCount = newNode.left?.subtreeLineCount ?? 0;
    const leftByteLength = newNode.left?.subtreeByteLength ?? 0;
    const rightLineCount = newNode.right?.subtreeLineCount ?? 0;
    const rightByteLength = newNode.right?.subtreeByteLength ?? 0;

    newNode.subtreeLineCount = 1 + leftLineCount + rightLineCount;
    newNode.subtreeByteLength = newNode.lineLength + leftByteLength + rightByteLength;
  }

  return Object.freeze(newNode);
}
