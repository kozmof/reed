/**
 * Store namespace — store lifecycle, state factories, mutations, reducer, actions, and type guards.
 */

import type { DocumentState } from "../types/state.ts";
import {
  createDocumentStore,
  createDocumentStoreWithEvents,
  isDocumentStore,
  withTransaction,
} from "../store/features/store.ts";
import { DocumentActions, serializeAction, deserializeAction } from "../store/features/actions.ts";
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
} from "../store/core/state.ts";
import { documentReducer } from "../store/features/reducer.ts";
import {
  pieceTableInsert,
  pieceTableDelete,
  charToByteOffset,
  byteToCharOffset,
  getPieceBufferRef,
  getBuffer,
  getBufferSlice,
  getPieceBuffer,
} from "../store/core/piece-table.ts";
import {
  lineIndexInsert,
  lineIndexDelete,
  lineIndexInsertLazy,
  lineIndexDeleteLazy,
  reconcileRange,
  reconcileFull,
  reconcileViewport,
} from "../store/core/line-index.ts";
import {
  isTextEditAction,
  isHistoryAction,
  isDocumentAction,
  validateAction,
} from "../types/actions.ts";

export const store = {
  // Store lifecycle
  createDocumentStore,
  createDocumentStoreWithEvents,
  isDocumentStore,
  withTransaction,

  // Reducer
  documentReducer,

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

  // Reconciliation — prefer reconcileNow() / setViewport() over reconcileRange() directly.
  // reconcileRange is a low-level primitive that requires callers to understand dirty-range
  // semantics (version parameter, line bounds). See its JSDoc for details.
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
  isDocumentAction,
  validateAction,

  // Eviction helpers
  didEvict,
} as const;

/**
 * Returns true if dispatching EVICT_CHUNK for `chunkIndex` successfully removed
 * the chunk from memory — i.e. it is present in `prevState.pieceTable.chunkMap`
 * and absent from `nextState.pieceTable.chunkMap`.
 *
 * Returns false when eviction was silently refused (e.g. user edits overlap the
 * chunk's byte range). Use this instead of comparing `chunkMap.size` so that the
 * check is tied to the specific chunk rather than any incidental size change.
 *
 * @example
 * ```ts
 * const prev = store.getSnapshot();
 * store.dispatch(DocumentActions.evictChunk(chunkIndex));
 * const next = store.getSnapshot();
 * if (!store.didEvict(prev, next, chunkIndex)) {
 *   // chunk has overlapping edits — cannot evict right now
 * }
 * ```
 */
function didEvict(prevState: DocumentState, nextState: DocumentState, chunkIndex: number): boolean {
  return (
    prevState.pieceTable.chunkMap.has(chunkIndex) && !nextState.pieceTable.chunkMap.has(chunkIndex)
  );
}
