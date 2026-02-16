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
  OriginalBufferRef,
  AddBufferRef,
  BufferReference,
  NodeColor,
  RBNode,
  PieceNode,
  PieceTableState,
  LineIndexNode,
  LineIndexState,
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
  LineIndexStrategy,
} from './types/index.ts';

// Branded position types
export type {
  ByteOffset,
  ByteLength,
  CharOffset,
  LineNumber,
  ColumnNumber,
} from './types/index.ts';

export {
  byteOffset,
  byteLength,
  charOffset,
  lineNumber,
  columnNumber,
  isValidOffset,
  isValidLineNumber,
  addByteOffset,
  diffByteOffset,
  addCharOffset,
  diffCharOffset,
  nextLine,
  prevLine,
  compareByteOffsets,
  compareCharOffsets,
  clampByteOffset,
  clampCharOffset,
  ZERO_BYTE_OFFSET,
  ZERO_BYTE_LENGTH,
  ZERO_CHAR_OFFSET,
  LINE_ZERO,
  COLUMN_ZERO,
} from './types/index.ts';

// =============================================================================
// Type Guards
// =============================================================================

export {
  isTextEditAction,
  isHistoryAction,
  isTransactionAction,
  isDocumentAction,
  validateAction,
} from './types/index.ts';

// =============================================================================
// Store
// =============================================================================

export {
  createDocumentStore,
  createDocumentStoreWithEvents,
  isDocumentStore,
  DocumentActions,
  serializeAction,
  deserializeAction,
  documentReducer,
  eagerLineIndex,
  lazyLineIndex,
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
  getLine,
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
  getLineContent,
  estimateLineHeight,
  estimateTotalHeight,
  positionToLineColumn,
  lineColumnToPosition,
  selectionToCharOffsets,
  charOffsetsToSelection,
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
