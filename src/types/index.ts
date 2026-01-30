/**
 * Type exports for the Reed document editor.
 */

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
} from './actions.ts';

export {
  isTextEditAction,
  isHistoryAction,
  isTransactionAction,
  isDocumentAction,
} from './actions.ts';

// Store types
export type {
  StoreListener,
  Unsubscribe,
  DocumentStore,
  ReadonlyDocumentStore,
  DocumentReducer,
} from './store.ts';
