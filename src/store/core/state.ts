/**
 * State factory functions for the Reed document editor.
 * Creates initial immutable state structures.
 */

import type {
  DocumentState,
  DocumentStoreConfig,
  PieceTableState,
  PieceNode,
  EvaluationMode,
  LineIndexState,
  LineIndexNode,
  SelectionState,
  HistoryState,
  DocumentMetadata,
  ChunkMetadata,
} from '../../types/state.ts';
import { byteOffset, byteLength } from '../../types/branded.ts';
import type { ByteOffset, ByteLength } from '../../types/branded.ts';
import { textEncoder } from './encoding.ts';
import { GrowableBuffer } from './growable-buffer.ts';

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
  totalFileSize: 0,
  maxDirtyRanges: 32,
  reconcileMode: 'idle',
  normalizeInsertedLineEndings: false,
};

/**
 * Create an empty piece table state.
 * @param chunkSize - Bytes per chunk for large-file streaming. 0 = non-chunked (default).
 * @param totalFileSize - Known total byte length of the file. 0 = unknown.
 */
export function createEmptyPieceTableState(chunkSize: number = 0, totalFileSize: number = 0): PieceTableState {
  return Object.freeze({
    root: null,
    originalBuffer: new Uint8Array(0),
    addBuffer: GrowableBuffer.empty(),
    totalLength: 0,
    chunkMap: new Map<number, Uint8Array>(),
    chunkSize,
    nextExpectedChunk: 0,
    loadedChunks: new Set<number>(),
    chunkMetadata: new Map<number, ChunkMetadata>(),
    totalFileSize,
  });
}

/**
 * Create a piece node for 'original' or 'add' buffers. Used internally by piece table operations.
 *
 * All node creation (insert, split, compaction) flows through this function,
 * ensuring subtreeAddLength is always computed correctly from the start.
 * For 'chunk' pieces use createChunkPieceNode instead.
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
    _nodeKind: 'piece' as const,
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
 * Create a chunk piece node that references a loaded chunk buffer.
 *
 * @param chunkIndex - Index into PieceTableState.chunkMap
 * @param offsetInChunk - Byte offset *within* the chunk (not an absolute file offset)
 * @param length - Number of bytes this piece covers
 */
export function createChunkPieceNode(
  chunkIndex: number,
  offsetInChunk: ByteOffset,
  length: ByteLength,
  color: 'red' | 'black' = 'black',
  left: PieceNode | null = null,
  right: PieceNode | null = null
): PieceNode {
  const leftLength = left?.subtreeLength ?? 0;
  const rightLength = right?.subtreeLength ?? 0;
  const leftAddLength = left?.subtreeAddLength ?? 0;
  const rightAddLength = right?.subtreeAddLength ?? 0;

  return Object.freeze({
    _nodeKind: 'piece' as const,
    color,
    left,
    right,
    bufferType: 'chunk' as const,
    chunkIndex,
    start: offsetInChunk,
    length,
    subtreeLength: length + leftLength + rightLength,
    subtreeAddLength: leftAddLength + rightAddLength, // chunk bytes don't count as "add" bytes
  });
}

/**
 * Create a piece table state from initial content.
 * Chunked mode is not applicable here — initial content is loaded eagerly.
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
    addBuffer: GrowableBuffer.empty(1024),
    totalLength: originalBuffer.length,
    chunkMap: new Map<number, Uint8Array>(),
    chunkSize: 0,
    nextExpectedChunk: 0,
    loadedChunks: new Set<number>(),
    chunkMetadata: new Map<number, ChunkMetadata>(),
    totalFileSize: 0,
  });
}

/**
 * Create an empty line index state.
 * Uses a zero-length sentinel node so root is never null when lineCount >= 1.
 * @param maxDirtyRanges - Sentinel collapse threshold for mergeDirtyRanges (default 32)
 */
