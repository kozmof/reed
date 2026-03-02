/**
 * Reed - A high-performance text editor library
 *
 * Main entry point. All runtime exports are organized into named namespaces:
 *
 * - `store.*`     — store lifecycle, state factories, mutations, reducer, actions, type guards
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
  DocumentStoreConfig,
} from './types/index.ts';

// Action types
export type {
  InsertAction,
  DeleteAction,
  ReplaceAction,
  SetSelectionAction,
  UndoAction,
  RedoAction,
  HistoryClearAction,
  TransactionStartAction,
  TransactionCommitAction,
  TransactionRollbackAction,
  RemoteChange,
  ApplyRemoteAction,
  LoadChunkAction,
  EvictChunkAction,
  DocumentAction,
  DocumentActionType,
  ActionValidationResult,
} from './types/index.ts';

// Store types
export type {
  StoreListener,
  Unsubscribe,
  DocumentStore,
  ReconcilableDocumentStore,
  DocumentStoreWithEvents,
  ReadonlyDocumentStore,
  DocumentReducer,
} from './types/index.ts';

// Branded position types
export type {
  ByteOffset,
  ByteLength,
  CharOffset,
  LineNumber,
  ColumnNumber,
} from './types/index.ts';

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
} from './types/index.ts';

// Piece table types
export type { StreamOptions, DocumentChunk } from './store/index.ts';

// Diff types
export type { DiffEdit, DiffResult } from './store/index.ts';

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
} from './store/index.ts';

// Rendering types
export type {
  VisibleLine,
  ViewportConfig,
  VisibleLinesResult,
  ScrollPosition,
  LineHeightConfig,
} from './store/index.ts';

// Line index types
export type { ReconciliationConfig } from './store/index.ts';

// =============================================================================
// Namespaced runtime exports
// =============================================================================

export { store, query, scan, events, rendering, history, diff, position, cost } from './api/index.ts';
