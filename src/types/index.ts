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
  DocumentStoreRuntimeConfig,
  ReedLogger,
  ChunkMetadata,
} from "./state.js";

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
} from "./checkpoint.js";

export { CHECKPOINT_FORMAT, CHECKPOINT_VERSION, CheckpointError } from "./checkpoint.js";

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
