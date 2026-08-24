/**
 * Checkpoint format types — the on-the-wire shape of a captured `DocumentState`.
 *
 * A checkpoint is a plain JSON-safe value: every field is a string, number,
 * boolean, array, or plain object, so it can be written to disk, put in
 * IndexedDB, or sent over a socket without a custom replacer. Byte buffers are
 * base64 strings; the piece and line trees are stored as flat in-order lists and
 * rebuilt into balanced Red-Black trees on restore.
 *
 * "Snapshot" already names an in-memory `DocumentState` throughout Reed
 * (`getSnapshot`, `isCurrentSnapshot`, `getEagerSnapshot`), so the serialized
 * form is called a *checkpoint* instead.
 */

/** Envelope discriminator. Present on every checkpoint. */
export const CHECKPOINT_FORMAT = "reed-checkpoint";
export type CheckpointFormat = typeof CHECKPOINT_FORMAT;

/** Current checkpoint format version. Restore accepts only this version. */
export const CHECKPOINT_VERSION = 1;

/**
 * Capture fidelity.
 *
 * - `'exact'` — preserves the piece list, piece identities, and both buffers.
 *   Attention points keep resolving because they anchor to `PieceID`.
 * - `'normalized'` — collapses the document to a single original-buffer piece and
 *   rebuilds the line index from the text. Smaller, but piece identities change,
 *   so attentions are re-anchored by byte range at capture time.
 */
export type CheckpointMode = "exact" | "normalized";

/**
 * Compact buffer-type tags used in the piece list.
 * `'o'` = original, `'a'` = add, `'c'` = chunk.
 */
export type CheckpointBufferTag = "o" | "a" | "c";

/**
 * One piece, in document order. Chunk pieces carry a fifth element naming the
 * chunk they read from; `start` is then an offset *within* that chunk.
 */
export type CheckpointPiece =
  | readonly [id: string, buffer: "o" | "a", start: number, length: number]
  | readonly [id: string, buffer: "c", start: number, length: number, chunkIndex: number];

/** One chunk buffer: its index plus base64-encoded bytes. */
export type CheckpointChunk = readonly [chunkIndex: number, bytes: string];

/** One pre-declared chunk metadata record. */
export type CheckpointChunkMetadata = readonly [
  chunkIndex: number,
  byteLength: number,
  lineCount: number,
];

/** Serialized `PieceTableState`. */
export interface CheckpointPieceTable {
  /** Allocator cursor. Must exceed every numeric suffix in `pieces`. */
  readonly nextPieceID: number;
  /** Document length in bytes. Must equal the sum of the piece lengths. */
  readonly totalLength: number;
  /** Base64-encoded original buffer. */
  readonly originalBuffer: string;
  /** Base64-encoded add buffer, valid prefix only. */
  readonly addBuffer: string;
  /** Bytes per chunk; 0 when the document is not in chunked mode. */
  readonly chunkSize: number;
  /** High-water mark for sequential chunk loading. */
  readonly nextExpectedChunk: number;
  /** Declared total file size, or 0 when unknown. */
  readonly totalFileSize: number;
  /** Chunk indices loaded at least once, ascending. */
  readonly loadedChunks: readonly number[];
  /** Chunk buffers currently in memory, ascending by index. */
  readonly chunks: readonly CheckpointChunk[];
  /** Pre-declared chunk metadata, ascending by index. */
  readonly chunkMetadata: readonly CheckpointChunkMetadata[];
  /** Pieces in document order. */
  readonly pieces: readonly CheckpointPiece[];
}

/**
 * One line: byte length (including its newline) and UTF-16 code-unit length.
 *
 * Byte offsets are not stored. A line's offset is the prefix sum of the lengths
 * before it — which is exactly what `reconcileFull` computes and what
 * `assertEagerOffsets` checks — so restore derives offsets rather than trusting
 * a cached value that may have drifted from the tree it describes.
 */
export type CheckpointLine = readonly [lineLength: number, charLength: number];

/**
 * Serialized `LineIndexState`.
 *
 * Only eager states are captured, so there are no dirty ranges to carry and no
 * pending rebuild to resume.
 */
export interface CheckpointLineIndex {
  /** Dirty-range collapse threshold to restore on the rebuilt state. */
  readonly maxDirtyRanges: number;
  /** Line counts for declared-but-unloaded chunks, ascending by index. */
  readonly unloadedLineCounts: readonly (readonly [chunkIndex: number, lineCount: number])[];
  /** Lines in document order. */
  readonly lines: readonly CheckpointLine[];
}

/** Serialized `SelectionState`. Ranges are `[anchor, head]` byte offsets. */
export interface CheckpointSelection {
  readonly ranges: readonly (readonly [anchor: number, head: number])[];
  readonly primaryIndex: number;
}

/**
 * One undo/redo change. `'i'` = insert, `'d'` = delete, `'r'` = replace;
 * replace carries the text it displaced as a fourth element.
 *
 * Byte lengths are not stored — they are recomputed from the text on restore so
 * a hand-edited payload cannot desynchronize them from their string.
 */
export type CheckpointHistoryChange =
  | readonly [kind: "i" | "d", position: number, text: string]
  | readonly [kind: "r", position: number, text: string, oldText: string];

/** Serialized `HistoryEntry`. */
export interface CheckpointHistoryEntry {
  readonly changes: readonly CheckpointHistoryChange[];
  readonly selectionBefore: CheckpointSelection;
  readonly selectionAfter: CheckpointSelection;
  readonly timestamp: number;
}

