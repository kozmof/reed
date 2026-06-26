/**
 * Document store implementation for the Reed document editor.
 * Factory function that creates a DocumentStore with encapsulated state.
 */

import type { DocumentState, DocumentStoreConfig } from "../../types/state.js";
import type { DocumentAction } from "../../types/actions.js";
import type {
  DocumentStore,
  ReconcilableDocumentStore,
  DocumentStoreWithEvents,
  StoreListener,
  Unsubscribe,
} from "../../types/store.js";
import { createInitialState, withState } from "../core/state.js";
import { documentReducer } from "./reducer.js";
import { reconcileFull, reconcileViewport } from "../core/line-index.js";
import { getBufferStats, compactAddBuffer } from "../core/piece-table.js";
import { createTransactionManager, makeBatch } from "./transaction.js";
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
import { isTextEditAction } from "../../types/actions.js";
import { createReconciliationScheduler } from "./reconciliation-scheduler.js";

// Automatically compact the add buffer when more than this fraction of allocated bytes
// are unreferenced waste AND the buffer exceeds AUTO_COMPACT_MIN_BYTES.
// Checked after each mutation in the idle callback, alongside reconciliation.
const AUTO_COMPACT_WASTE_RATIO = 0.5;
const AUTO_COMPACT_MIN_BYTES = 16384; // 16 KB

/**
 * Factory function to create a DocumentStore.
 * Encapsulates internal mutable state (listeners, transaction depth).
 *
 * Note: We use a factory function rather than exporting a class directly.
 * This provides encapsulation while maintaining the pure functions + store pattern.
 *
 * @param config - Optional configuration for the store
 * @returns A new DocumentStore instance
 */
