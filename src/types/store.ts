/**
 * DocumentStore interface for the Reed document editor.
 * Framework-agnostic store interface compatible with React's useSyncExternalStore,
 * Redux, Zustand, Vue, Svelte, and vanilla JavaScript.
 */

import type { DocumentState } from './state.ts';
import type { DocumentAction } from './actions.ts';
import type {
  DocumentEventEmitter,
  DocumentEventMap,
  EventHandler,
  Unsubscribe,
} from '../store/features/events.ts';

// Re-export so the public API surface (types/index.ts) can import from one place.
export type { Unsubscribe };

/**
 * Listener function type for store subscriptions.
 */
export type StoreListener = () => void;

/**
 * Core framework-agnostic store interface.
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
   * Check whether a previously captured snapshot is still current.
   * Useful to guard against stale references during async workflows.
   */
  isCurrentSnapshot(snapshot: DocumentState): boolean;

  /**
   * Dispatch an action to modify state.
   * Returns the new state after the action is applied synchronously.
   *
   * For undo/redo, prefer using the return value directly rather than
   * calling getSnapshot() afterward — they return the same reference.
   * Alternatively, subscribe to the `history-change` event on a
   * DocumentStoreWithEvents to centralise cursor sync in one handler.
   *
   * @param action - Action to dispatch
   * @returns New state after applying the action
   */
  dispatch(action: DocumentAction): DocumentState;

  /**
   * Batch multiple actions into a single state update.
   * Listeners are notified only once after all actions complete.
   * Actions keep their normal history behavior (one entry per action unless coalesced).
   * @param actions - Array of actions to apply
   * @returns New state after applying all actions
   */
  batch(actions: readonly DocumentAction[]): DocumentState;
}

/**
 * Store with reconciliation capabilities.
 * Returned by createDocumentStore — reconciliation methods are always present.
 */
export interface ReconcilableDocumentStore extends DocumentStore {
  /**
   * Schedule background reconciliation of the line index.
   * Uses requestIdleCallback when available, falls back to setTimeout.
   * Does nothing if no reconciliation is pending.
   */
  scheduleReconciliation(): void;

  /**
   * Force immediate synchronous reconciliation of the line index.
   * Returns the reconciled state with evaluation mode narrowed to 'eager',
   * guaranteeing no dirty ranges remain.
   * Use sparingly - prefer scheduleReconciliation() for non-critical updates.
   */
  reconcileNow(): DocumentState<'eager'>;

  /**
   * Snapshot-gated synchronous reconciliation.
   * Returns null when `snapshot` is stale (i.e., a newer dispatch has occurred),
   * preventing a reconciled mode transition from being applied to an out-of-date view.
   * Use this when reconciling from an async context where the snapshot may have aged.
   */
  reconcileIfCurrent(snapshot: DocumentState): DocumentState<'eager'> | null;

  /**
   * Set viewport bounds and ensure those lines have accurate offsets.
   * Reconciles visible lines immediately while deferring off-screen updates.
   * @param startLine - First visible line (0-indexed)
   * @param endLine - Last visible line (0-indexed)
   */
  setViewport(startLine: number, endLine: number): void;

  /**
   * Get the current state, reconciling dirty line-index ranges immediately if needed.
   * Returns DocumentState<'eager'> — all line offsets are guaranteed accurate.
   * Unlike reconcileNow(), this does not bump the version number, since resolving
   * offsets does not change visible content.
   * Prefer this over getSnapshot() when APIs that require DocumentState<'eager'>
   * (e.g. query.getLineRange) are needed without an explicit reconciliation call.
   */
  getEagerSnapshot(): DocumentState<'eager'>;

  /**
   * Emergency reset when a rollback dispatch itself throws.
   * Clears all transaction state, restores the earliest snapshot, and notifies listeners.
   * Returns the restored state, or null if no snapshot was available.
   */
  emergencyReset(): DocumentState | null;
}

/**
 * Read-only subset of DocumentStore for consumers that only need to read state.
 * Useful for selectors and derived state.
 */
export interface ReadonlyDocumentStore {
  subscribe(listener: StoreListener): Unsubscribe;
  getSnapshot(): DocumentState;
  getServerSnapshot?(): DocumentState;
  isCurrentSnapshot(snapshot: DocumentState): boolean;
}

/**
 * Type for the document reducer function.
 * Pure function that produces new state from old state + action.
 */
export type DocumentReducer = (
  state: DocumentState,
  action: DocumentAction
) => DocumentState;

/**
 * Extended store interface that combines state management with event emission.
 * Provides automatic event emission on dispatch for type-safe event handling.
 *
 * Use this when you need to react to specific document changes
 * (content changes, selection changes, history changes) rather than
 * just knowing that "something changed".
 */
export interface DocumentStoreWithEvents extends ReconcilableDocumentStore {
  /**
   * Subscribe to typed document events.
   * More specific than subscribe() - you get detailed event information.
   *
   * @example
   * ```typescript
   * store.addEventListener('content-change', (event) => {
   *   console.log('Changed range:', event.affectedRange);
   *   console.log('Action:', event.action.type);
   * });
   * ```
   *
   * @param type - Event type to listen for
   * @param handler - Handler function called with the event
   * @returns Unsubscribe function
   */
  addEventListener<K extends keyof DocumentEventMap>(
    type: K,
    handler: EventHandler<DocumentEventMap[K]>
  ): Unsubscribe;

  /**
   * Remove a previously registered event listener.
   *
   * @param type - Event type
   * @param handler - The same handler function passed to addEventListener
   */
  removeEventListener<K extends keyof DocumentEventMap>(
    type: K,
    handler: EventHandler<DocumentEventMap[K]>
  ): void;

  /**
   * Access the underlying event emitter for advanced use cases.
   * Prefer addEventListener/removeEventListener for typical usage.
   */
  readonly events: DocumentEventEmitter;
}

// ReadTextFn and DeleteBoundaryContext have moved to types/state.ts —
// they are operational parameters of line-index functions, not store interface types.

