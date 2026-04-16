/**
 * Core immutable state types for the Reed document editor.
 * All state structures are read-only and use structural sharing for efficiency.
 */

import type { ByteOffset, ByteLength, CharOffset } from './branded.ts';
import type { GrowableBuffer } from '../store/core/growable-buffer.ts';
import type { NonEmptyReadonlyArray } from './utils.ts';
export type { NonEmptyReadonlyArray } from './utils.ts';
export type { ReadTextFn, DeleteBoundaryContext } from './operations.ts';

// =============================================================================
// Piece Table Types
// =============================================================================

/**
 * Buffer type indicator for piece table operations.
 * - 'original': the initial immutable buffer loaded from content string
 * - 'add': the append-only buffer for user edits
 * - 'chunk': a lazily-loaded chunk buffer for large-file streaming (Phase 3+)
 */
export type BufferType = 'original' | 'add' | 'chunk';

// =============================================================================
// Chunk Metadata Types
// =============================================================================

/**
 * Pre-declared metadata about a chunk before its content is loaded.
 * Dispatch DECLARE_CHUNK_METADATA to register this information so the line
 * index can answer line-count queries for unloaded ranges.
 */
export interface ChunkMetadata {
  /** Index of the chunk this metadata describes. */
  readonly chunkIndex: number;
  /** Total byte length of this chunk (may be less than chunkSize for the final chunk). */
  readonly byteLength: number;
  /**
   * Number of complete newline-terminated lines in this chunk.
   * Used to pre-populate the line count for unloaded ranges.
   */
  readonly lineCount: number;
}

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
 * Reference to a location inside a loaded chunk buffer.
 * `chunkIndex` identifies which entry in `PieceTableState.chunkMap` to use.
 * `start` is the byte offset *within* that chunk (not an absolute file offset).
 */
export interface ChunkBufferRef {
  readonly bufferType: 'chunk';
  readonly chunkIndex: number;
  readonly start: ByteOffset;
  readonly length: ByteLength;
}

/**
 * Discriminated union for type-safe buffer references.
 * Use `bufferType` field to distinguish between buffer types.
 */
export type BufferReference = OriginalBufferRef | AddBufferRef | ChunkBufferRef;

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
 * Fields shared by all piece node variants.
 * Not exported — use the `PieceNode` union type externally.
 */
interface PieceNodeBase extends RBNode<PieceNode> {
  /** Structural discriminant — distinguishes PieceNode from LineIndexNode in generic RB-tree contexts. */
  readonly _nodeKind: 'piece';
  /** Start offset in the buffer (for 'chunk': offset within the chunk, not absolute file offset) */
  readonly start: ByteOffset;
  /** Length of this piece */
  readonly length: ByteLength;
  /** Total length of this subtree (for O(log n) position lookups) */
  readonly subtreeLength: number;
  /** Total add-buffer bytes in this subtree (for O(1) buffer stats) */
  readonly subtreeAddLength: number;
}

/** Piece node backed by the immutable original buffer. */
export interface OriginalPieceNode extends PieceNodeBase {
  readonly bufferType: 'original';
}

/** Piece node backed by the append-only add buffer. */
export interface AddPieceNode extends PieceNodeBase {
  readonly bufferType: 'add';
}

/** Piece node backed by a loaded chunk buffer. */
export interface ChunkPieceNode extends PieceNodeBase {
  readonly bufferType: 'chunk';
  /** Index into `PieceTableState.chunkMap`. Always >= 0. */
  readonly chunkIndex: number;
}

/**
 * Immutable piece node in the Red-Black tree.
 * Discriminated union — narrow with `bufferType` to access variant-specific fields.
 * Only `ChunkPieceNode` carries `chunkIndex`; the other variants do not have that field.
 *
 * Note: Parent references are removed for immutability.
 * Use zipper pattern or path tracking for traversal.
 */
export type PieceNode = OriginalPieceNode | AddPieceNode | ChunkPieceNode;

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
  /**
   * Loaded chunk buffers keyed by chunk index.
   * Empty map when not in chunked mode (chunkSize === 0).
   */
  readonly chunkMap: ReadonlyMap<number, Uint8Array>;
  /**
   * Number of bytes per chunk for large-file streaming.
   * 0 means the document is not in chunked mode.
   */
  readonly chunkSize: number;
  /**
   * High-water mark for sequential chunk loading.
   * After out-of-order support: still advances to Math.max(prev, chunkIndex + 1)
   * on each first-time load. Use `loadedChunks` to test whether a specific chunk
   * has ever been successfully loaded.
   * Irrelevant when chunkSize === 0.
   */
  readonly nextExpectedChunk: number;
  /**
   * Set of chunk indices that have been loaded at least once.
   * Persists across evictions — used to distinguish first-time loads from re-loads
   * and to guard against duplicate registration of unloaded line counts.
   * Empty when chunkSize === 0.
   */
  readonly loadedChunks: ReadonlySet<number>;
  /**
   * Pre-declared metadata for chunks not yet in memory.
   * Populated by DECLARE_CHUNK_METADATA; entries are not removed on LOAD_CHUNK
   * (they serve as a cache for post-eviction re-loads).
   * Empty when chunkSize === 0.
   */
  readonly chunkMetadata: ReadonlyMap<number, ChunkMetadata>;
  /**
   * Known total byte length of the file declared before loading begins.
   * 0 means the total size has not been declared.
   * When chunkSize > 0 and totalFileSize > 0, callers can compute
   * Math.ceil(totalFileSize / chunkSize) to determine the expected chunk count.
   */
  readonly totalFileSize: number;
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
  /**
   * Maximum number of dirty ranges before `mergeDirtyRanges` collapses them
   * into a full-rebuild sentinel. Defaults to 32. Configurable via
   * `DocumentStoreConfig.maxDirtyRanges` to give consumers back-pressure control
   * over background reconciliation frequency.
   */
  readonly maxDirtyRanges: number;
  /**
   * Line counts for chunks declared via DECLARE_CHUNK_METADATA but not yet loaded
   * (or currently evicted).  Keyed by chunk index.
   * `getLineCountFromIndex` sums `lineCount` with the values in this map so that
   * consumers can query the total expected line count before all chunks are loaded.
   * Entries are added by DECLARE_CHUNK_METADATA and EVICT_CHUNK (when metadata is
   * known); entries are removed by LOAD_CHUNK.
   */
  readonly unloadedLineCountsByChunk: ReadonlyMap<number, number>;
}

