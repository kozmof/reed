/**
 * Core immutable state types for the Reed document editor.
 * All state structures are read-only and use structural sharing for efficiency.
 */

import type { ByteOffset } from './branded.ts';

// =============================================================================
// Piece Table Types
// =============================================================================

/**
 * Buffer type indicator for piece table operations.
 */
export type BufferType = 'original' | 'add';

/**
 * Reference to a location in the original (immutable) buffer.
 * Part of the BufferReference discriminated union.
 */
export interface OriginalBufferRef {
  readonly kind: 'original';
  readonly start: number;
  readonly length: number;
}

/**
 * Reference to a location in the add (append-only) buffer.
 * Part of the BufferReference discriminated union.
 */
export interface AddBufferRef {
  readonly kind: 'add';
  readonly start: number;
  readonly length: number;
}

/**
 * Discriminated union for type-safe buffer references.
 * Use `kind` field to distinguish between buffer types.
 */
export type BufferReference = OriginalBufferRef | AddBufferRef;

/**
 * Red-Black tree node color.
 */
export type NodeColor = 'red' | 'black';

/**
 * Generic base interface for Red-Black tree nodes.
 * Provides the common structure (color, left, right) that all RB-tree nodes share.
 * Uses F-bounded polymorphism for type-safe self-referential children.
 *
 * @template T - The concrete node type extending this interface
 */
export interface RBNode<T extends RBNode<T> = RBNode<any>> {
  readonly color: NodeColor;
  readonly left: T | null;
  readonly right: T | null;
}

/**
 * Immutable piece node in the Red-Black tree.
 * Stores no line-related metadata - all line information is in LineIndexState.
 *
 * Note: Parent references are removed for immutability.
 * Use zipper pattern or path tracking for traversal.
 */
export interface PieceNode extends RBNode<PieceNode> {
  /** Which buffer this piece references */
  readonly bufferType: BufferType;
  /** Start offset in the buffer */
  readonly start: number;
  /** Length of this piece */
  readonly length: number;
  /** Total length of this subtree (for O(log n) position lookups) */
  readonly subtreeLength: number;
}

/**
 * Immutable piece table state using persistent data structures.
 * Uses structural sharing for O(log n) updates with O(1) snapshot creation.
 */
export interface PieceTableState {
  /** Root of the Red-Black tree of pieces */
  readonly root: PieceNode | null;
  /** Original buffer: immutable, loaded from file */
  readonly originalBuffer: Uint8Array;
  /** Add buffer: copy-on-write, grows as user types */
  readonly addBuffer: Uint8Array;
  /** Current used length of add buffer */
  readonly addBufferLength: number;
  /** Total document length (cached for O(1) access) */
  readonly totalLength: number;
}

// =============================================================================
// Line Index Types
// =============================================================================

/**
 * Immutable line index node in the separate Red-Black tree.
 * Maps line numbers to absolute byte offsets.
 */
export interface LineIndexNode extends RBNode<LineIndexNode> {
  /** Byte offset in document where this line starts */
  readonly documentOffset: number;
  /** Length of this line including newline character(s) */
  readonly lineLength: number;

  /** Number of lines in this subtree */
  readonly subtreeLineCount: number;
  /** Total byte length of all lines in this subtree */
  readonly subtreeByteLength: number;
}

/**
 * Represents a range of lines with stale offset data.
 * Used for lazy line index maintenance to defer expensive O(n) offset recalculations.
 */
export interface DirtyLineRange {
  /** First line affected (inclusive, 0-indexed) */
  readonly startLine: number;
  /** Last line affected (inclusive), -1 means "to end of document" */
  readonly endLine: number;
  /** Byte delta to apply to lines in this range */
  readonly offsetDelta: number;
  /** Version when this dirty range was created */
  readonly createdAtVersion: number;
}

/**
 * Immutable line index state.
 * Maintains a separate Red-Black tree for O(log n) line lookups.
 * Supports lazy maintenance with dirty range tracking.
 */
