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
 * - `cost.*`      — cost algebra for annotating algorithmic complexity
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
  ChunkMetadata,
} from "./types/index.js";

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

// Cost algebra types
export type {
  Nat,
  Cost,
  CostLabel,
  CostBigO,
  CostInputLabel,
  CostLevel,
  NormalizeCostLabel,
  CostOfLabel,
  Ctx,
  Seq,
  Nest,
  Leq,
  Assert,
  Costed,
  CostFn,
  JoinCostLevel,
  CheckedPlan,
  ConstCost,
  LogCost,
  LinearCost,
  NLogNCost,
  QuadCost,
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
export type { ReconciliationScheduler, ReconciliationSchedulerOptions } from "./store/index.js";
export { createReconciliationScheduler } from "./store/index.js";

// Diff types
export type { DiffEdit, DiffResult, SetValueOptions } from "./store/index.js";

// Event types
export type {
  DocumentEvent,
  ContentChangeEvent,
  SelectionChangeEvent,
  HistoryChangeEvent,
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
  cost,
  attention,
} from "./api/index.js";