/**
 * Serialized `HistoryState`.
 * Both stacks are ordered oldest-first, so restore can push them back in order.
 */
export interface CheckpointHistory {
  readonly limit: number;
  readonly coalesceTimeout: number;
  readonly undo: readonly CheckpointHistoryEntry[];
  readonly redo: readonly CheckpointHistoryEntry[];
}

/** Serialized `DocumentMetadata`. Absent optional fields are omitted, not null. */
export interface CheckpointMetadata {
  readonly filePath?: string;
  readonly encoding: "utf-8";
  readonly lineEnding: "lf" | "crlf" | "cr";
  readonly normalizeInsertedLineEndings: boolean;
  readonly isDirty: boolean;
  readonly lastSaved?: number;
}

/** One attention: its id, then the piece/boundary pair for each endpoint. */
export type CheckpointAttention = readonly [
  id: string,
  startPieceID: string,
  startBoundary: number,
  endPieceID: string,
  endBoundary: number,
];

/** Serialized `AttentionLayerState`. */
export interface CheckpointAttentionLayer {
  /** Allocator cursor. Must exceed every numeric suffix in `attentions`. */
  readonly nextID: number;
  readonly attentions: readonly CheckpointAttention[];
}

/**
 * A captured `DocumentState`, ready to be stringified.
 *
 * Store runtime is deliberately absent: listeners, transaction depth, the
 * reconciliation scheduler, and `ChunkManager` pins/LRU order all belong to a
 * store instance rather than to the state, and are rebuilt fresh on restore.
 */
export interface DocumentCheckpoint {
  readonly format: CheckpointFormat;
  readonly version: number;
  readonly mode: CheckpointMode;
  readonly revision: number;
  readonly selectionRevision: number;
  readonly pieceTable: CheckpointPieceTable;
  readonly lineIndex: CheckpointLineIndex;
  readonly selection: CheckpointSelection;
  readonly history: CheckpointHistory;
  readonly metadata: CheckpointMetadata;
  readonly attention: CheckpointAttentionLayer;
}

/** Options for `createCheckpoint` / `encodeCheckpoint`. */
export interface CheckpointOptions {
  /**
   * Capture fidelity (default: `'exact'`).
   *
   * `'normalized'` throws `CHUNKED_NORMALIZE` for chunked documents: flattening
   * a partially-loaded file to text would silently drop the unloaded ranges.
   */
  readonly mode?: CheckpointMode;
  /**
   * Drop unreferenced add-buffer bytes before capturing (default: `true`).
   * Trades an O(n) compaction pass for a smaller payload. Ignored in
   * `'normalized'` mode, which discards the add buffer entirely.
   */
  readonly compact?: boolean;
}

/**
 * Optional resource limits for restoring a checkpoint from untrusted input.
 * Omitted limits remain unrestricted for backward compatibility.
 */
export interface CheckpointRestoreOptions {
  /** Maximum UTF-16 code units accepted by `decodeCheckpoint`. */
  readonly maxJsonLength?: number;
  /** Maximum combined decoded size of original, add, and chunk buffers. */
  readonly maxBufferBytes?: number;
  /** Maximum number of piece-table pieces. */
  readonly maxPieces?: number;
  /** Maximum total logical lines, including lines declared for unloaded chunks. */
  readonly maxLines?: number;
  /** Maximum combined number of undo and redo entries. */
  readonly maxHistoryEntries?: number;
  /** Maximum number of attention records. */
  readonly maxAttentions?: number;
}

/**
 * Why a checkpoint was rejected. Codes are stable across releases so callers can
 * branch on them (e.g. re-load from source on `VERSION_UNSUPPORTED`, report
 * corruption otherwise).
 */
export type CheckpointErrorCode =
  /** Value is not an object, or its `format` field is not `'reed-checkpoint'`. */
  | "NOT_A_CHECKPOINT"
  /** The checkpoint version is not supported by this build. */
  | "VERSION_UNSUPPORTED"
  /** A required field is missing or has the wrong runtime type. */
  | "MALFORMED"
  /** A piece range falls outside the buffer it reads from. */
  | "PIECE_OUT_OF_BOUNDS"
  /** A chunk piece names a chunk that is not present in `chunks`. */
  | "CHUNK_MISSING"
  /** Chunk pieces are not in ascending `chunkIndex` order. */
  | "CHUNK_ORDER"
  /** Piece lengths do not sum to `totalLength`. */
  | "LENGTH_MISMATCH"
  /** Line lengths do not sum to the loaded document length. */
  | "LINE_INDEX_MISMATCH"
  /** An allocator cursor does not exceed the identities already in use. */
  | "ID_COLLISION"
  /** A selection offset lies outside the document, or `ranges` is empty. */
  | "SELECTION_OUT_OF_RANGE"
  /** History limit, stack depth, or an entry's shape is invalid. */
  | "HISTORY_INVALID"
  /** An attention point names an unknown piece or an out-of-range boundary. */
  | "ATTENTION_DANGLING"
  /** `'normalized'` capture was requested for a chunked document. */
  | "CHUNKED_NORMALIZE"
  /** A configured restore resource limit was exceeded. */
  | "RESOURCE_LIMIT";

/**
 * Thrown by `restoreCheckpoint` / `decodeCheckpoint` when a payload cannot be
 * trusted, and by `createCheckpoint` when capture is not possible.
 *
 * Restore is fail-closed: a checkpoint that would produce a piece table
 * violating the invariants in `docs/invariants.md` is rejected outright rather
 * than loaded into a store where it would corrupt later edits.
 */
export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;

  constructor(code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}
