/**
 * Reed - A high-performance text editor library
 *
 * Main entry point exporting core types, store, and utilities.
 */

// =============================================================================
// Types
// =============================================================================

// State types
export type {
  BufferType,
  NodeColor,
  PieceNode,
  PieceTableState,
  LineIndexNode,
  LineIndexState,
  SelectionRange,
  SelectionState,
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
} from './types/index.ts';

// Store types
export type {
  StoreListener,
  Unsubscribe,
  DocumentStore,
  ReadonlyDocumentStore,
  DocumentReducer,
} from './types/index.ts';

// =============================================================================
// Type Guards
// =============================================================================

export {
  isTextEditAction,
  isHistoryAction,
  isTransactionAction,
  isDocumentAction,
} from './types/index.ts';

// =============================================================================
// Store
// =============================================================================

export {
  createDocumentStore,
  isDocumentStore,
  DocumentActions,
  serializeAction,
  deserializeAction,
  documentReducer,
} from './store/index.ts';

// =============================================================================
// State Factories
// =============================================================================

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
} from './store/index.ts';

// =============================================================================
// Piece Table Operations
// =============================================================================

export {
  pieceTableInsert,
  pieceTableDelete,
  getValue,
  getText,
  getLength,
  getLineCount,
  getLine,
  getValueStream,
  findPieceAtPosition,
  collectPieces,
} from './store/index.ts';
export type { StreamOptions, DocumentChunk } from './store/index.ts';

// =============================================================================
// Line Index Operations
// =============================================================================

export {
  lineIndexInsert,
  lineIndexDelete,
  findLineAtPosition,
  findLineByNumber,
  getLineStartOffset,
  getLineRange,
  getLineCountFromIndex,
  collectLines,
  rebuildLineIndex,
} from './store/index.ts';

// =============================================================================
// Diff and setValue Operations
// =============================================================================

export {
  diff,
  computeSetValueActions,
  computeSetValueActionsOptimized,
  computeSetValueActionsFromState,
  setValue,
} from './store/index.ts';
export type { DiffEdit, DiffResult, SetValueOptions } from './store/index.ts';

// =============================================================================
// Event System
// =============================================================================

export {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  getAffectedRange,
} from './store/index.ts';
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

// =============================================================================
// Rendering Utilities
// =============================================================================

export {
  getVisibleLineRange,
  getVisibleLines,
  getVisibleLine,
  estimateLineHeight,
  estimateTotalHeight,
  positionToLineColumn,
  lineColumnToPosition,
} from './store/index.ts';
export type {
  VisibleLine,
  ViewportConfig,
  VisibleLinesResult,
  ScrollPosition,
  LineHeightConfig,
} from './store/index.ts';

// =============================================================================
// History Helpers
// =============================================================================

export {
  canUndo,
  canRedo,
  getUndoCount,
  getRedoCount,
  isHistoryEmpty,
} from './store/index.ts';
