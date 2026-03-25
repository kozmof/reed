/**
 * Document store implementation for the Reed document editor.
 * Factory function that creates a DocumentStore with encapsulated state.
 */

import type { DocumentState, DocumentStoreConfig } from '../../types/state.ts';
import type { DocumentAction } from '../../types/actions.ts';
import type { DocumentStore, ReconcilableDocumentStore, DocumentStoreWithEvents, StoreListener, Unsubscribe } from '../../types/store.ts';
import { createInitialState } from '../core/state.ts';
import { documentReducer } from './reducer.ts';
import { reconcileFull, reconcileViewport } from '../core/line-index.ts';
import { createTransactionManager } from './transaction.ts';
import {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createDirtyChangeEvent,
  getAffectedRange,
} from './events.ts';
import { isTextEditAction } from '../../types/actions.ts';

/**
 * Background reconciliation state.
 */
interface ReconciliationState {
  /** ID of pending idle callback (or timeout) */
  idleCallbackId: number | null;
  /** Whether reconciliation is currently running */
  isReconciling: boolean;
}

/**
 * Shared try/finally logic for batch transaction management.
 *
 * `txDispatch` handles TRANSACTION_START / TRANSACTION_COMMIT / TRANSACTION_ROLLBACK
 * (always the base store's dispatch, which owns the transaction stack).
 * `actionDispatch` handles individual user actions (may differ — e.g. an event-emitting
 * wrapper — while still routing transaction control through `txDispatch`).
 */
