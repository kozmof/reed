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
  EagerLineIndexState,
  LazyLineIndexState,
  EvaluationMode,
  DirtyLineRange,
  DirtyLineRangeEntry,
  DirtyLineRangeList,
  EndOfDocument,
  SelectionRange,
  CharSelectionRange,
  SelectionState,
  HistoryInsertChange,
  HistoryDeleteChange,
  HistoryReplaceChange,
  HistoryChange,
  HistoryEntry,
  HistoryState,
  PStack,
  DocumentMetadata,
  DocumentState,
  DocumentStoreConfigBase,
  DocumentStoreConfig,
  ChunkMetadata,
} from "./state.js";

export type { NonEmptyReadonlyArray } from "./utils.js";
export type { ReadTextFn, DeleteBoundaryContext } from "./operations.js";

export {
  END_OF_DOCUMENT,
  pstackEmpty,
  pstackPush,
  pstackPeek,
  pstackPop,
  pstackSize,
  pstackToArray,
  pstackFromArray,
  pstackTrimToSize,
} from "./state.js";

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
  ContentChangeAction,
  ActionValidationResult,
} from "./actions.js";

export {
  DocumentActionTypes,
  isTextEditAction,
  isHistoryAction,
  isDocumentAction,
  validateAction,
} from "./actions.js";

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
} from "./store.js";

// Branded position types
export type {
  ByteOffset,
  ByteLength,
  CharOffset,
  LineNumber,
  ColumnNumber,
  ReadonlyUint8Array,
} from "./branded.js";

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
} from "./cost-doc.js";

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
} from "./branded.js";

export {
  $declare,
  $prove,
  $proveCtx,
  $checked,
  $constCostFn,
  $logCostFn,
  $linearCostFn,
  $nlognCostFn,
  $quadCostFn,
  $from,
  $lift,
  $pipe,
  $andThen,
  $map,
  $zipCtx,
  $binarySearch,
  $linearScan,
  $forEachN,
  $mapN,
  $value,
} from "./cost-doc.js";
