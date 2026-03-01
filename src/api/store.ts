/**
 * Store namespace — store lifecycle, state factories, mutations, reducer, actions, and type guards.
 */

import {
  createDocumentStore,
  createDocumentStoreWithEvents,
  isDocumentStore,
} from '../store/features/store.ts';
import { DocumentActions, serializeAction, deserializeAction } from '../store/features/actions.ts';
import {
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
} from '../store/core/state.ts';
import { documentReducer, eagerLineIndex, lazyLineIndex } from '../store/features/reducer.ts';
import {
  pieceTableInsert,
  pieceTableDelete,
  charToByteOffset,
  byteToCharOffset,
  getPieceBufferRef,
  getBuffer,
  getBufferSlice,
  getPieceBuffer,
} from '../store/core/piece-table.ts';
import {
  lineIndexInsert,
  lineIndexDelete,
  lineIndexInsertLazy,
  lineIndexDeleteLazy,
  reconcileRange,
  reconcileFull,
  reconcileViewport,
} from '../store/core/line-index.ts';
import {
  isTextEditAction,
  isHistoryAction,
  isTransactionAction,
  isDocumentAction,
  validateAction,
} from '../types/actions.ts';

export const store = {
  // Store lifecycle
  createDocumentStore,
  createDocumentStoreWithEvents,
  isDocumentStore,

  // Reducer + line index strategies
  documentReducer,
  eagerLineIndex,
  lazyLineIndex,

  // Actions
  DocumentActions,
  serializeAction,
  deserializeAction,

  // State factories
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

  // State builders
  withState,
  withPieceNode,
  withLineIndexNode,

  // Piece table mutations
  pieceTableInsert,
  pieceTableDelete,

  // Line index mutations
  lineIndexInsert,
  lineIndexDelete,
  lineIndexInsertLazy,
  lineIndexDeleteLazy,

  // Reconciliation
  reconcileRange,
  reconcileFull,
  reconcileViewport,

  // Offset conversion
  charToByteOffset,
  byteToCharOffset,

  // Buffer access
  getPieceBufferRef,
  getBuffer,
  getBufferSlice,
  getPieceBuffer,

  // Type guards
  isTextEditAction,
  isHistoryAction,
  isTransactionAction,
  isDocumentAction,
  validateAction,
} as const;