export interface LineIndexState {
  /** Root of the line index tree */
  readonly root: LineIndexNode | null;
  /** Total line count (cached for O(1) access) */
  readonly lineCount: number;
  /** Dirty ranges awaiting background reconciliation */
  readonly dirtyRanges: readonly DirtyLineRange[];
  /** Version number of last full reconciliation */
  readonly lastReconciledVersion: number;
  /** Whether a background rebuild is pending */
  readonly rebuildPending: boolean;
}

// =============================================================================
// Selection Types
// =============================================================================

/**
 * A single selection range with anchor and head positions.
 * anchor: where the selection started
 * head: where the selection ends (cursor position)
 */
export interface SelectionRange {
  /** Starting position of the selection */
  readonly anchor: number;
  /** Ending position (cursor) of the selection */
  readonly head: number;
}

/**
 * Immutable selection state supporting multiple cursors.
 */
export interface SelectionState {
  /** Array of selection ranges (supports multiple cursors) */
  readonly ranges: readonly SelectionRange[];
  /** Index of the primary selection in ranges array */
  readonly primaryIndex: number;
}

// =============================================================================
// History Types
// =============================================================================

/**
 * A single change record for undo/redo.
 */
export interface HistoryChange {
  /** Type of change */
  readonly type: 'insert' | 'delete' | 'replace';
  /** Position where the change occurred (byte offset) */
  readonly position: ByteOffset;
  /** Text that was inserted or deleted */
  readonly text: string;
  /** For replace: the original text that was replaced */
  readonly oldText?: string;
}

/**
 * A group of changes that form a single undo unit.
 */
export interface HistoryEntry {
  /** Changes in this entry (applied as a batch) */
  readonly changes: readonly HistoryChange[];
  /** Selection state before this entry was applied */
  readonly selectionBefore: SelectionState;
  /** Selection state after this entry was applied */
  readonly selectionAfter: SelectionState;
  /** Timestamp when this entry was created */
  readonly timestamp: number;
}

/**
 * Immutable history state for undo/redo.
 */
export interface HistoryState {
  /** Stack of undo entries */
  readonly undoStack: readonly HistoryEntry[];
  /** Stack of redo entries */
  readonly redoStack: readonly HistoryEntry[];
  /** Maximum number of entries to keep */
  readonly limit: number;
}

// =============================================================================
// Document Metadata Types
// =============================================================================

/**
 * Document metadata that doesn't affect content.
 */
export interface DocumentMetadata {
  /** File path if loaded from file */
  readonly filePath?: string;
  /** File encoding (default: utf-8) */
  readonly encoding: string;
  /** Line ending style */
  readonly lineEnding: 'lf' | 'crlf' | 'cr';
  /** Whether document has unsaved changes */
  readonly isDirty: boolean;
  /** Last save timestamp */
  readonly lastSaved?: number;
}

// =============================================================================
// Main Document State
// =============================================================================

/**
 * Immutable document state snapshot.
 * All properties are read-only and structurally shared between versions.
 */
export interface DocumentState {
  /** Monotonically increasing version number for change detection */
  readonly version: number;
  /** Piece table containing the document content */
  readonly pieceTable: PieceTableState;
  /** Line index for O(log n) line lookups */
  readonly lineIndex: LineIndexState;
  /** Current selection state */
  readonly selection: SelectionState;
  /** Undo/redo history */
  readonly history: HistoryState;
  /** Document metadata */
  readonly metadata: DocumentMetadata;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration options for creating a document store.
 */
export interface DocumentStoreConfig {
  /** Initial document content */
  content?: string;
  /** Maximum history entries (default: 1000) */
  historyLimit?: number;
  /** Chunk size for large file handling (default: 65536) */
  chunkSize?: number;
  /** File encoding (default: 'utf-8') */
  encoding?: string;
  /** Line ending style (default: 'lf') */
  lineEnding?: 'lf' | 'crlf' | 'cr';
}
