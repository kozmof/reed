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
  MAX_OBSERVER_DELIVERED_ACTIONS_CEILING,
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
  // Each dispatch outside a transaction, and each outermost transaction
  // commit, reserves its place in this queue before it commits, so the events
  // of an action dispatched from inside another queue behind it, and only the
  // outermost call delivers. A dispatch inside a transaction buffers its
  // events in the open level instead, so it reserves no slot.
  //
  // `depth` counts how many event deliveries led to the dispatch: 0 for one
  // made outside delivery, n + 1 for one an event handler made while slot n's
  // events were delivered. Each slot is queued behind every slot of a smaller
  // depth, so the queue runs level by level. Two limits bound a run of
  // handler dispatches. The depth limit stops a chain of handlers each
  // dispatching from the previous one's events. The total limit stops a
  // handler that dispatches more than one action per event, which grows the
  // work exponentially well before the depth limit.
  //
  // The total limit counts only slots of depth 2 and more: actions dispatched
  // in reaction to the events of actions a handler dispatched. A handler that
  // dispatches many actions in one go, such as applying a remote change set
  // one operation at a time, fills depth 1, or depth 0 from a store listener,
  // and is no cycle. Handlers that react once to each of those actions are no
  // cycle either, so the limit grows with that direct work: it is
  // MAX_OBSERVER_DELIVERED_ACTIONS plus MAX_OBSERVER_REENTRANT_STEPS for each
  // slot of depth 0 or 1 delivered, up to MAX_OBSERVER_DELIVERED_ACTIONS_CEILING,
  // so the work a run of handlers can do stays bounded. A chain of handlers each reacting once per
  // event then meets the depth limit first, and a handler that dispatches two
  // or more actions per event meets this one a few levels past depth 2. The
  // queue runs level by level, so every slot of depth 0 or 1 is delivered
  // before the first slot of depth 2. Both counts take only slots delivered:
  // an empty slot, left by an action that changed nothing, starts no handler,
  // and a slot past the depth limit is skipped. Slots past either limit still
  // committed; only their events are dropped.
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
    // Delivered slots of depth 0 or 1, and of depth 2 and more (see the
    // queue's comment).
    let direct = 0;
    let reactions = 0;
    try {
      for (let i = 0; i < deliveryQueue.length; i++) {
        const slot = deliveryQueue[i]!;
        if (slot.events.length === 0) continue;
        if (slot.depth >= MAX_OBSERVER_REENTRANT_STEPS) {
          if (!tooDeep) {
            tooDeep = true;
            reportCycle(`dispatched actions more than ${MAX_OBSERVER_REENTRANT_STEPS} levels deep`);
          }
          continue;
        }
        if (slot.depth < 2) {
          direct++;
        } else {
          const limit = Math.min(
            MAX_OBSERVER_DELIVERED_ACTIONS + MAX_OBSERVER_REENTRANT_STEPS * direct,
            MAX_OBSERVER_DELIVERED_ACTIONS_CEILING,
          );
          if (reactions >= limit) {
            reportCycle(
              `dispatched more than ${limit} actions in reaction to actions handlers dispatched, in one synchronous delivery`,
            );
            break;
          }
          reactions++;
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

    // History events. UNDO and REDO that apply an entry change history; an
    // action that discards entries without undoing or redoing them drops it
    // (see `DocumentTransition`): an eviction, an UNDO or REDO that meets an
    // entry that no longer replays, APPLY_REMOTE, and HISTORY_CLEAR. The piece
    // table cannot tell a dropped entry apart from replaying one that changes
    // no bytes, so the reducer's transition says which it was.
    if (historyDropped !== null) {
      prepare("history-drop", createHistoryDropEvent(prevState, nextState, historyDropped));
    } else if (action.type === "UNDO" || action.type === "REDO") {
      prepare(
        "history-change",
        createHistoryChangeEvent(action.type === "UNDO" ? "undo" : "redo", prevState, nextState),
      );
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
    const prevState = baseStore.getSnapshot();
    if (disposed) return prevState;
    // Inside a transaction the events join the open level, which the
    // outermost commit's slot delivers. Choose before committing: outside a
    // transaction the commit notifies store listeners, and one that opens a
    // transaction must not pull this action's events into its level. Inside
    // one the commit notifies no one, so the level stays open until it returns.
    const target = pendingEventLevels[pendingEventLevels.length - 1] ?? reserveSlot().events;
    try {
      committing++;
      let transition: DocumentTransition;
      try {
        transition = commit(action);
      } finally {
        committing--;
      }

      if (transition.state !== prevState) {
        try {
          target.push(...prepareEventsForAction(action, prevState, transition));
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

  const store: DocumentStoreWithEvents = {
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
    isInTransaction: baseStore.isInTransaction,
    emergencyReset,

    // Event emitter methods
    addEventListener,
    removeEventListener,
    events: emitter,
  };
  return store;
}
