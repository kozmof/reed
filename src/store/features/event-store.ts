/** Typed event-emitting wrapper for a document store. */
import type { DocumentState, DocumentStoreRuntimeConfig } from "../../types/state.js";
import type { DocumentAction } from "../../types/actions.js";
import { isTextEditAction } from "../../types/actions.js";
import type {
  ReconcilableDocumentStore,
  DocumentStoreWithEvents,
  Unsubscribe,
} from "../../types/store.js";
import { makeBatch } from "./transaction.js";
import {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createAttentionChangeEvent,
  createDirtyChangeEvent,
  diffChangedAttentionIds,
  getAffectedRanges,
  type EventHandler,
  type DocumentEventMap,
} from "./events.js";
import { reportCaughtError } from "./diagnostics.js";

/**
 * Wrap a store in the typed event layer. Shared by the config-built and
 * checkpoint-built entry points.
 */
export function withEvents(
  baseStore: ReconcilableDocumentStore,
  logger: DocumentStoreRuntimeConfig["logger"],
): DocumentStoreWithEvents {
  const emitter = createEventEmitter(logger);
  let disposed = false;

  // Depth-indexed event buffer. Each entry corresponds to one open transaction level.
  // Index 0 = outermost open transaction, last = innermost.
  const pendingEventLevels: Array<Array<() => void>> = [];

  /**
   * Emit or buffer an event emit function depending on whether a transaction is active.
   */
  function bufferOrEmit(fn: () => void): void {
    if (disposed) return;
    if (pendingEventLevels.length > 0) {
      pendingEventLevels[pendingEventLevels.length - 1]!.push(fn);
    } else {
      fn();
    }
  }

  /**
   * Prepare appropriate events based on action type and state changes.
   *
   * Event payloads are derived immediately after dispatch rather than while a
   * transaction is being committed. The buffered functions only emit already
   * constructed events, so event derivation cannot turn a successful commit
   * into an apparent failure.
   */
  function prepareEventsForAction(
    action: DocumentAction,
    prevState: DocumentState,
    nextState: DocumentState,
  ): Array<() => void> {
    if (disposed) return [];
    const events: Array<() => void> = [];

    function prepare<K extends keyof DocumentEventMap>(type: K, event: DocumentEventMap[K]): void {
      events.push(() => {
        if (!disposed) emitter.emit(type, event);
      });
    }

    // Content change events for local text edits and remote content updates
    if (isTextEditAction(action) || action.type === "APPLY_REMOTE") {
      prepare(
        "content-change",
        createContentChangeEvent(
          action,
          prevState,
          nextState,
          getAffectedRanges(action, prevState, nextState),
        ),
      );
    }

    // Selection change events
    if (action.type === "SET_SELECTION") {
      prepare("selection-change", createSelectionChangeEvent(prevState, nextState));
    }

    // History change events
    if (action.type === "UNDO" || action.type === "REDO") {
      prepare(
        "history-change",
        createHistoryChangeEvent(action.type === "UNDO" ? "undo" : "redo", prevState, nextState),
      );
    }

    // Attention change events: fire whenever the layer reference changed, whether
    // from CREATE_ATTENTION / DELETE_ATTENTION or from a content edit re-anchoring
    // points. Compared by reference (copy-on-write) so unchanged edits cost nothing.
    if (prevState.attention !== nextState.attention) {
      prepare(
        "attention-change",
        createAttentionChangeEvent(
          prevState,
          nextState,
          diffChangedAttentionIds(prevState, nextState),
        ),
      );
    }

    // Dirty state change events
    if (prevState.metadata.isDirty !== nextState.metadata.isDirty) {
      prepare("dirty-change", createDirtyChangeEvent(nextState.metadata.isDirty, nextState));
    }

    return events;
  }

  /**
   * Enhanced dispatch that buffers or emits events depending on transaction state.
   */
  function dispatch(action: DocumentAction): DocumentState {
    if (disposed) return baseStore.getSnapshot();
    const prevState = baseStore.getSnapshot();
    const nextState = baseStore.dispatch(action);

    if (nextState !== prevState) {
      try {
        for (const emit of prepareEventsForAction(action, prevState, nextState)) {
          bufferOrEmit(emit);
        }
      } catch (error) {
        // The state transition has already committed. Event metadata is
        // observational and must not make callers believe the edit failed.
        reportCaughtError(logger, "Event preparation threw an error", error);
      }
    }

    return nextState;
  }

  /**
   * Begin a transaction, pushing a new event buffer level.
   */
  function beginTransaction(): void {
    if (disposed) return;
    baseStore.beginTransaction();
    pendingEventLevels.push([]);
  }

  /**
   * Commit the current transaction level.
   * On outermost commit, flushes buffered events after the base store commits.
   * On inner commit, merges buffered events into the parent level.
   * With no active transaction, this is a no-op to match base store semantics.
   * On throw (from base store), clears all pending event levels.
   */
  function commitTransaction(): void {
    if (disposed) return;
    if (pendingEventLevels.length === 0) {
      baseStore.commitTransaction();
      return;
    }

    const isOutermost = pendingEventLevels.length === 1;
    const events = pendingEventLevels[pendingEventLevels.length - 1]!;
    try {
      baseStore.commitTransaction();
      pendingEventLevels.pop();
      if (isOutermost) {
        for (const fn of events) fn();
      } else {
        pendingEventLevels[pendingEventLevels.length - 1]!.push(...events);
      }
    } catch (e) {
      // baseStore already called emergencyReset internally; clear our buffer to match.
      pendingEventLevels.length = 0;
      throw e;
    }
  }

  /**
   * Rollback the current transaction level.
   * Discards the current depth's buffered events before delegating to the base store.
   */
  function rollbackTransaction(): void {
    if (disposed) return;
    if (pendingEventLevels.length === 0) {
      throw new Error("Cannot rollback: no active transaction");
    }

    pendingEventLevels.pop();
    baseStore.rollbackTransaction();
  }

  /**
   * Emergency reset: clears all pending event levels in addition to base store reset.
   */
  function emergencyReset(): DocumentState | null {
    if (disposed) return null;
    pendingEventLevels.length = 0;
    return baseStore.emergencyReset();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    pendingEventLevels.length = 0;
    emitter.removeAllListeners();
    baseStore.dispose();
  }

  function addEventListener<K extends keyof DocumentEventMap>(
    type: K,
    handler: EventHandler<DocumentEventMap[K]>,
  ): Unsubscribe {
    if (disposed) return () => {};
    return emitter.addEventListener(type, handler);
  }

  function removeEventListener<K extends keyof DocumentEventMap>(
    type: K,
    handler: EventHandler<DocumentEventMap[K]>,
  ): void {
    emitter.removeEventListener(type, handler);
  }

  /**
   * Enhanced batch that emits events after all actions complete.
   * Uses the enhanced dispatch (which captures before/after for events)
   * within a transaction, eliminating the need to replay the reducer.
   */
  const batch = makeBatch(
    { beginTransaction, commitTransaction, rollbackTransaction, emergencyReset },
    dispatch,
    baseStore.getSnapshot,
  );

  return {
    // Pass through base store methods
    subscribe: baseStore.subscribe,
    getSnapshot: baseStore.getSnapshot,
    getServerSnapshot: baseStore.getServerSnapshot,
    isCurrentSnapshot: baseStore.isCurrentSnapshot,
    getEagerSnapshot: baseStore.getEagerSnapshot,
    scheduleReconciliation: baseStore.scheduleReconciliation,
    reconcileNow: baseStore.reconcileNow,
    reconcileIfCurrent: baseStore.reconcileIfCurrent,
    setViewport: baseStore.setViewport,
    whenReconciled: baseStore.whenReconciled,
    dispose,

    // Enhanced methods with event emission and buffer management
    dispatch,
    batch,
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
    emergencyReset,

    // Event emitter methods
    addEventListener,
    removeEventListener,
    events: emitter,
  };
}
