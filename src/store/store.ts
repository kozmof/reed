/**
 * Document store implementation for the Reed document editor.
 * Factory function that creates a DocumentStore with encapsulated state.
 */

import type { DocumentState, DocumentStoreConfig } from '../types/state.ts';
import type { DocumentAction } from '../types/actions.ts';
import type { DocumentStore, StoreListener, Unsubscribe } from '../types/store.ts';
import { createInitialState } from './state.ts';
import { documentReducer } from './reducer.ts';

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

    try {
      // Apply all actions
      for (const action of actions) {
        dispatch(action);
      }

      // Commit transaction
      dispatch({ type: 'TRANSACTION_COMMIT' });
    } catch (error) {
      // Rollback on error
      dispatch({ type: 'TRANSACTION_ROLLBACK' });
      throw error;
    }

    return state;
  }

  // Return the store interface
  return {
    subscribe,
    getSnapshot,
    getServerSnapshot,
    dispatch,
    batch,
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
