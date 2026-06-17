/**
 * Store exports for the Reed document editor.
 */

// Store factory
export {
  createDocumentStore,
  createDocumentStoreWithEvents,
  isDocumentStore,
} from "./features/store.js";

// Action creators
export { DocumentActions, serializeAction, deserializeAction } from "./features/actions.js";

// State factories
export {
  createInitialState,
  createEmptyPieceTableState,
  createPieceTableState,
  createPieceNode,
  createEmptyLineIndexState,
  createLineIndexState,
  createLineIndexNode,
  createInitialSelectionState,
  createInitialHistoryState,
  createInitialMetadata,
  withState,
  withPieceNode,
  withLineIndexNode,
} from "./core/state.js";

// Reducer
export { documentReducer } from "./features/reducer.js";

// Piece table operations
export {
  pieceTableInsert,
  pieceTableDelete,
  getValue,
  getText,
  getLength,
  getValueStream,
  findPieceAtPosition,
  collectPieces,
  // Byte/char conversion utilities
  charToByteOffset,
  byteToCharOffset,
  // Buffer access helpers
  getPieceBufferRef,
  getBuffer,
  getBufferSlice,
  getPieceBuffer,
} from "./core/piece-table.js";
export type { StreamOptions, DocumentChunk, PieceTableInsertResult } from "./core/piece-table.js";

// Line index operations
export {
  lineIndexInsert,
  lineIndexDelete,
  findLineAtPosition,
  findLineByNumber,
  getLineStartOffset,
  getCharStartOffset,
  findLineAtCharPosition,
  getLineRange,
  getLineCountFromIndex,
  collectLines,
  rebuildLineIndex,
  // Lazy line index operations
  lineIndexInsertLazy,
  lineIndexDeleteLazy,
  getLineRangePrecise,
  // Dirty range management
  mergeDirtyRanges,
  isLineDirty,
  getOffsetDeltaForLine,
  // Reconciliation — prefer reconcileNow() / setViewport() over reconcileRange() directly.
  // reconcileRange is a low-level primitive that requires callers to understand dirty-range
  // semantics (version parameter, line bounds). See its JSDoc for details.
  reconcileRange,
  reconcileFull,
  reconcileViewport,
  type ReconciliationConfig,
  // Debug utilities
  assertEagerOffsets,
} from "./core/line-index.js";

// Diff and setValue operations
export {
  diff,
  computeSetValueActions,
  computeSetValueActionsOptimized,
  computeSetValueActionsFromState,
  computeSetValueActionsFromStateWithDiff,
  setValue,
  setValueWithDiff,
  setValueAuto,
} from "./features/diff.js";
export type { DiffEdit, DiffResult, SetValueOptions } from "./features/diff.js";

// Event system
export {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  getAffectedRanges,
} from "./features/events.js";
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
  Unsubscribe,
  DocumentEventEmitter,
} from "./features/events.js";

// Rendering utilities
export {
  getVisibleLineRange,
  getVisibleLines,
  getVisibleLine,
  getLineContent,
  estimateLineHeight,
  estimateTotalHeight,
  positionToLineColumn,
  lineColumnToPosition,
  selectionToCharOffsets,
  charOffsetsToSelection,
} from "./features/rendering.js";
export type {
  VisibleLine,
  ViewportConfig,
  VisibleLinesResult,
  ScrollPosition,
  LineHeightConfig,
} from "./features/rendering.js";

// Transaction management
export { createTransactionManager } from "./features/transaction.js";
export type { TransactionManager, TransactionResult } from "./features/transaction.js";

// History helpers
export {
  canUndo,
  canRedo,
  getUndoCount,
  getRedoCount,
  isHistoryEmpty,
} from "./features/history.js";

// Chunk manager — async chunk fetch subsystem for large-file streaming
export { createChunkManager } from "./features/chunk-manager.js";
export type { ChunkLoader, ChunkManagerConfig, ChunkManager } from "./features/chunk-manager.js";

// Streaming document loader — high-level chunk lifecycle wrapper
export { createStreamingDocumentLoader } from "./features/streaming-loader.js";
export type {
  StreamingDocumentLoaderConfig,
  StreamingDocumentLoader,
} from "./features/streaming-loader.js";

// Reconciliation scheduler
export { createReconciliationScheduler } from "./features/reconciliation-scheduler.js";
export type {
  ReconciliationScheduler,
  ReconciliationSchedulerOptions,
} from "./features/reconciliation-scheduler.js";
