/**
 * Document store implementation for the Reed document editor.
 * Factory function that creates a DocumentStore with encapsulated state.
 */

import type { DocumentState, DocumentStoreConfig } from '../types/state.ts';
import type { DocumentAction } from '../types/actions.ts';
import type { DocumentStore, StoreListener, Unsubscribe } from '../types/store.ts';
import { createInitialState } from './state.ts';
import { documentReducer } from './reducer.ts';
import { reconcileFull, reconcileViewport } from './line-index.ts';

/**
 * Transaction state tracked by the store.
 */
interface TransactionState {
  /** Depth of nested transactions */
  depth: number;
  /** State snapshot before transaction started (for rollback) */
  snapshotBeforeTransaction: DocumentState | null;
  /** Actions accumulated during transaction */
  pendingActions: DocumentAction[];
}

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
): DocumentStore {
  // Internal mutable state
  let state = createInitialState(config);
  const listeners = new Set<StoreListener>();
  const transaction: TransactionState = {
    depth: 0,
    snapshotBeforeTransaction: null,
    pendingActions: [],
  };
  const reconciliation: ReconciliationState = {
    idleCallbackId: null,
    isReconciling: false,
  };

  /**
   * Notify all listeners of state change.
   * Only called when not in a transaction.
   */
  function notifyListeners(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        // Don't let one listener's error affect others
        console.error('Store listener threw an error:', error);
      }
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
   * Dispatch an action to modify state.
   * @param action - Action to dispatch
   * @returns New state after applying the action
   */
  function dispatch(action: DocumentAction): DocumentState {
    // Handle transaction control actions
    if (action.type === 'TRANSACTION_START') {
      if (transaction.depth === 0) {
        transaction.snapshotBeforeTransaction = state;
        transaction.pendingActions = [];
      }
      transaction.depth++;
      return state;
    }

    if (action.type === 'TRANSACTION_COMMIT') {
      if (transaction.depth > 0) {
        transaction.depth--;
        if (transaction.depth === 0) {
          transaction.snapshotBeforeTransaction = null;
          transaction.pendingActions = [];
          notifyListeners();
        }
      }
      return state;
    }

    if (action.type === 'TRANSACTION_ROLLBACK') {
      if (transaction.depth > 0 && transaction.snapshotBeforeTransaction) {
        state = transaction.snapshotBeforeTransaction;
      }
      transaction.depth = 0;
      transaction.snapshotBeforeTransaction = null;
      transaction.pendingActions = [];
      return state;
    }

    // Apply the action through the reducer
    const newState = documentReducer(state, action);

    // Only update if state actually changed (referential equality)
    if (newState !== state) {
      state = newState;

      // Track pending actions if in transaction
      if (transaction.depth > 0) {
        transaction.pendingActions.push(action);
      } else {
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
   * All actions form a single undo unit.
   *
   * @param actions - Array of actions to apply
   * @returns New state after applying all actions
   */
  function batch(actions: DocumentAction[]): DocumentState {
    if (actions.length === 0) {
      return state;
    }

    // Start transaction
    dispatch({ type: 'TRANSACTION_START' });

    let success = false;
    try {
      // Apply all actions
      for (const action of actions) {
        dispatch(action);
      }

      // Commit transaction
      dispatch({ type: 'TRANSACTION_COMMIT' });
      success = true;
    } finally {
      // Ensure transaction state is always cleaned up, even if rollback fails
      if (!success) {
        try {
          dispatch({ type: 'TRANSACTION_ROLLBACK' });
        } catch {
          // If rollback fails, manually reset transaction state to prevent corruption
          if (transaction.snapshotBeforeTransaction) {
            state = transaction.snapshotBeforeTransaction;
          }
          transaction.depth = 0;
          transaction.snapshotBeforeTransaction = null;
          transaction.pendingActions = [];
        }
      }
    }

    return state;
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
      if (transaction.depth > 0) {
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
        const newLineIndex = reconcileFull(state.lineIndex);
        if (newLineIndex !== state.lineIndex) {
          state = Object.freeze({
            ...state,
            lineIndex: newLineIndex,
            version: state.version + 1,
          });
          // Don't notify listeners - this is a background optimization
          // that doesn't change visible content
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
      // Fallback to setTimeout for environments without requestIdleCallback
      reconciliation.idleCallbackId = setTimeout(callback, 16) as unknown as number;
    }
  }

  /**
   * Force immediate reconciliation (blocking).
   * Use sparingly - prefer scheduleReconciliation().
   */
  function reconcileNow(): void {
    // Cancel any pending idle callback
    if (reconciliation.idleCallbackId !== null) {
      if (typeof cancelIdleCallback !== 'undefined') {
        cancelIdleCallback(reconciliation.idleCallbackId);
      } else {
        clearTimeout(reconciliation.idleCallbackId);
      }
      reconciliation.idleCallbackId = null;
    }

    if (!state.lineIndex.rebuildPending) return;

    const newLineIndex = reconcileFull(state.lineIndex);
    if (newLineIndex !== state.lineIndex) {
      state = Object.freeze({
        ...state,
        lineIndex: newLineIndex,
        version: state.version + 1,
      });
    }
  }

  /**
   * Set viewport bounds and ensure those lines are accurate.
   */
  function setViewport(startLine: number, endLine: number): void {
    const newLineIndex = reconcileViewport(state.lineIndex, startLine, endLine);
    if (newLineIndex !== state.lineIndex) {
      state = Object.freeze({
        ...state,
        lineIndex: newLineIndex,
      });
    }

    // Schedule background reconciliation for remaining dirty ranges
    scheduleReconciliation();
  }

  // Return the store interface
  return {
    subscribe,
    getSnapshot,
    getServerSnapshot,
    dispatch,
    batch,
    scheduleReconciliation,
    reconcileNow,
    setViewport,
  };
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
    typeof store.dispatch === 'function' &&
    typeof store.batch === 'function'
  );
}
