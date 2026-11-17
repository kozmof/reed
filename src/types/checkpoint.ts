/**
 * Types for storing a captured `DocumentState` as JSON-safe data.
 *
 * A checkpoint can be written to disk, IndexedDB, or a socket without a custom
 * JSON replacer. Buffers are base64 strings. Piece and line trees are stored
 * as flat in-order lists and rebuilt as balanced red-black trees on restore.
 *
 * Reed uses snapshot for an in-memory `DocumentState` and checkpoint for
 * its serialized form.
 */

/** Envelope discriminator. Present on every checkpoint. */
export const CHECKPOINT_FORMAT = "reed-checkpoint";
export type CheckpointFormat = typeof CHECKPOINT_FORMAT;

/**
 * Current checkpoint format version. Restore also accepts version 1, which it
 * migrates forward (see `checkpoint-migrate.ts`).
 */
export const CHECKPOINT_VERSION = 2;

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
 * A piece in document order. A chunk piece has a fifth element identifying
 * its chunk, and `start` is a byte offset within that chunk. An add piece may
 * have a fifth element holding its chunk placement key (`afterChunk`), omitted
 * when it is -1.
 */
export type CheckpointPiece =
  | readonly [id: string, buffer: "o", start: number, length: number]
  | readonly [id: string, buffer: "a", start: number, length: number, afterChunk?: number]
  | readonly [id: string, buffer: "c", start: number, length: number, chunkIndex: number];

/** A chunk index and its base64-encoded bytes. */
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
  /** Bytes per chunk, or 0 for a document without chunking. */
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
 * A line's byte length, including its newline, and UTF-16 code-unit length.
 *
 * Restore derives each byte offset from the sum of preceding line lengths.
 * Offsets are not stored, so restore does not trust cached values that could
 * disagree with the tree. `reconcileFull` computes the same sum, and
 * `assertEagerOffsets` checks it.
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

/**
 * Serialized `SelectionState`. Ranges are `[anchor, head]` byte offsets,
 * followed by both placement keys when the range stores either (see
 * `SelectionRange.anchorAfterChunk`). `null` stands for a key the range does
 * not store.
 */
export interface CheckpointSelection {
  readonly ranges: readonly (
    | readonly [anchor: number, head: number]
    | readonly [
        anchor: number,
        head: number,
        anchorAfterChunk: number | null,
        headAfterChunk: number | null,
      ]
  )[];
  readonly primaryIndex: number;
}

/**
 * An undo/redo change tagged `'i'` for insert, `'d'` for delete, or `'r'` for replace.
 * A replace change carries the displaced text as its fourth element.
 * `position` is an anchored position (see `HistoryAnchor`) and may be negative.
 * The placement key `afterChunk` follows the text fields, omitted when it is
 * -1 and nothing follows it.
 *
 * The raw bytes of a change (`HistoryChange.bytes` and, for a replace,
 * `oldBytes`) follow the key as base64 strings, present only when the change
 * has them. A replace without `bytes` but with `oldBytes` writes `null` for
 * `bytes`.
 *
 * Restore recomputes byte lengths from text, or from raw bytes when present,
 * to keep them consistent even when the payload was edited by hand.
 */
export type CheckpointHistoryChange =
  | readonly [kind: "i" | "d", position: number, text: string, afterChunk?: number, bytes?: string]
  | readonly [
      kind: "r",
      position: number,
      text: string,
      oldText: string,
      afterChunk?: number,
      bytes?: string | null,
      oldBytes?: string,
    ];

/**
 * A history selection. Ranges are `[anchor, head]` anchored positions,
 * followed by both placement keys unless both are -1.
 */
export interface CheckpointHistorySelection {
  readonly ranges: readonly (
    | readonly [anchor: number, head: number]
    | readonly [anchor: number, head: number, anchorAfterChunk: number, headAfterChunk: number]
  )[];
  readonly primaryIndex: number;
}

/** Serialized `HistoryEntry`. */
export interface CheckpointHistoryEntry {
  readonly changes: readonly CheckpointHistoryChange[];
  readonly selectionBefore: CheckpointHistorySelection;
  readonly selectionAfter: CheckpointHistorySelection;
  readonly timestamp: number;
}

/**
 * Serialized `HistoryState`.
 * Both stacks are ordered oldest-first, so restore can push them back in order.
 */
export interface CheckpointHistory {
  readonly limit: number;
  readonly coalesceTimeout: number;
  /** History eviction policy. Absent means `"pin"`. */
  readonly evictionPolicy?: "pin" | "drop" | "pin-bounded";
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

/** An attention ID and the piece/boundary pair for each endpoint. */
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
 * Envelope accepted by isCheckpoint. Section contents have not been validated.
 *
 * `version` is any version `restoreCheckpoint` accepts, which includes
 * versions older than `CHECKPOINT_VERSION`. Their sections use that version's
 * layout, so do not read them as a `DocumentCheckpoint`: pass the value to
 * `restoreCheckpoint`, which migrates and validates it.
 */
export interface CheckpointEnvelope {
  readonly format: CheckpointFormat;
  /** A supported version, possibly older than `CHECKPOINT_VERSION`. */
  readonly version: number;
  readonly pieceTable: object;
  readonly lineIndex: object;
  readonly selection: object;
  readonly history: object;
  readonly metadata: object;
  readonly attention: object;
}

/**
 * A captured `DocumentState`, ready to be stringified.
 *
 * Listeners, transaction depth, the reconciliation scheduler, and
 * `ChunkManager` pins and LRU order belong to the store instance. Checkpoints
 * omit them. Creating a store from a checkpoint initializes new runtime state.
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
   * Capturing a chunked document in `'normalized'` mode throws `CHUNKED_NORMALIZE`.
   * Flattening a partially loaded file would discard its unloaded ranges.
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
  /**
   * Maximum combined number of array elements traversed while restoring.
   * This includes nested tuples, history changes, and selection ranges.
   */
  readonly maxCollectionItems?: number;
  /** Maximum combined UTF-16 code units across restored string values. */
  readonly maxStringCodeUnits?: number;
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
 * Restore rejects checkpoints that violate the piece-table invariants in
 * `docs/invariants.md`. This prevents invalid state from corrupting later edits.
 */
export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;

  constructor(code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}
