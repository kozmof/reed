/**
 * Core immutable state types for the Reed document editor.
 * All state structures are read-only and use structural sharing for efficiency.
 */

import type { ByteOffset, ByteLength, CharOffset } from './branded.ts';
import type { GrowableBuffer } from '../store/core/growable-buffer.ts';

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
  readonly bufferType: 'original';
  readonly start: ByteOffset;
  readonly length: ByteLength;
}

/**
 * Reference to a location in the add (append-only) buffer.
 * Part of the BufferReference discriminated union.
 */
export interface AddBufferRef {
  readonly bufferType: 'add';
  readonly start: ByteOffset;
  readonly length: ByteLength;
}

/**
 * Discriminated union for type-safe buffer references.
 * Use `bufferType` field to distinguish between buffer types.
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
export interface RBNode<T extends RBNode<T>> {
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
  /** Structural discriminant — distinguishes PieceNode from LineIndexNode in generic RB-tree contexts. */
  readonly _nodeKind: 'piece';
  /** Which buffer this piece references */
  readonly bufferType: BufferType;
  /** Start offset in the buffer */
  readonly start: ByteOffset;
  /** Length of this piece */
  readonly length: ByteLength;
  /** Total length of this subtree (for O(log n) position lookups) */
  readonly subtreeLength: number;
  /** Total add-buffer bytes in this subtree (for O(1) buffer stats) */
  readonly subtreeAddLength: number;
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
  /** Add buffer: append-only growable buffer for user edits */
  readonly addBuffer: GrowableBuffer;
  /** Total document length (cached for O(1) access) */
  readonly totalLength: number;
}

// =============================================================================
// Line Index Types
// =============================================================================

/**
 * Immutable line index node in the separate Red-Black tree.
 * Maps line numbers to absolute byte offsets.
 *
 * Parameterized by evaluation mode:
 * - `'eager'`: `documentOffset` is always `number` (offsets are computed immediately)
 * - `'lazy'`: `documentOffset` is `number | null` (`null` means pending reconciliation)
 * - Default (union): `number | null` for backward compatibility
 */
export interface LineIndexNode<M extends EvaluationMode = EvaluationMode> extends RBNode<LineIndexNode<M>> {
  /** Structural discriminant — distinguishes LineIndexNode from PieceNode in generic RB-tree contexts. */
  readonly _nodeKind: 'lineIndex';
  /** Byte offset in document where this line starts. null when using lazy mode before reconciliation. */
  readonly documentOffset: M extends 'eager' ? number : number | null;
  /** Length of this line including newline character(s) in bytes */
  readonly lineLength: number;
  /** Length of this line in UTF-16 code units (JavaScript string length) */
  readonly charLength: number;

  /** Number of lines in this subtree */
  readonly subtreeLineCount: number;
  /** Total byte length of all lines in this subtree */
  readonly subtreeByteLength: number;
  /** Total char length (UTF-16 code units) of all lines in this subtree */
  readonly subtreeCharLength: number;
}

/**
 * A concrete range of lines with stale offset data.
 * Used for lazy line index maintenance to defer expensive O(n) offset recalculations.
 */
export interface DirtyLineRangeEntry {
  readonly kind: 'range';
  /** First line affected (inclusive, 0-indexed) */
  readonly startLine: number;
  /** Last line affected (inclusive). Use Number.MAX_SAFE_INTEGER for "to end of document" */
  readonly endLine: number;
  /** Byte delta to apply to lines in this range */
  readonly offsetDelta: number;
}

/**
 * Sentinel value produced by mergeDirtyRanges when range count exceeds 32.
 * Signals that delta information was lost and a full O(n) rebuild is required.
 * Structurally distinct from any legitimate range — no spreading accident can
 * silently drop or create a sentinel.
 */
export interface DirtyLineRangeSentinel {
  readonly kind: 'sentinel';
}

/**
 * Discriminated union for dirty line ranges.
 * Use `range.kind` to distinguish between a concrete range and the full-rebuild sentinel.
 *
 * @example
 * ```ts
 * if (range.kind === 'sentinel') { triggerFullRebuild(); }
 * else { applyDelta(range.startLine, range.endLine, range.offsetDelta); }
 * ```
 */
export type DirtyLineRange = DirtyLineRangeEntry | DirtyLineRangeSentinel;

