/**
 * Store namespace — store lifecycle, actions, type guards, and explicitly unsafe low-level helpers.
 */

import type { DocumentState } from "../types/state.js";
import type { DocumentAction } from "../types/actions.js";
import type { DocumentStore } from "../types/store.js";
import {
  createDocumentStore,
  createDocumentStoreWithEvents,
  createDocumentStoreFromCheckpoint,
  createDocumentStoreWithEventsFromCheckpoint,
  isDocumentStore,
  withTransaction,
} from "../store/features/store.js";
import { DocumentActions, serializeAction, deserializeAction } from "../store/features/actions.js";
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
} from "../store/core/state.js";
import { documentReducer } from "../store/features/reducer.js";
import {
  pieceTableInsert,
  pieceTableDelete,
  charToByteOffset,
  byteToCharOffset,
  getPieceBufferRef,
  getBuffer,
  getBufferSlice,
  getPieceBuffer,
} from "../store/core/piece-table.js";
import {
  lineIndexInsert,
  lineIndexDelete,
  lineIndexInsertLazy,
  lineIndexDeleteLazy,
  reconcileRange,
  reconcileFull,
  reconcileViewport,
} from "../store/core/line-index.js";
import {
  isTextEditAction,
  isHistoryAction,
  isDocumentAction,
  validateAction,
} from "../types/actions.js";
import {
  computeSetValueActionsFromState,
  computeSetValueActionsFromStateWithDiff,
  type SetValueOptions,
} from "../store/features/diff.js";

export const store = Object.freeze({
  // Store lifecycle
  createDocumentStore,
  createDocumentStoreWithEvents,
  createDocumentStoreFromCheckpoint,
  createDocumentStoreWithEventsFromCheckpoint,
  isDocumentStore,
  withTransaction,

  // Actions
  DocumentActions,
  serializeAction,
  deserializeAction,

  // Safe boundaries and live-store helpers
  dispatchValidated,
  setValue: setStoreValue,

  // Type guards
  isTextEditAction,
  isHistoryAction,
  isDocumentAction,
  validateAction,

  // Eviction helpers
  didEvict,

  /**
   * Low-level primitives that can bypass store invariants when composed incorrectly.
   * Prefer the store lifecycle, action creators, query, scan, rendering, history,
   * and diff namespaces for application code.
   */
  unsafe: Object.freeze({
    // Reducer
    documentReducer,

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

    // Reconciliation primitives
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
  }),
} as const);

/**
 * Validate unknown JSON, plugin, worker, or network input before dispatch.
 * Direct `dispatch` remains the zero-overhead trusted TypeScript boundary.
 */
function dispatchValidated(documentStore: DocumentStore, value: unknown): DocumentState {
  const validation = validateAction(value, documentStore.getSnapshot().pieceTable.totalLength);
  if (!validation.valid) {
    throw new TypeError(`Invalid document action: ${validation.errors.join("; ")}`);
  }
  return documentStore.dispatch(value as DocumentAction);
}

/**
 * Replace a live store value while preserving notifications, events, and rollback semantics.
 */
function setStoreValue(
  documentStore: DocumentStore,
  newContent: string,
  options?: SetValueOptions,
): DocumentState {
  if (typeof newContent !== "string") {
    throw new TypeError("store.setValue: newContent must be a string");
  }
  const pieceTable = documentStore.getSnapshot().pieceTable;
  const actions =
    options?.strategy === "diff"
      ? computeSetValueActionsFromStateWithDiff(pieceTable, newContent)
      : computeSetValueActionsFromState(pieceTable, newContent);
  return documentStore.batch(actions);
}

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