export function createDocumentStore(config: DocumentStoreConfig = {}): ReconcilableDocumentStore {
  // Internal mutable state
  let state = createInitialState(config);
  const whenReconciledWaiters: Array<{
    resolve(state: DocumentState<"eager">): void;
    reject(error: Error): void;
  }> = [];
  const reconcileMode = config.reconcileMode ?? "idle";
  const logger = config.logger;
  let disposed = false;
  // Listeners array with on-demand COW: mutations during an active notification clone
  // the array so the in-progress for-of iteration is not disturbed. Outside notification
  // (the common case) push/splice mutate in place — O(1) add, O(n) remove (n ≈ 2–3).
  let listeners: StoreListener[] = [];
  let notifying = false; // Re-entrancy guard for notifyListeners (see 6.4)
  const transaction = createTransactionManager();

  /**
   * Replace internal state reference only when it changes.
   */
  function setState(nextState: DocumentState): void {
    if (nextState !== state) {
      state = nextState;
    }
    resolveWhenReconciledIfReady();
  }

  function resolveWhenReconciledIfReady(): void {
    if (state.lineIndex.rebuildPending || whenReconciledWaiters.length === 0) return;

    const eagerState = state as DocumentState<"eager">;
    const waiters = whenReconciledWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve(eagerState);
    }
  }

  function rejectWhenReconciledWaiters(error: Error): void {
    if (whenReconciledWaiters.length === 0) return;
    const waiters = whenReconciledWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  function needsCompaction(): boolean {
    const stats = getBufferStats(state.pieceTable);
    return (
      stats.wasteRatio > AUTO_COMPACT_WASTE_RATIO && stats.addBufferSize > AUTO_COMPACT_MIN_BYTES
    );
  }

  function applyCompactionIfNeeded(): void {
    if (!needsCompaction()) return;
    const newPieceTable = compactAddBuffer(state.pieceTable, AUTO_COMPACT_WASTE_RATIO);
    if (newPieceTable !== state.pieceTable) {
      setState(withState(state, { pieceTable: newPieceTable }));
      notifyListeners();
    }
  }

  const scheduler =
    config.scheduler ??
    createReconciliationScheduler(reconcileMode, {
      hasPendingWork: () => state.lineIndex.rebuildPending || needsCompaction(),
      shouldDefer: () => transaction.isActive,
      performWork() {
        if (state.lineIndex.rebuildPending) {
          const newLineIndex = reconcileFull(state.lineIndex, state.version);
          if (newLineIndex !== state.lineIndex) {
            setState(withState(state, { lineIndex: newLineIndex }));
            notifyListeners();
          }
        }
        applyCompactionIfNeeded();
      },
    });

  /**
   * Notify all listeners of state change.
   * Only called when not in a transaction.
   *
   * Re-entrancy guard: if a listener triggers `emergencyReset` (which itself
   * calls `notifyListeners`), the inner call is a no-op, preventing recursive
   * notification.
   *
   * The listeners array uses copy-on-write semantics: subscribe/unsubscribe
   * clone the array before mutating when `notifying` is true, so the
   * iteration here never sees mid-notify additions or removals.
   */
  function notifyListeners(): void {
    if (notifying) return;
    notifying = true;
    try {
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          // Don't let one listener's error affect others
          logger?.error?.("Store listener threw an error:", error);
        }
      }
    } finally {
      notifying = false;
    }
  }

  /**
   * Subscribe to state changes.
   * @param listener - Function to call when state changes
   * @returns Unsubscribe function
   */
  function subscribe(listener: StoreListener): Unsubscribe {
    if (disposed) return () => {};
    // Clone only if a notification is in progress so the for-of iteration keeps
    // its snapshot; otherwise mutate in place (O(1)).
    if (notifying) {
      listeners = [...listeners, listener];
    } else {
      listeners.push(listener);
    }
    return () => {
      if (notifying) {
        listeners = listeners.filter((l) => l !== listener);
      } else {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
      }
    };
  }

  /**
   * Get current immutable state snapshot.
   * Must return the same reference if state hasn't changed.
   */
  function getSnapshot(): DocumentState {
    return state;
  }

  /**
   * Get server-side snapshot (for SSR/hydration).
   */
  function getServerSnapshot(): DocumentState {
    return state;
  }

  /**
   * Check whether a previously captured snapshot is still current.
   */
  function isCurrentSnapshot(snapshot: DocumentState): boolean {
    return snapshot === state;
  }

  /**
   * Dispatch a document action to modify state.
   * @param action - Action to dispatch
   * @returns New state after applying the action
   *
   * **Notification contract:** listeners are notified synchronously on every
   * non-transaction dispatch. During an active transaction notifications are
   * suppressed and delivered as a single call on outermost commit or outermost rollback.
   */
  function dispatch(action: DocumentAction): DocumentState {
    if (disposed) return state;
    const newState = documentReducer(state, action);
    if (newState !== state) {
      setState(newState);
      if (!transaction.isActive) {
        notifyListeners();
        if (state.lineIndex.rebuildPending || needsCompaction()) {
          scheduleReconciliation();
        }
      }
    }
    return state;
  }

  /**
   * Begin a transaction (or nest within an existing one).
   * On invariant violation the store calls emergencyReset before rethrowing.
   */
  function beginTransaction(): void {
    if (disposed) return;
    try {
      transaction.begin(state);
    } catch (e) {
      emergencyReset();
      throw e;
    }
  }

  /**
   * Commit the current transaction level.
   * Notifies listeners and schedules reconciliation when the outermost transaction completes.
   * On throw (invariant violation) the store calls emergencyReset before rethrowing.
   * The caller must NOT attempt rollback after a commitTransaction throw.
   */
  function commitTransaction(): void {
    if (disposed) return;
    try {
      const result = transaction.commit();
      if (result.isOutermost) {
        notifyListeners();
        if (state.lineIndex.rebuildPending || needsCompaction()) {
          scheduleReconciliation();
        }
      }
    } catch (e) {
      emergencyReset();
      throw e;
    }
  }

  /**
   * Rollback the current transaction level, restoring the pre-transaction snapshot.
   * Notifies listeners when the outermost rollback completes.
   * @throws if called with no active transaction (depth is 0).
   */
  function rollbackTransaction(): void {
    if (disposed) return;
    const result = transaction.rollback();
    if (result.snapshot) {
      setState(result.snapshot);
    }
    if (result.isOutermost) {
      notifyListeners();
    }
  }

  /**
   * Batch multiple actions into a single state update.
   * Listeners are notified only once after all actions complete.
   * Actions keep their normal history behavior (one entry per action unless coalesced).
   *
   * @param actions - Array of actions to apply
   * @returns New state after applying all actions
   */
  const batch = makeBatch(
    { beginTransaction, commitTransaction, rollbackTransaction, emergencyReset },
    dispatch,
    () => state,
  );

  /**
   * Emergency reset when a rollback dispatch itself throws.
   * Clears all transaction state, restores the earliest snapshot, and notifies listeners.
   */
  function emergencyReset(): DocumentState | null {
    if (disposed) return null;
    const earliest = transaction.emergencyReset();
    if (earliest) {
      setState(earliest);
    }
    notifyListeners();
    return earliest ?? null;
  }

  function scheduleReconciliation(): void {
    if (disposed) return;
    scheduler.schedule();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    scheduler.cancel();
    listeners = [];
    rejectWhenReconciledWaiters(
      new Error("DocumentStore was disposed before reconciliation completed"),
    );
  }

  /**
   * Shared core: apply reconcileFull in-place and return eager state.
   * Does NOT bump version — offset resolution is content-neutral.
   */
  function reconcileInPlace(): DocumentState<"eager"> {
    if (!state.lineIndex.rebuildPending) return state as DocumentState<"eager">;
    const newLineIndex = reconcileFull(state.lineIndex, state.version);
    if (newLineIndex !== state.lineIndex) {
      setState(withState(state, { lineIndex: newLineIndex }));
    }
    resolveWhenReconciledIfReady();
    return state as DocumentState<"eager">;
  }

  /**
   * Get the current state with all dirty line-index ranges resolved.
   * Reconciles in-place without bumping the version number (offset resolution
   * does not change visible content, so no version increment is warranted).
   */
  function getEagerSnapshot(): DocumentState<"eager"> {
    return reconcileInPlace();
  }

  /**
   * Force immediate reconciliation (blocking).
   * Use sparingly - prefer scheduleReconciliation().
   *
   * Does NOT bump `state.version`. Offset resolution is content-neutral:
   * the document text is unchanged, so no version increment is warranted.
   * Callers that need to detect whether lines are ready should inspect
   * `lineIndex.rebuildPending`, not compare version numbers.
   */
  function reconcileNow(): DocumentState<"eager"> {
    scheduler.cancel();
    return reconcileInPlace();
  }

  /**
   * Snapshot-gated synchronous reconciliation.
   * Returns null when `snapshot` is stale (a newer dispatch has occurred),
   * preventing a reconciled state from being applied to an out-of-date view.
   */
  function reconcileIfCurrent(snapshot: DocumentState): DocumentState<"eager"> | null {
    if (!isCurrentSnapshot(snapshot)) return null;
    return reconcileNow();
  }

  /**
   * Return a Promise that resolves once the line index is fully reconciled.
   * Resolves immediately when rebuildPending is already false; otherwise waits
   * for the next store notification after which the index is clean.
   * In reconcileMode 'none', this performs an immediate synchronous reconcile
   * because there is no background scheduler to make forward progress.
   */
  function whenReconciled(): Promise<DocumentState<"eager">> {
    if (disposed) {
      return Promise.reject(new Error("DocumentStore has been disposed"));
    }
    if (!state.lineIndex.rebuildPending) {
      return Promise.resolve(state as DocumentState<"eager">);
    }
    if (config.scheduler === undefined && reconcileMode === "none") {
      return Promise.resolve(reconcileNow());
    }
    return new Promise<DocumentState<"eager">>((resolve, reject) => {
      whenReconciledWaiters.push({ resolve, reject });
      // Register the waiter before scheduling: a custom scheduler is allowed to
      // reconcile synchronously from schedule(), in which case setState() must
      // be able to observe and resolve this waiter during the same call stack.
      scheduleReconciliation();
    });
  }

  /**
   * Set viewport bounds and ensure those lines are accurate.
   */
  function setViewport(startLine: number, endLine: number): void {
    if (disposed) return;
    const newLineIndex = reconcileViewport(state.lineIndex, startLine, endLine, state.version);
    if (newLineIndex !== state.lineIndex) {
      setState(withState(state, { lineIndex: newLineIndex }));
      if (!transaction.isActive) {
        notifyListeners();
      }
    }

    // Schedule background reconciliation for remaining dirty ranges
    scheduleReconciliation();
  }

  // Return the store interface
  return {
    subscribe,
    getSnapshot,
    getServerSnapshot,
    isCurrentSnapshot,
    dispatch,
    batch,
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
    getEagerSnapshot,
    scheduleReconciliation,
    reconcileNow,
    reconcileIfCurrent,
    setViewport,
    emergencyReset,
    whenReconciled,
    dispose,
  };
}