export function createEmptyLineIndexState(maxDirtyRanges: number = 32): LineIndexState {
  return Object.freeze({
    root: createLineIndexNode(0, 0, 'black'),
    lineCount: 1, // Empty document has 1 line
    dirtyRanges: Object.freeze([]),
    lastReconciledVersion: 0,
    rebuildPending: false,
    maxDirtyRanges,
    unloadedLineCountsByChunk: new Map<number, number>(),
  });
}

/**
 * Create a line index node. Used internally by line index operations.
 */
export function createLineIndexNode(
  documentOffset: number | null,
  lineLength: number,
  color: 'red' | 'black' = 'black',
  left: LineIndexNode | null = null,
  right: LineIndexNode | null = null,
  charLength: number = 0
): LineIndexNode {
  const leftLineCount = left?.subtreeLineCount ?? 0;
  const leftByteLength = left?.subtreeByteLength ?? 0;
  const leftCharLength = left?.subtreeCharLength ?? 0;
  const rightLineCount = right?.subtreeLineCount ?? 0;
  const rightByteLength = right?.subtreeByteLength ?? 0;
  const rightCharLength = right?.subtreeCharLength ?? 0;

  return Object.freeze({
    _nodeKind: 'lineIndex' as const,
    color,
    left,
    right,
    documentOffset,
    lineLength,
    charLength,
    subtreeLineCount: 1 + leftLineCount + rightLineCount,
    subtreeByteLength: lineLength + leftByteLength + rightByteLength,
    subtreeCharLength: charLength + leftCharLength + rightCharLength,
  });
}

/**
 * Build line index from content string.
 * Returns the line index state with all line positions.
 * @param maxDirtyRanges - Sentinel collapse threshold for mergeDirtyRanges (default 32)
 */
