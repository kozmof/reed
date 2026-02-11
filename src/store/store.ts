/**
 * Document store implementation for the Reed document editor.
 * Factory function that creates a DocumentStore with encapsulated state.
 */

import type { DocumentState, DocumentStoreConfig } from '../types/state.ts';
import type { DocumentAction } from '../types/actions.ts';
import type { DocumentStore, DocumentStoreWithEvents, StoreListener, Unsubscribe } from '../types/store.ts';
import { createInitialState } from './state.ts';
import { documentReducer } from './reducer.ts';
import { reconcileFull, reconcileViewport } from './line-index.ts';
import {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createDirtyChangeEvent,
  getAffectedRange,
} from './events.ts';
import { isTextEditAction } from '../types/actions.ts';

/**
 * Transaction state tracked by the store.
 */
interface TransactionState {
  /** Depth of nested transactions */
  depth: number;
  /** Stack of state snapshots for each nesting level (for rollback) */
  snapshotStack: DocumentState[];
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
    snapshotStack: [],
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
      transaction.snapshotStack.push(state);
      if (transaction.depth === 0) {
        transaction.pendingActions = [];
      }
      transaction.depth++;
      return state;
    }

    if (action.type === 'TRANSACTION_COMMIT') {
      if (transaction.depth > 0) {
        transaction.depth--;
        transaction.snapshotStack.pop();
        if (transaction.depth === 0) {
          transaction.pendingActions = [];
          notifyListeners();
        }
      }
      return state;
    }

    if (action.type === 'TRANSACTION_ROLLBACK') {
      if (transaction.depth > 0) {
        const snapshot = transaction.snapshotStack.pop();
        if (snapshot) {
          state = snapshot;
        }
        transaction.depth--;
        if (transaction.depth === 0) {
          transaction.pendingActions = [];
        }
      }
      notifyListeners();
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
          if (transaction.snapshotStack.length > 0) {
            state = transaction.snapshotStack[0];
          }
          transaction.depth = 0;
          transaction.snapshotStack = [];
          transaction.pendingActions = [];
          notifyListeners();
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
        const nextVersion = state.version + 1;
        const newLineIndex = reconcileFull(state.lineIndex, nextVersion);
        if (newLineIndex !== state.lineIndex) {
          state = Object.freeze({
            ...state,
            lineIndex: newLineIndex,
            version: nextVersion,
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

    const nextVersion = state.version + 1;
    const newLineIndex = reconcileFull(state.lineIndex, nextVersion);
    if (newLineIndex !== state.lineIndex) {
      state = Object.freeze({
        ...state,
        lineIndex: newLineIndex,
        version: nextVersion,
      });
    }
  }

  /**
   * Set viewport bounds and ensure those lines are accurate.
   */
  function setViewport(startLine: number, endLine: number): void {
    const newLineIndex = reconcileViewport(state.lineIndex, startLine, endLine, state.version);
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
    // Content change events for text editing actions
    if (isTextEditAction(action)) {
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
   */
  function batch(actions: DocumentAction[]): DocumentState {
    const prevState = baseStore.getSnapshot();
    const nextState = baseStore.batch(actions);

    if (nextState !== prevState) {
      // Replay through reducer to capture intermediate states for accurate events
      let intermediateState = prevState;
      for (const action of actions) {
        const afterAction = documentReducer(intermediateState, action);
        if (afterAction !== intermediateState) {
          emitEventsForAction(action, intermediateState, afterAction);
        }
        intermediateState = afterAction;
      }
    }

    return nextState;
  }

  return {
    // Pass through base store methods
    subscribe: baseStore.subscribe,
    getSnapshot: baseStore.getSnapshot,
    getServerSnapshot: baseStore.getServerSnapshot,
    scheduleReconciliation: baseStore.scheduleReconciliation,
    reconcileNow: baseStore.reconcileNow,
    setViewport: baseStore.setViewport,

    // Enhanced methods with event emission
    dispatch,
    batch,

    // Event emitter methods
    addEventListener: emitter.addEventListener.bind(emitter),
    removeEventListener: emitter.removeEventListener.bind(emitter),
    events: emitter,
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