/**
 * Sentinel value for DirtyLineRange.endLine meaning "to end of document".
 * Use this constant instead of Number.MAX_SAFE_INTEGER directly so the intent
 * is explicit and all sites share a single reference point.
 */
export const END_OF_DOCUMENT = Number.MAX_SAFE_INTEGER;
export type EndOfDocument = typeof END_OF_DOCUMENT;

/** Evaluation mode for the line index: eager has no dirty ranges, lazy may. */
export type EvaluationMode = 'eager' | 'lazy';

/**
 * Callback to read text from the piece table.
 * Used by line index operations to compute char lengths during line splits.
 * Declared here (rather than types/store.ts) because it is an operational
 * parameter of line-index functions, not a store interface type.
 */
export type ReadTextFn = (start: ByteOffset, end: ByteOffset) => string;

/**
 * Optional context around a delete range for accurate mixed line-ending handling.
 * Needed for partial CRLF edits (deleting only '\r' or only '\n').
 * Declared here alongside LineIndexState because it is consumed by line-index operations.
 */
export interface DeleteBoundaryContext {
  prevChar?: string;
  nextChar?: string;
}

/**
 * Immutable line index state, parameterized by evaluation mode.
 * When `M` is `'eager'`, dirty ranges are guaranteed empty and rebuild is not pending.
 * When `M` is `'lazy'`, dirty ranges may exist and rebuild may be pending.
 * The default (union) accepts either mode for backward compatibility.
 */
export interface LineIndexState<M extends EvaluationMode = EvaluationMode> {
  /** Root of the line index tree (parameterized by mode for node-level type safety) */
  readonly root: LineIndexNode<M> | null;
  /** Total line count (cached for O(1) access) */
  readonly lineCount: number;
  /** Dirty ranges awaiting background reconciliation */
  readonly dirtyRanges: M extends 'eager' ? readonly [] : readonly DirtyLineRange[];
  /** Version number of last full reconciliation */
  readonly lastReconciledVersion: number;
  /** Whether a background rebuild is pending */
  readonly rebuildPending: M extends 'eager' ? false : boolean;
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
  /** Starting position of the selection (byte offset) */
  readonly anchor: ByteOffset;
  /** Ending position (cursor) of the selection (byte offset) */
  readonly head: ByteOffset;
}

/**
 * Selection range using character (UTF-16 code unit) offsets.
 * Use this for user-facing APIs where positions correspond to JavaScript string indices.
 * Convert to/from SelectionRange using selectionToCharOffsets/charOffsetsToSelection.
 */
export interface CharSelectionRange {
  readonly anchor: CharOffset;
  readonly head: CharOffset;
}

/**
 * Non-empty readonly array — guarantees at least one element.
 * Used for SelectionState.ranges so that primaryIndex: 0 is always valid.
 */
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/**
 * Immutable selection state supporting multiple cursors.
 */
export interface SelectionState {
  /** Array of selection ranges (supports multiple cursors). Always non-empty. */
  readonly ranges: NonEmptyReadonlyArray<SelectionRange>;
  /** Index of the primary selection in ranges array */
  readonly primaryIndex: number;
}

// =============================================================================
// History Types
// =============================================================================

/**
 * A single insert change record for undo/redo.
 */
export interface HistoryInsertChange {
  readonly type: 'insert';
  /** Position where the change occurred (byte offset) */
  readonly position: ByteOffset;
  /** Text that was inserted */
  readonly text: string;
  /** Pre-computed UTF-8 byte length of `text` */
  readonly byteLength: ByteLength;
}

/**
 * A single delete change record for undo/redo.
 */
export interface HistoryDeleteChange {
  readonly type: 'delete';
  /** Position where the change occurred (byte offset) */
  readonly position: ByteOffset;
  /** Text that was deleted */
  readonly text: string;
  /** Pre-computed UTF-8 byte length of `text` */
  readonly byteLength: ByteLength;
}

/**
 * A single replace change record for undo/redo.
 */
export interface HistoryReplaceChange {
  readonly type: 'replace';
  /** Position where the change occurred (byte offset) */
  readonly position: ByteOffset;
  /** Text that was inserted */
  readonly text: string;
  /** Pre-computed UTF-8 byte length of `text` */
  readonly byteLength: ByteLength;
  /** The original text that was replaced */
  readonly oldText: string;
  /** Pre-computed UTF-8 byte length of `oldText` */
  readonly oldByteLength: ByteLength;
}

