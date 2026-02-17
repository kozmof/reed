/**
 * Store exports for the Reed document editor.
 */

// Store factory
export { createDocumentStore, createDocumentStoreWithEvents, isDocumentStore } from './features/store.ts';

// Action creators
export { DocumentActions, serializeAction, deserializeAction } from './features/actions.ts';

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
} from './core/state.ts';

// Reducer and line index strategies
export { documentReducer, eagerLineIndex, lazyLineIndex } from './features/reducer.ts';

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
} from './core/piece-table.ts';
export type { StreamOptions, DocumentChunk, PieceTableInsertResult } from './core/piece-table.ts';

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
  // Reconciliation
  reconcileRange,
  reconcileFull,
  reconcileViewport,
  type ReconciliationConfig,
} from './core/line-index.ts';

// Diff and setValue operations
export {
  diff,
  computeSetValueActions,
  computeSetValueActionsOptimized,
  computeSetValueActionsFromState,
  setValue,
} from './features/diff.ts';
export type { DiffEdit, DiffResult, SetValueOptions } from './features/diff.ts';

// Event system
export {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  getAffectedRange,
} from './features/events.ts';
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
} from './features/events.ts';

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
} from './features/rendering.ts';
export type {
  VisibleLine,
  ViewportConfig,
  VisibleLinesResult,
  ScrollPosition,
  LineHeightConfig,
} from './features/rendering.ts';

// Transaction management
export { createTransactionManager } from './features/transaction.ts';
export type { TransactionManager, TransactionResult } from './features/transaction.ts';

// History helpers
export {
  canUndo,
  canRedo,
  getUndoCount,
  getRedoCount,
  isHistoryEmpty,
} from './features/history.ts';
