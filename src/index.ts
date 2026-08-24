/**
 * Reed - A high-performance text editor library
 *
 * Main entry point. All runtime exports are organized into named namespaces:
 *
 * - `store.*`     — store lifecycle, actions, type guards, and unsafe low-level helpers
 * - `query.*`     — O(1) and O(log n) read operations (tree-based lookups)
 * - `scan.*`      — O(n) operations (full document traversals)
 * - `events.*`    — event emitter and document event factories
 * - `rendering.*` — viewport calculations and position/line-column conversion
 * - `history.*`   — undo/redo state queries
 * - `diff.*`      — diff algorithm and setValue operations
 * - `position.*`  — branded position constructors, arithmetic, and constants
 * - `checkpoint.*` — capture state as JSON-safe data and load it back
 *
 * Algorithmic complexity is documented on each namespace member with
 * `@complexity` JSDoc tags; the cost algebra itself is internal to `store/core`.
 *
 * Types are exported flat and can be imported directly:
 *   import type { DocumentState, InsertAction } from 'reed'
 */

// =============================================================================
// Types (flat exports — unchanged)
// =============================================================================

// State types
export type {
  BufferType,
  OriginalBufferRef,
  AddBufferRef,
  BufferReference,
  NodeColor,
  RBNode,
  PieceNode,
  PieceTableState,
  LineIndexNode,
  LineIndexState,
  EvaluationMode,
  DirtyLineRange,
  DirtyLineRangeList,
  SelectionRange,
  CharSelectionRange,
  SelectionState,
  HistoryInsertChange,
  HistoryDeleteChange,
  HistoryReplaceChange,
  HistoryChange,
  HistoryEntry,
  HistoryState,
  DocumentMetadata,
  DocumentState,
  DocumentStoreConfigBase,
  DocumentStoreConfig,
  DocumentStoreRuntimeConfig,
  ReedLogger,
  ChunkMetadata,
} from "./types/index.js";

// Checkpoint format types
export type {
  DocumentCheckpoint,
  CheckpointOptions,
  CheckpointRestoreOptions,
  CheckpointMode,
  CheckpointFormat,
  CheckpointBufferTag,
  CheckpointPiece,
  CheckpointChunk,
  CheckpointChunkMetadata,
  CheckpointLine,
  CheckpointPieceTable,
  CheckpointLineIndex,
  CheckpointSelection,
  CheckpointHistory,
  CheckpointHistoryEntry,
  CheckpointHistoryChange,
  CheckpointMetadata,
  CheckpointAttention,
  CheckpointAttentionLayer,
  CheckpointErrorCode,
} from "./types/index.js";

export { CHECKPOINT_FORMAT, CHECKPOINT_VERSION, CheckpointError } from "./types/index.js";

// Action types
export type {
  InsertAction,
  DeleteAction,
  ReplaceAction,
  SetSelectionAction,
  UndoAction,
  RedoAction,
  HistoryClearAction,
  RemoteChange,
  ApplyRemoteAction,
  CreateAttentionAction,
  DeleteAttentionAction,
  LoadChunkAction,
  EvictChunkAction,
  DeclareChunkMetadataAction,
  DocumentAction,
  DocumentActionType,
  ActionValidationResult,
} from "./types/index.js";

// Store types
export type {
  StoreListener,
  Unsubscribe,
  DocumentStore,
  TransactionControl,
  ReconcilableDocumentStore,
  DocumentStoreWithEvents,
  ReadonlyDocumentStore,
  DocumentReducer,
} from "./types/index.js";

// Branded position types
export type {
  ByteOffset,
  ByteLength,
  CharOffset,
  LineNumber,
  ColumnNumber,
} from "./types/index.js";

// Piece table types
export type { StreamOptions, DocumentChunk } from "./store/index.js";

// Chunk manager types
export type { ChunkLoader, ChunkManagerConfig, ChunkManager } from "./store/index.js";
export { createChunkManager } from "./store/index.js";

// Streaming document loader types
export type { StreamingDocumentLoaderConfig, StreamingDocumentLoader } from "./store/index.js";
export { createStreamingDocumentLoader } from "./store/index.js";

// Reconciliation scheduler
export type {
  ReconciliationScheduler,
  ReconciliationSchedulerFactory,
  ReconciliationSchedulerOptions,
} from "./store/index.js";
export { createReconciliationScheduler } from "./store/index.js";

// Diff types
export type { DiffEdit, DiffResult, SetValueOptions } from "./store/index.js";

// Event types
export type {
  DocumentEvent,
  ContentChangeEvent,
  SelectionChangeEvent,
  HistoryChangeEvent,
  AttentionChangeEvent,
  SaveEvent,
  DirtyChangeEvent,
  AnyDocumentEvent,
  DocumentEventMap,
  EventHandler,
  DocumentEventEmitter,
} from "./store/index.js";

// Rendering types
export type {
  VisibleLine,
  ViewportConfig,
  VisibleLinesResult,
  ScrollPosition,
  LineHeightConfig,
} from "./store/index.js";

// Line index types
export type { ReconciliationConfig } from "./store/index.js";

// Attention layer types
export type {
  PieceID,
  AttentionID,
  AttentionPoint,
  Attention,
  AttentionLayerState,
  ResolvedRange,
  InsertWithAttentionResult,
  DeleteWithAttentionResult,
} from "./store/index.js";

// =============================================================================
// Namespaced runtime exports
// =============================================================================

export {
  store,
  query,
  scan,
  events,
  rendering,
  history,
  diff,
  position,
  attention,
  checkpoint,
} from "./api/index.js";