/**
 * A single change record for undo/redo.
 * Discriminated union — `oldText` is only present on 'replace' changes.
 */
export type HistoryChange = HistoryInsertChange | HistoryDeleteChange | HistoryReplaceChange;

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

// =============================================================================
// Persistent Stack
// =============================================================================

/**
 * Persistent singly-linked stack with O(1) push/pop/peek and automatic
 * structural sharing across snapshots. Empty stack is `null`.
 *
 * `_pstackBrand` is intentionally not exported. External code cannot construct
 * a `PStackCons<T>` value without going through `pstackPush`, preventing
 * accidental bypass of the helper API.
 */
declare const _pstackBrand: unique symbol;
type PStackCons<T> = { readonly top: T; readonly rest: PStack<T>; readonly size: number; readonly [_pstackBrand]: true };
export type PStack<T> = null | PStackCons<T>;

export const pstackEmpty = <T>(): PStack<T> => null;
export const pstackPush = <T>(s: PStack<T>, v: T): PStack<T> =>
  ({ top: v, rest: s, size: (s?.size ?? 0) + 1 }) as unknown as PStack<T>;
export const pstackPeek = <T>(s: PStack<T>): T | undefined => s?.top;
export const pstackPop = <T>(s: NonNullable<PStack<T>>): [T, PStack<T>] => [s.top, s.rest];
export const pstackSize = <T>(s: PStack<T>): number => s?.size ?? 0;
export const pstackToArray = <T>(s: PStack<T>): T[] => {
  const arr: T[] = [];
  let cur = s;
  while (cur !== null) { arr.push(cur.top); cur = cur.rest; }
  arr.reverse();
  return arr;
};
export const pstackFromArray = <T>(arr: readonly T[]): PStack<T> =>
  arr.reduce<PStack<T>>((acc, v) => pstackPush(acc, v), null);

/**
 * Trim a PStack to at most `maxSize` entries, keeping the `maxSize` most-recently
 * pushed (newest) entries and discarding the rest.
 *
 * Cost: O(maxSize) — traverses only the top `maxSize` nodes, never the full stack.
 * This is strictly better than the O(H) pstackToArray + slice + pstackFromArray
 * round-trip when maxSize << H (e.g. history limit << total history depth).
 *
 * Returns the original stack unchanged (O(1)) when stack.size ≤ maxSize.
 */
export const pstackTrimToSize = <T>(stack: PStack<T>, maxSize: number): PStack<T> => {
  if (stack === null || stack.size <= maxSize) return stack;
  if (maxSize <= 0) return null;
  // Collect the top `maxSize` items (newest first)
  const items: T[] = new Array(maxSize);
  let cur: PStack<T> | null = stack;
  for (let i = 0; i < maxSize && cur !== null; i++) {
    items[i] = cur.top;
    cur = cur.rest;
  }
  // Rebuild cons-list from oldest→newest so top is the newest item
  let result: PStack<T> = null;
  for (let i = maxSize - 1; i >= 0; i--) {
    result = { top: items[i], rest: result, size: maxSize - i } as unknown as PStack<T>;
  }
  return result;
};

// =============================================================================
// History Types
// =============================================================================

/**
 * Immutable history state for undo/redo.
 * `undoStack` and `redoStack` use persistent stacks for O(1) structural
 * sharing across transaction snapshots.
 */
export interface HistoryState {
  /** Stack of undo entries (most recent on top) */
  readonly undoStack: PStack<HistoryEntry>;
  /** Stack of redo entries (most recent on top) */
  readonly redoStack: PStack<HistoryEntry>;
  /** Maximum number of entries to keep */
  readonly limit: number;
  /** Timeout in ms for coalescing consecutive same-type changes (0 = disabled) */
  readonly coalesceTimeout: number;
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
export interface DocumentState<M extends EvaluationMode = EvaluationMode> {
  /** Monotonically increasing version number for change detection */
  readonly version: number;
  /** Piece table containing the document content */
  readonly pieceTable: PieceTableState;
  /** Line index for O(log n) line lookups */
  readonly lineIndex: LineIndexState<M>;
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
  /** Timeout in ms for grouping consecutive undo entries (default: 0, disabled) */
  undoGroupTimeout?: number;
}
