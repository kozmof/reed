/**
 * Type exports for the Reed document editor.
 */

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
} from './state.ts';

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
} from './actions.ts';

export {
  isTextEditAction,
  isHistoryAction,
  isTransactionAction,
  isDocumentAction,
  validateAction,
} from './actions.ts';

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
} from './store.ts';

// Branded position types
export type {
  ByteOffset,
  ByteLength,
  CharOffset,
  LineNumber,
  ColumnNumber,
} from './branded.ts';

export type {
  Nat,
  Cost,
  CostLabel,
  CostLevel,
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
} from './cost.ts';

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
} from './branded.ts';

export {
  $,
  checked,
  constCostFn,
  logCostFn,
  linearCostFn,
  nlognCostFn,
  quadCostFn,
  composeCostFn,
  mapCost,
  chainCost,
  start,
  pipe,
  map,
  binarySearch,
  sort,
  filter,
  linearScan,
  forEachN,
} from './cost.ts';
