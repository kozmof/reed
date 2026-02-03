/**
 * DocumentStore interface for the Reed document editor.
 * Framework-agnostic store interface compatible with React's useSyncExternalStore,
 * Redux, Zustand, Vue, Svelte, and vanilla JavaScript.
 */

import type { DocumentState } from './state.ts';
import type { DocumentAction } from './actions.ts';

/**
 * Listener function type for store subscriptions.
 */
export type StoreListener = () => void;

/**
 * Unsubscribe function returned by subscribe.
 */
export type Unsubscribe = () => void;

/**
 * Framework-agnostic store interface.
 * Compatible with React's useSyncExternalStore, Redux, Zustand, etc.
 */
export interface DocumentStore {
  /**
   * Subscribe to state changes.
   * The listener is called whenever the state changes.
   * @param listener - Function to call when state changes
   * @returns Unsubscribe function to remove the listener
   */
  subscribe(listener: StoreListener): Unsubscribe;

  /**
   * Get current immutable state snapshot.
   * Must return the same reference if state hasn't changed.
   * This enables React's useSyncExternalStore to work correctly.
   * @returns Current document state
   */
  getSnapshot(): DocumentState;

  /**
   * Get server-side snapshot (for SSR/hydration).
   * Returns the same as getSnapshot() by default.
   * @returns Server-side document state
   */
  getServerSnapshot?(): DocumentState;

  /**
   * Dispatch an action to modify state.
   * Returns the new state after the action is applied.
   * @param action - Action to dispatch
   * @returns New state after applying the action
   */
  dispatch(action: DocumentAction): DocumentState;

  /**
   * Batch multiple actions into a single state update.
   * Listeners are notified only once after all actions complete.
   * All actions form a single undo unit.
   * @param actions - Array of actions to apply
   * @returns New state after applying all actions
   */
  batch(actions: DocumentAction[]): DocumentState;

  /**
   * Schedule background reconciliation of the line index.
   * Uses requestIdleCallback when available, falls back to setTimeout.
   * Does nothing if no reconciliation is pending.
   */
  scheduleReconciliation?(): void;

  /**
   * Force immediate synchronous reconciliation of the line index.
   * Use sparingly - prefer scheduleReconciliation() for non-critical updates.
   */
  reconcileNow?(): void;

  /**
   * Set viewport bounds and ensure those lines have accurate offsets.
   * Reconciles visible lines immediately while deferring off-screen updates.
   * @param startLine - First visible line (0-indexed)
   * @param endLine - Last visible line (0-indexed)
   */
  setViewport?(startLine: number, endLine: number): void;
}

/**
 * Read-only subset of DocumentStore for consumers that only need to read state.
 * Useful for selectors and derived state.
 */
export interface ReadonlyDocumentStore {
  subscribe(listener: StoreListener): Unsubscribe;
  getSnapshot(): DocumentState;
  getServerSnapshot?(): DocumentState;
}

/**
 * Type for the document reducer function.
 * Pure function that produces new state from old state + action.
 */
export type DocumentReducer = (
  state: DocumentState,
  action: DocumentAction
) => DocumentState;