/**
 * Create a DocumentStore with integrated event emission.
 * Wraps a base store to automatically emit typed events on dispatch.
 *
 * Events are emitted after state changes:
 * - 'content-change': On INSERT, DELETE, REPLACE, APPLY_REMOTE
 * - 'selection-change': On SET_SELECTION
 * - 'history-change': On UNDO, REDO
 * - 'dirty-change': When isDirty state changes
 *
 * Event buffering during transactions: events emitted while a transaction is active
 * are buffered per nesting depth. On outermost commit they are flushed in order.
 * On any rollback the current depth's buffered events are discarded, preserving
 * events from enclosing transaction depths.
 *
 * @example
 * ```typescript
 * const store = createDocumentStoreWithEvents({ content: 'Hello' });
 *
 * store.addEventListener('content-change', (event) => {
 *   console.log('Content changed:', event.affectedRanges);
 * });
 *
 * store.dispatch({ type: 'INSERT', start: byteOffset(5), text: ' World' });
 * // Event fires with affectedRanges: [5, 11]
 * ```
 *
 * @param config - Optional configuration for the store
 * @returns A DocumentStoreWithEvents instance
 */
export function createDocumentStoreWithEvents(
  config: DocumentStoreConfig = {},
): DocumentStoreWithEvents {
  const baseStore = createDocumentStore(config);
  const emitter = createEventEmitter(config.logger);
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
   * Emit appropriate events based on action type and state changes.
   */
  function emitEventsForAction(
    action: DocumentAction,
    prevState: DocumentState,
    nextState: DocumentState,
  ): void {
    if (disposed) return;

    // Content change events for local text edits and remote content updates
    if (isTextEditAction(action) || action.type === "APPLY_REMOTE") {
      emitter.emit(
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
      emitter.emit("selection-change", createSelectionChangeEvent(prevState, nextState));
    }

    // History change events
    if (action.type === "UNDO" || action.type === "REDO") {
      emitter.emit(
        "history-change",
        createHistoryChangeEvent(action.type === "UNDO" ? "undo" : "redo", prevState, nextState),
      );
    }

    // Attention change events: fire whenever the layer reference changed, whether
    // from CREATE_ATTENTION / DELETE_ATTENTION or from a content edit re-anchoring
    // points. Compared by reference (copy-on-write) so unchanged edits cost nothing.
    if (prevState.attention !== nextState.attention) {
      emitter.emit(
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
      emitter.emit("dirty-change", createDirtyChangeEvent(nextState.metadata.isDirty, nextState));
    }
  }

  /**
   * Enhanced dispatch that buffers or emits events depending on transaction state.
   */
  function dispatch(action: DocumentAction): DocumentState {
    if (disposed) return baseStore.getSnapshot();
    const prevState = baseStore.getSnapshot();
    const nextState = baseStore.dispatch(action);

    if (nextState !== prevState) {
      const prev = prevState;
      const next = nextState;
      bufferOrEmit(() => emitEventsForAction(action, prev, next));
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

/**
 * Execute a callback within a transaction boundary on the given store.
 *
 * Provides the same error-handling resilience as `batch`: the callback runs
 * inside a beginTransaction / commitTransaction bracket. On any exception from
 * the callback a rollback is attempted, falling back to `emergencyReset` if
 * rollback itself throws.
 *
 * If commitTransaction throws (invariant violation), the store has already called
 * emergencyReset internally — no additional rollback is attempted.
 *
 * Nests correctly: if the store is already in a transaction, this starts an
 * inner transaction and only the outermost completion notifies listeners.
 *
 * @param store - The store to transact against
 * @param fn - Callback that performs work using the store; its return value is forwarded
 * @returns The value returned by `fn`
 *
 * @example
 * ```ts
 * const newState = withTransaction(store, (s) => {
 *   s.dispatch(DocumentActions.insert(byteOffset(0), 'Hello'));
 *   s.dispatch(DocumentActions.insert(byteOffset(5), ' World'));
 *   return s.getSnapshot();
 * });
 * ```
 */
export function withTransaction<T>(
  store: ReconcilableDocumentStore,
  fn: (store: ReconcilableDocumentStore) => T,
): T {
  store.beginTransaction();
  let result: T;
  try {
    result = fn(store);
  } catch (e) {
    try {
      store.rollbackTransaction();
    } catch {
      store.emergencyReset();
    }
    throw e;
  }
  // fn succeeded — commit (handles its own failure internally via emergencyReset)
  store.commitTransaction();
  return result;
}

/**
 * Check if a value is a DocumentStore.
 * Useful for type narrowing.
 */
export function isDocumentStore(value: unknown): value is DocumentStore {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const store = value as Partial<DocumentStore>;
  return (
    typeof store.subscribe === "function" &&
    typeof store.getSnapshot === "function" &&
    typeof store.isCurrentSnapshot === "function" &&
    typeof store.dispatch === "function" &&
    typeof store.batch === "function"
  );
}
