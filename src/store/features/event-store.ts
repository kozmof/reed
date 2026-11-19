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
  createHistoryDropEvent,
  createAttentionChangeEvent,
  createDirtyChangeEvent,
  createSaveEvent,
  diffChangedAttentionIds,
  getAffectedRanges,
  type EventHandler,
  type DocumentEventMap,
} from "./events.js";
import {
  MAX_OBSERVER_DELIVERED_ACTIONS,
  MAX_OBSERVER_REENTRANT_STEPS,
  reportCaughtError,
} from "./diagnostics.js";
import type { DocumentTransition } from "./reducer.js";

/**
 * Wrap a store in the typed event layer. Shared by the config-built and
 * checkpoint-built entry points.
 *
 * `commit` applies an action to `baseStore` and returns the reducer's
 * transition for it. A store listener can dispatch again while the action
 * notifies it, so `baseStore.getSnapshot()` afterwards can already include
 * that listener's actions; the events describe the reducer's state instead.
 *
 * `baseStore` and `commit` throw only when the change did not take effect:
 * the base store reports errors that come after a commit rather than
 * throwing them, so a throw here means the buffered events are discarded.
 */
export function withEvents(
  baseStore: ReconcilableDocumentStore,
  commit: (action: DocumentAction) => DocumentTransition,
  logger: DocumentStoreRuntimeConfig["logger"],
): DocumentStoreWithEvents {
  const emitter = createEventEmitter(logger);
  let disposed = false;

  // Depth-indexed event buffer. Each entry corresponds to one open transaction level.
  // Index 0 = outermost open transaction, last = innermost.
  const pendingEventLevels: Array<Array<() => void>> = [];

  // Events reach handlers in the order their actions committed. A store
  // listener or an event handler can dispatch while events are delivered.
  // Each dispatch, and each outermost transaction commit, reserves its place
  // in this queue before it commits, so the events of an action dispatched
  // from inside another queue behind it, and only the outermost call delivers.
  //
  // `depth` counts how many event deliveries led to the dispatch: 0 for one
  // made outside delivery, n + 1 for one an event handler made while slot n's
  // events were delivered. Two limits bound a run of handler dispatches. The
  // depth limit stops a chain of handlers each dispatching from the previous
  // one's events, and does not count a handler that dispatches many actions
  // in one go as a cycle. The total limit stops a handler that dispatches
  // more than one action per event, which grows the work exponentially well
  // before the depth limit. Slots past either limit still committed; only
  // their events are dropped.
  interface DeliverySlot {
    readonly depth: number;
    readonly events: Array<() => void>;
  }
  const deliveryQueue: DeliverySlot[] = [];
  let committing = 0;
  let delivering = false;
  let deliveringDepth = 0;

  function reserveSlot(): DeliverySlot {
    const slot: DeliverySlot = { depth: delivering ? deliveringDepth + 1 : 0, events: [] };
    deliveryQueue.push(slot);
    return slot;
  }

  function reportCycle(detail: string): void {
    reportCaughtError(
      logger,
      "Document event cycle exceeded the re-entrancy limit",
      new Error(`Event handlers ${detail}`),
    );
  }

  function deliver(): void {
    if (committing > 0 || delivering) return;
    delivering = true;
    let tooDeep = false;
    try {
      for (let i = 0; i < deliveryQueue.length; i++) {
        if (i >= MAX_OBSERVER_DELIVERED_ACTIONS) {
          reportCycle(
            `dispatched more than ${MAX_OBSERVER_DELIVERED_ACTIONS} actions in one synchronous delivery`,
          );
          break;
        }
        const slot = deliveryQueue[i]!;
        if (slot.depth >= MAX_OBSERVER_REENTRANT_STEPS) {
          if (!tooDeep) {
            tooDeep = true;
            reportCycle(`dispatched actions more than ${MAX_OBSERVER_REENTRANT_STEPS} levels deep`);
          }
          continue;
        }
        deliveringDepth = slot.depth;
        for (const emit of slot.events) emit();
        // Release the delivered events, and the states they captured, while
        // handlers keep queueing behind them.
        slot.events.length = 0;
      }
    } finally {
      deliveryQueue.length = 0;
      delivering = false;
      deliveringDepth = 0;
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
    { state: nextState, historyDropped }: DocumentTransition,
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

    // Selection change events: every action that moves the selection, such as
    // SET_SELECTION, an edit moving it past the edited text, undo and redo
    // restoring it, a chunk load shifting it, or an eviction collapsing it.
    // Selections are immutable and an action that leaves the selection in
    // place keeps the same object (SET_SELECTION with the current ranges
    // included), so the reference check is O(1).
    if (prevState.selection !== nextState.selection) {
      prepare("selection-change", createSelectionChangeEvent(prevState, nextState));
    }

    // History events. EVICT_CHUNK and EVICT_CHUNKS change history only when they discard
    // entries: under "drop", or "pin-bounded" with overLimit or through EVICT_CHUNKS.
    // UNDO and REDO discard entries instead of applying one that no longer
    // replays; the document is then unchanged. The piece table cannot tell
    // that apart from replaying an entry that changes no bytes, so the
    // reducer's transition says which it was.
    if ((action.type === "UNDO" || action.type === "REDO") && !historyDropped) {
      prepare(
        "history-change",
        createHistoryChangeEvent(action.type === "UNDO" ? "undo" : "redo", prevState, nextState),
      );
    } else if (
      (action.type === "EVICT_CHUNK" ||
        action.type === "EVICT_CHUNKS" ||
        action.type === "UNDO" ||
        action.type === "REDO") &&
      prevState.history !== nextState.history
    ) {
      prepare("history-drop", createHistoryDropEvent(prevState, nextState));
    }

    // Emit attention-change when CREATE_ATTENTION, DELETE_ATTENTION, or a
    // content edit changes the attention layer. Structural sharing makes the
    // reference check O(1).
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

    // Emit save only for MARK_SAVED. The event records the caller reporting a
    // successful save. Reed does not write the document itself.
    if (action.type === "MARK_SAVED") {
      prepare("save", createSaveEvent(nextState));
    }

    // Dirty state change events. Ordered after 'save' so a listener reacting to
    // 'dirty-change' already sees the save that caused it.
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
    const slot = reserveSlot();
    try {
      let transition: DocumentTransition;
      committing++;
      try {
        transition = commit(action);
      } finally {
        committing--;
      }

      if (transition.state !== prevState) {
        try {
          const events = prepareEventsForAction(action, prevState, transition);
          const level = pendingEventLevels[pendingEventLevels.length - 1];
          (level ?? slot.events).push(...events);
        } catch (error) {
          // The state transition has already committed. Event metadata is
          // observational and must not make callers believe the edit failed.
          reportCaughtError(logger, "Event preparation threw an error", error);
        }
      }
    } finally {
      deliver();
    }

    return baseStore.getSnapshot();
  }

  /**
   * Run a base store begin or inner commit with the open event levels
   * detached, and put them back when it returns.
   *
   * When such a call throws, the base store has already run emergencyReset,
   * which notifies store listeners before rethrowing. A listener that
   * dispatches then commits for real, outside any transaction, so its events
   * must not join a level the reset discarded. With the levels detached they
   * get their own delivery slot, and the levels stay discarded after the
   * throw, as the reset discarded the transaction. A call that returns
   * notifies no one, so detaching changes nothing then.
   */
  function withLevelsDetached(call: () => void): void {
    const open = pendingEventLevels.splice(0);
    call();
    pendingEventLevels.push(...open);
  }

  /**
   * Begin a transaction, pushing a new event buffer level.
   */
  function beginTransaction(): void {
    if (disposed) return;
    withLevelsDetached(baseStore.beginTransaction);
    pendingEventLevels.push([]);
  }

  /**
   * Commit the current transaction level.
   * On outermost commit, flushes buffered events after the base store commits.
   * On inner commit, merges buffered events into the parent level.
   * With no active transaction, this is a no-op to match base store semantics.
   * On throw (from base store), clears all pending event levels.
   *
   * The level is closed before the base store commits. The outermost commit
   * notifies store listeners synchronously, and a listener can dispatch; its
   * action commits after the transaction, so it gets its own delivery slot
   * behind the transaction's instead of joining the closed level.
   */
  function commitTransaction(): void {
    if (disposed) return;
    if (pendingEventLevels.length === 0) {
      baseStore.commitTransaction();
      return;
    }

    const events = pendingEventLevels.pop()!;
    if (pendingEventLevels.length > 0) {
      withLevelsDetached(baseStore.commitTransaction);
      pendingEventLevels[pendingEventLevels.length - 1]!.push(...events);
      return;
    }

    const slot = reserveSlot();
    try {
      committing++;
      try {
        baseStore.commitTransaction();
      } finally {
        committing--;
      }
      slot.events.push(...events);
    } finally {
      deliver();
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
   * Clear all pending event levels and reset the base store.
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