/**
 * Fully-resolved line index state: no dirty ranges, no pending rebuild.
 * Use this instead of `LineIndexState<'eager'>` to make mode changes visible at call sites.
 */
export type EagerLineIndexState = LineIndexState<'eager'>;

/**
 * Lazily-maintained line index state: may have dirty ranges and a pending rebuild.
 * Use this instead of `LineIndexState<'lazy'>` to make mode changes visible at call sites.
 */
export type LazyLineIndexState = LineIndexState<'lazy'>;

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
 * Internal cons-cell for the persistent stack.
 * Not exported — only module-internal code can call `new PStackCons(...)`,
 * eliminating `as unknown as PStack<T>` casts in push/trim helpers.
 * The `private declare _brand` field (zero runtime overhead) prevents plain
 * object literals from being structurally assignable to `PStack<T>`.
 */
class PStackCons<T> {
  private declare readonly _brand: never;
  readonly top: T;
  readonly rest: PStack<T>;
  readonly size: number;
  constructor(top: T, rest: PStack<T>, size: number) {
    this.top = top;
    this.rest = rest;
    this.size = size;
  }
}

/**
 * Persistent singly-linked stack with O(1) push/pop/peek and automatic
 * structural sharing across snapshots. Empty stack is `null`.
 *
 * External code cannot construct a `PStackCons<T>` value directly (class is
 * unexported), preventing accidental bypass of the helper API.
 */
export type PStack<T> = null | PStackCons<T>;

export const pstackEmpty = <T>(): PStack<T> => null;
export const pstackPush = <T>(s: PStack<T>, v: T): PStack<T> =>
  new PStackCons(v, s, (s?.size ?? 0) + 1);
export const pstackPeek = <T>(s: PStack<T>): T | undefined => s?.top;
export const pstackPop = <T>(s: NonNullable<PStack<T>>): [T, PStack<T>] => [s.top, s.rest];
export const pstackSize = <T>(s: PStack<T>): number => s?.size ?? 0;
export const pstackToArray = <T>(s: PStack<T>): T[] => {
  const arr = new Array<T>(s?.size ?? 0);
  let i = arr.length - 1;
  let cur = s;
  while (cur !== null) { arr[i--] = cur.top; cur = cur.rest; }
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
    result = new PStackCons(items[i], result, maxSize - i);
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
  /** When true, inserted text is normalized to match `lineEnding` */
  readonly normalizeInsertedLineEndings: boolean;
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
  /**
   * When `true`, text inserted via INSERT or REPLACE actions is normalized to
   * match `lineEnding` before being applied. Default: `false` (no coercion).
   *
   * Enable this to prevent silent line-ending drift when the document has a
   * declared `lineEnding` style. When disabled, inserts are stored verbatim.
   */
  normalizeInsertedLineEndings?: boolean;
  /** Timeout in ms for grouping consecutive undo entries (default: 0, disabled) */
  undoGroupTimeout?: number;
  /**
   * Known total byte length of the file, declared before chunk loading begins.
   * When provided alongside `chunkSize`, callers can compute the expected chunk
   * count and the document length is known upfront even before content arrives.
   * 0 or omitted means the total size is not yet known.
   */
  totalFileSize?: number;
  /**
   * Maximum number of disjoint dirty line-ranges before `mergeDirtyRanges`
   * collapses them into a full-rebuild sentinel (default: 32).
   * Increasing this threshold delays the O(n) full rebuild at the cost of a
   * larger dirty-range array; decreasing it triggers rebuilds sooner.
   * Exposing this gives consumers explicit back-pressure control over
   * background reconciliation frequency in high-throughput scenarios.
   */
  maxDirtyRanges?: number;
  /**
   * Controls when background line-index reconciliation is scheduled.
   *
   * - `'idle'` (default) — uses `requestIdleCallback` when available, falling
   *   back to a 200 ms `setTimeout` in environments without rIC (e.g. Node.js).
   *   Suitable for browser-based editors.
   * - `'sync'` — reconciles synchronously on the same tick as the edit.
   *   Useful in test environments where async timers interfere with assertions.
   * - `'none'` — disables background reconciliation entirely. Callers must
   *   trigger reconciliation explicitly via `reconcileNow()` or `getEagerSnapshot()`.
   */
  reconcileMode?: 'idle' | 'sync' | 'none';
}