function withTransactionBatch(
  txDispatch: (action: DocumentAction) => DocumentState,
  actionDispatch: (action: DocumentAction) => DocumentState,
  emergencyReset: () => DocumentState | null,
  actions: readonly DocumentAction[]
): void {
  txDispatch({ type: 'TRANSACTION_START' });
  let success = false;
  try {
    for (const action of actions) {
      actionDispatch(action);
    }
    // Set success before COMMIT: if COMMIT itself throws, the finally block must not
    // attempt ROLLBACK on half-committed state (depth already decremented).
    success = true;
    txDispatch({ type: 'TRANSACTION_COMMIT' });
  } finally {
    if (!success) {
      try {
        txDispatch({ type: 'TRANSACTION_ROLLBACK' });
      } catch {
        emergencyReset();
      }
    }
  }
}

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
export function createDocumentStore(
  config: Partial<DocumentStoreConfig> = {}
): ReconcilableDocumentStore {
  // Internal mutable state
  let state = createInitialState(config);
  const listeners = new Set<StoreListener>();
  let notifying = false; // Re-entrancy guard for notifyListeners (see 6.4)
  const transaction = createTransactionManager();
  const reconciliation: ReconciliationState = {
    idleCallbackId: null,
    isReconciling: false,
  };

  /**
   * Replace internal state reference only when it changes.
   */
  function setState(nextState: DocumentState): void {
    if (nextState !== state) {
      state = nextState;
    }
  }

  /**
   * Notify all listeners of state change.
   * Only called when not in a transaction.
   *
   * Re-entrancy guard: if a listener triggers `emergencyReset` (which itself
   * calls `notifyListeners`), the inner call is a no-op, preventing recursive
   * notification.
   */
  function notifyListeners(): void {
    if (notifying) return;
    notifying = true;
    try {
      // Snapshot listeners before iterating: guarantees delivery to all listeners
      // that were registered at notification start, even if one unsubscribes mid-notify.
      // The `notifying` guard (above) handles the orthogonal re-entrancy concern
      // (e.g. emergencyReset called from within a listener callback).
      const currentListeners = Array.from(listeners);
      for (const listener of currentListeners) {
        try {
          listener();
        } catch (error) {
          // Don't let one listener's error affect others
          console.error('Store listener threw an error:', error);
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
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
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
   * Dispatch an action to modify state.
   * @param action - Action to dispatch
   * @returns New state after applying the action
   *
   * **Notification contract:** listeners are notified synchronously on every
   * non-transaction dispatch. During an active transaction notifications are
   * suppressed and delivered as a single call on outermost commit or outermost rollback.
   */
  function dispatch(action: DocumentAction): DocumentState {
    // Handle transaction control actions
    if (action.type === 'TRANSACTION_START') {
      transaction.begin(state);
      return state;
    }

    if (action.type === 'TRANSACTION_COMMIT') {
      const result = transaction.commit();
      if (result.isOutermost) {
        notifyListeners();
        if (state.lineIndex.rebuildPending) {
          scheduleReconciliation();
        }
      }
      return state;
    }

    if (action.type === 'TRANSACTION_ROLLBACK') {
      const result = transaction.rollback();
      if (result.snapshot) {
        setState(result.snapshot);
      }
      if (result.isOutermost) {
        notifyListeners();
      }
      return state;
    }

    // Apply the action through the reducer
    const newState = documentReducer(state, action);

    // Only update if state actually changed (referential equality)
    if (newState !== state) {
      setState(newState);

      if (!transaction.isActive) {
        // Notify listeners immediately if not in transaction
        notifyListeners();

        // Schedule background reconciliation if line index has dirty ranges
        if (state.lineIndex.rebuildPending) {
          scheduleReconciliation();
        }
      }
    }

    return state;
  }

  /**
   * Batch multiple actions into a single state update.
   * Listeners are notified only once after all actions complete.
   * Actions keep their normal history behavior (one entry per action unless coalesced).
   *
   * @param actions - Array of actions to apply
   * @returns New state after applying all actions
   */
  function batch(actions: readonly DocumentAction[]): DocumentState {
    if (actions.length === 0) {
      return state;
    }
    withTransactionBatch(dispatch, dispatch, emergencyReset, actions);
    return state;
  }

  /**
   * Emergency reset when a rollback dispatch itself throws.
   * Clears all transaction state, restores the earliest snapshot, and notifies listeners.
   */
  function emergencyReset(): DocumentState | null {
    const earliest = transaction.emergencyReset();
    if (earliest) {
      setState(earliest);
    }
    notifyListeners();
    return earliest ?? null;
  }

  /**
   * Schedule background reconciliation using requestIdleCallback.
   * Falls back to setTimeout for environments without rIC.
   */
  function scheduleReconciliation(): void {
    // Don't schedule if already scheduled or no reconciliation needed
    if (reconciliation.idleCallbackId !== null) return;
    if (!state.lineIndex.rebuildPending) return;

    const callback = (deadline?: IdleDeadline) => {
      reconciliation.idleCallbackId = null;

      // Don't reconcile during active transaction
      if (transaction.isActive) {
        scheduleReconciliation();
        return;
      }

      // Check if we have time (>5ms remaining or no deadline)
      const hasTime = !deadline || deadline.timeRemaining() > 5;
      if (!hasTime) {
        scheduleReconciliation();
        return;
      }

      reconciliation.isReconciling = true;

      try {
        // Pass the current version (not version+1): reconciliation is
        // version-neutral and does not change visible content.
        const newLineIndex = reconcileFull(state.lineIndex, state.version);
        if (newLineIndex !== state.lineIndex) {
          setState(Object.freeze({
            ...state,
            lineIndex: newLineIndex,
            // state.version is intentionally unchanged — background reconciliation
            // is invisible to listeners and should not produce a version bump.
          }));
          // Notify consumers so they can re-read getSnapshot() with accurate offsets.
          // Previously-null documentOffset values are now resolved; without this call,
          // consumers relying on getSnapshot() would silently see stale nulls until the
          // next user action.
          notifyListeners();
        }
      } finally {
        reconciliation.isReconciling = false;
      }
    };

    if (typeof requestIdleCallback !== 'undefined') {
      reconciliation.idleCallbackId = requestIdleCallback(callback, {
        timeout: 1000, // Max 1 second delay
      });
    } else {
      // Fallback to setTimeout for environments without requestIdleCallback.
      // 200ms avoids the 16ms frame-rate storm in high-throughput Node.js scenarios.
      reconciliation.idleCallbackId = setTimeout(callback, 200) as unknown as number;
    }
  }

  /**
   * Force immediate reconciliation (blocking).
   * Use sparingly - prefer scheduleReconciliation().
   */
  function reconcileNow(): DocumentState<'eager'> {
    // Cancel any pending idle callback
    if (reconciliation.idleCallbackId !== null) {
      if (typeof cancelIdleCallback !== 'undefined') {
        cancelIdleCallback(reconciliation.idleCallbackId);
      } else {
        clearTimeout(reconciliation.idleCallbackId);
      }
      reconciliation.idleCallbackId = null;
    }

    if (!state.lineIndex.rebuildPending) {
      return state as DocumentState<'eager'>;
    }

    const nextVersion = state.version + 1;
    const newLineIndex = reconcileFull(state.lineIndex, nextVersion);
    if (newLineIndex !== state.lineIndex) {
      setState(Object.freeze({
        ...state,
        lineIndex: newLineIndex,
        version: nextVersion,
      }));
    }
    return state as DocumentState<'eager'>;
  }

  /**
   * Snapshot-gated synchronous reconciliation.
   * Returns null when `snapshot` is stale (a newer dispatch has occurred),
   * preventing a reconciled state from being applied to an out-of-date view.
   */
  function reconcileIfCurrent(snapshot: DocumentState): DocumentState<'eager'> | null {
    if (!isCurrentSnapshot(snapshot)) return null;
    return reconcileNow();
  }

  /**
   * Set viewport bounds and ensure those lines are accurate.
   */
  function setViewport(startLine: number, endLine: number): void {
    const newLineIndex = reconcileViewport(state.lineIndex, startLine, endLine, state.version);
    if (newLineIndex !== state.lineIndex) {
      setState(Object.freeze({
        ...state,
        lineIndex: newLineIndex,
      }));
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
    scheduleReconciliation,
    reconcileNow,
    reconcileIfCurrent,
    setViewport,
    emergencyReset,
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
 * @example
 * ```typescript
 * const store = createDocumentStoreWithEvents({ content: 'Hello' });
 *
 * store.addEventListener('content-change', (event) => {
 *   console.log('Content changed:', event.affectedRange);
 * });
 *
 * store.dispatch({ type: 'INSERT', position: byteOffset(5), text: ' World' });
 * // Event fires with affectedRange: [5, 11]
 * ```
 *
 * @param config - Optional configuration for the store
 * @returns A DocumentStoreWithEvents instance
 */
export function createDocumentStoreWithEvents(
  config: Partial<DocumentStoreConfig> = {}
): DocumentStoreWithEvents {
  const baseStore = createDocumentStore(config);
  const emitter = createEventEmitter();

  /**
   * Emit appropriate events based on action type and state changes.
   */
  function emitEventsForAction(
    action: DocumentAction,
    prevState: DocumentState,
    nextState: DocumentState
  ): void {
    // Content change events for local text edits and remote content updates
    if (isTextEditAction(action) || action.type === 'APPLY_REMOTE') {
      emitter.emit(
        'content-change',
        createContentChangeEvent(action, prevState, nextState, getAffectedRange(action))
      );
    }

    // Selection change events
    if (action.type === 'SET_SELECTION') {
      emitter.emit(
        'selection-change',
        createSelectionChangeEvent(prevState, nextState)
      );
    }

    // History change events
    if (action.type === 'UNDO' || action.type === 'REDO') {
      emitter.emit(
        'history-change',
        createHistoryChangeEvent(
          action.type === 'UNDO' ? 'undo' : 'redo',
          prevState,
          nextState
        )
      );
    }

    // Dirty state change events
    if (prevState.metadata.isDirty !== nextState.metadata.isDirty) {
      emitter.emit(
        'dirty-change',
        createDirtyChangeEvent(nextState.metadata.isDirty, nextState)
      );
    }
  }

  /**
   * Enhanced dispatch that emits events after state changes.
   */
  function dispatch(action: DocumentAction): DocumentState {
    const prevState = baseStore.getSnapshot();
    const nextState = baseStore.dispatch(action);

    // Only emit events if state actually changed
    if (nextState !== prevState) {
      emitEventsForAction(action, prevState, nextState);
    }

    return nextState;
  }

  /**
   * Enhanced batch that emits events after all actions complete.
   * Uses the enhanced dispatch (which captures before/after for events)
   * within a transaction, eliminating the need to replay the reducer.
   */
  function batch(actions: readonly DocumentAction[]): DocumentState {
    if (actions.length === 0) {
      return baseStore.getSnapshot();
    }
    // Transaction control goes through baseStore.dispatch (owns the transaction stack).
    // Per-action dispatch goes through the local event-emitting dispatch.
    withTransactionBatch(baseStore.dispatch, dispatch, baseStore.emergencyReset, actions);
    return baseStore.getSnapshot();
  }

  return {
    // Pass through base store methods
    subscribe: baseStore.subscribe,
    getSnapshot: baseStore.getSnapshot,
    getServerSnapshot: baseStore.getServerSnapshot,
    isCurrentSnapshot: baseStore.isCurrentSnapshot,
    scheduleReconciliation: baseStore.scheduleReconciliation,
    reconcileNow: baseStore.reconcileNow,
    reconcileIfCurrent: baseStore.reconcileIfCurrent,
    setViewport: baseStore.setViewport,
    emergencyReset: baseStore.emergencyReset,

    // Enhanced methods with event emission
    dispatch,
    batch,

    // Event emitter methods
    addEventListener: emitter.addEventListener,
    removeEventListener: emitter.removeEventListener,
    events: emitter,
  };
}

/**
 * Execute a callback within a transaction boundary on the given store.
 *
 * Provides the same error-handling resilience as `batch`: the callback runs
 * inside a TRANSACTION_START / TRANSACTION_COMMIT bracket; on any exception
 * a TRANSACTION_ROLLBACK is attempted, falling back to `emergencyReset` if
 * the rollback dispatch itself throws.
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
  fn: (store: ReconcilableDocumentStore) => T
): T {
  store.dispatch({ type: 'TRANSACTION_START' });
  let success = false;
  try {
    const result = fn(store);
    success = true;
    store.dispatch({ type: 'TRANSACTION_COMMIT' });
    return result;
  } finally {
    if (!success) {
      try {
        store.dispatch({ type: 'TRANSACTION_ROLLBACK' });
      } catch {
        store.emergencyReset();
      }
    }
  }
}

/**
 * Check if a value is a DocumentStore.
 * Useful for type narrowing.
 */
export function isDocumentStore(value: unknown): value is DocumentStore {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const store = value as Partial<DocumentStore>;
  return (
    typeof store.subscribe === 'function' &&
    typeof store.getSnapshot === 'function' &&
    typeof store.isCurrentSnapshot === 'function' &&
    typeof store.dispatch === 'function' &&
    typeof store.batch === 'function'
  );
}