export function createLineIndexState(content: string, maxDirtyRanges: number = 32): LineIndexState {
  if (content.length === 0) {
    return createEmptyLineIndexState(maxDirtyRanges);
  }

  // Encode to UTF-8 bytes and scan for line breaks.
  // Line lengths and offsets must be in bytes, not UTF-16 code units.
  //
  // charLength is derived directly from the original JS string via a parallel
  // char-position cursor, avoiding O(L) textDecoder.decode calls.
  // The cursor tracks UTF-16 code units consumed: BMP chars advance by 1,
  // surrogate pairs (code points > U+FFFF) advance by 2.
  const bytes = textEncoder.encode(content);
  const lineStarts: { offset: number; length: number; charLength: number }[] = [];
  let lineStart = 0;
  let lineCharStart = 0; // UTF-16 code unit index of the current line's start in `content`
  let charI = 0;         // UTF-16 code unit index, stays in sync with byte index i

  for (let i = 0; i < bytes.length; ) {
    // Advance charI by one code point, tracking the UTF-8 byte width.
    const cp = content.codePointAt(charI)!;
    const charStep = cp > 0xFFFF ? 2 : 1;   // surrogate pair = 2 UTF-16 units
    const byteStep = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;

    i += byteStep;
    charI += charStep;

    if (bytes[i - byteStep] === 0x0A) { // '\n' — single byte in UTF-8
      lineStarts.push({
        offset: lineStart,
        length: i - lineStart,
        charLength: charI - lineCharStart,
      });
      lineStart = i;
      lineCharStart = charI;
    } else if (bytes[i - byteStep] === 0x0D) { // '\r' — single byte in UTF-8
      // Handle CRLF: peek ahead
      if (i < bytes.length && bytes[i] === 0x0A) {
        // Advance past the '\n'
        i++;
        charI++;
        lineStarts.push({
          offset: lineStart,
          length: i - lineStart,
          charLength: charI - lineCharStart,
        });
      } else {
        // CR only
        lineStarts.push({
          offset: lineStart,
          length: i - lineStart,
          charLength: charI - lineCharStart,
        });
      }
      lineStart = i;
      lineCharStart = charI;
    }
  }

  // Add last line (may not end with newline)
  if (lineStart <= bytes.length) {
    lineStarts.push({
      offset: lineStart,
      length: bytes.length - lineStart,
      charLength: content.length - lineCharStart,
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
    maxDirtyRanges,
    unloadedLineCountsByChunk: new Map<number, number>(),
  });
}

/**
 * Build a balanced Red-Black tree from sorted line data.
 * Uses iterative approach with explicit parent tracking.
 *
 * All nodes are colored `'black'`. This is safe because the median-split recursion
 * produces a perfectly balanced (or near-perfectly balanced) tree, which satisfies
 * the RB black-height invariant without requiring any red nodes. Callers should not
 * interpret the all-black initial state as a violation — it is a valid RB tree for
 * any balanced topology.
 *
 * Follow-on insert/delete operations use the standard `fixInsertWithPath` rebalancer,
 * which handles arbitrary topologies and introduces red nodes as needed.
 */
function buildLineIndexTree(
  lines: { offset: number; length: number; charLength: number }[],
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

  return createLineIndexNode(line.offset, line.length, 'black', left, right, line.charLength);
}

/**
 * Create initial selection state.
 * Default: cursor at position 0.
 */
export function createInitialSelectionState(): SelectionState {
  return Object.freeze({
    ranges: Object.freeze([Object.freeze({ anchor: byteOffset(0), head: byteOffset(0) })] as const),
    primaryIndex: 0,
  });
}

/**
 * Create initial history state.
 */
export function createInitialHistoryState(limit: number = 1000, coalesceTimeout: number = 0): HistoryState {
  return Object.freeze({
    undoStack: null,
    redoStack: null,
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
    normalizeInsertedLineEndings: config.normalizeInsertedLineEndings ?? DEFAULT_CONFIG.normalizeInsertedLineEndings,
  });
}

/**
 * Create initial document state from configuration.
 *
 * When `content` is empty and `chunkSize` is configured, the piece table is
 * initialized in chunked mode: `chunkSize` is set and `chunkMap` starts empty.
 * The caller then populates the document by dispatching `LOAD_CHUNK` actions.
 */
export function createInitialState(
  config: Partial<DocumentStoreConfig> = {}
): DocumentState {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const content = mergedConfig.content;

  // Use chunked mode when content is empty and a chunkSize is explicitly provided.
  // Non-zero DEFAULT_CONFIG.chunkSize alone does not enable chunked mode — the
  // caller must explicitly pass chunkSize to opt in.
  const chunkSize = (content.length === 0 && config.chunkSize !== undefined)
    ? mergedConfig.chunkSize
    : 0;

  const totalFileSize = mergedConfig.totalFileSize ?? 0;

  return Object.freeze({
    version: 0,
    pieceTable: content.length > 0
      ? createPieceTableState(content)
      : createEmptyPieceTableState(chunkSize, totalFileSize),
    lineIndex: createLineIndexState(content, mergedConfig.maxDirtyRanges),
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
 * Preserves the evaluation mode parameter for type safety.
 *
 * **Narrowing caveat:** When `M` is inferred as the union `EvaluationMode` (e.g., because
 * the `state` argument is typed as plain `LineIndexState` without a concrete mode), the
 * `changes` parameter accepts `Partial<LineIndexState<EvaluationMode>>`, which allows
 * `rebuildPending: boolean` even on a nominally eager state. To get compile-time protection
 * against mode violations, ensure `state` is typed with a concrete mode:
 * `LineIndexState<'eager'>` or `LineIndexState<'lazy'>`.
 */
export function withLineIndexState<M extends EvaluationMode = EvaluationMode>(
  state: LineIndexState<M>,
  changes: Partial<LineIndexState<M>>
): LineIndexState<M> {
  return Object.freeze({ ...state, ...changes }) as LineIndexState<M>;
}

/**
 * Narrow a LineIndexState to eager mode with runtime validation.
 * Throws if the state has dirty ranges or a pending rebuild.
 * Use at mode boundaries (e.g., undo/redo) where eager state is required.
 */
export function asEagerLineIndex(state: LineIndexState): LineIndexState<'eager'> {
  if (state.dirtyRanges.length !== 0 || state.rebuildPending) {
    throw new Error('Expected eager LineIndexState but found dirty ranges or pending rebuild');
  }
  return state as LineIndexState<'eager'>;
}

/**
 * Settable fields on a PieceNode.
 * `bufferType` and `chunkIndex` are excluded: `bufferType` is the discriminant
 * and must never change, and `chunkIndex` only exists on ChunkPieceNode.
 * subtreeLength and subtreeAddLength are recomputed automatically.
 */
export type PieceNodeUpdates = Partial<Pick<PieceNode, 'color' | 'left' | 'right' | 'start' | 'length'>>;

/**
 * Helper to create modified piece node with structural sharing.
 * Generic over the concrete variant so the discriminant type is preserved.
 *
 * All tree mutations (insert, delete, rotations) flow through this function,
 * so subtreeAddLength is automatically maintained without changes to
 * rbInsertPiece, deleteRange, rotateLeft/rotateRight, or fixup logic.
 */
export function withPieceNode<T extends PieceNode>(
  node: T,
  changes: PieceNodeUpdates
): T {
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

  return Object.freeze(newNode) as T;
}

/**
 * Settable fields on a LineIndexNode, parameterized by evaluation mode.
 *
 * When `M` is a concrete `'eager'` or `'lazy'`, the `documentOffset` field is
 * constrained accordingly (eager requires `number`, lazy allows `number | null`).
 * Internal rb-tree/line-index callers use the default union mode (`M = EvaluationMode`)
 * and receive no additional constraint — the protection applies only when the caller
 * explicitly uses a concrete mode.
 *
 * subtreeLineCount, subtreeByteLength, and subtreeCharLength are always recomputed
 * from children and lineLength, so they cannot be set directly.
 */
export type LineIndexNodeUpdates<M extends EvaluationMode = EvaluationMode> = Partial<Pick<LineIndexNode<M>, 'color' | 'left' | 'right' | 'documentOffset' | 'lineLength' | 'charLength'>>;

/**
 * Helper to create modified line index node with structural sharing.
 *
 * When `M` is a concrete mode (`'eager'` or `'lazy'`), the `changes.documentOffset`
 * field is type-checked against that mode. Callers using the default union mode are
 * unprotected by design — the internal rb-tree operations work on unparameterized nodes.
 */
export function withLineIndexNode<M extends EvaluationMode = EvaluationMode>(
  node: LineIndexNode<M>,
  changes: LineIndexNodeUpdates<M>
): LineIndexNode<M> {
  const newNode = { ...node, ...changes };

  // Recalculate subtree metadata if children or per-node lengths changed
  if ('left' in changes || 'right' in changes || 'lineLength' in changes || 'charLength' in changes) {
    const leftLineCount = newNode.left?.subtreeLineCount ?? 0;
    const leftByteLength = newNode.left?.subtreeByteLength ?? 0;
    const leftCharLength = newNode.left?.subtreeCharLength ?? 0;
    const rightLineCount = newNode.right?.subtreeLineCount ?? 0;
    const rightByteLength = newNode.right?.subtreeByteLength ?? 0;
    const rightCharLength = newNode.right?.subtreeCharLength ?? 0;

    newNode.subtreeLineCount = 1 + leftLineCount + rightLineCount;
    newNode.subtreeByteLength = newNode.lineLength + leftByteLength + rightByteLength;
    newNode.subtreeCharLength = newNode.charLength + leftCharLength + rightCharLength;
  }

  return Object.freeze(newNode) as LineIndexNode<M>;
}
