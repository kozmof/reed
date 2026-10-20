/**
 * Store interfaces for reading and editing Reed documents with any UI framework.
 */

import type { DocumentState } from "./state.js";
import type { DocumentAction } from "./actions.js";
import type {
  DocumentEventEmitter,
  DocumentEventMap,
  EventHandler,
  Unsubscribe,
} from "../store/features/events.js";

// Re-export so the public API surface (types/index.ts) can import from one place.
export type { Unsubscribe };

/**
 * Listener function type for store subscriptions.
 */
export type StoreListener = () => void;

/**
 * Core store interface for reading snapshots, subscribing, and dispatching actions.
 */
export interface DocumentStore {
  /**
   * Subscribe a listener to state changes.
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
   * Get the snapshot for server rendering and hydration.
   * Reed stores return the same state as getSnapshot().
   * @returns Server-side document state
   */
  getServerSnapshot?: (() => DocumentState) | undefined;

  /**
   * Check whether a previously captured snapshot is still current.
   * Useful to guard against stale references during async workflows.
   */
  isCurrentSnapshot(snapshot: DocumentState): boolean;

  /**
   * Dispatch an action to modify state.
   * Returns the new state after the action is applied synchronously.
   *
   * Use the return value to read restored selection state after undo/redo.
   * It has the same reference as getSnapshot() immediately after dispatch.
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
 * Explicit transaction control methods, separated from the document-action dispatch channel.
 * Each method has its own error contract (see createDocumentStore for details).
 */
export interface TransactionControl {
  /**
   * Begin a transaction (or nest within an existing one).
   * On throw, the store has already called emergencyReset internally.
   */
  beginTransaction(): void;

  /**
   * Commit the current transaction level.
   * If this is the outermost transaction, listeners are notified and reconciliation is scheduled.
   * If no transaction is active, this is a no-op.
   * On throw, the store has already called emergencyReset internally.
   */
  commitTransaction(): void;

  /**
   * Roll back the current transaction level to the snapshot from `beginTransaction`.
   * If this is the outermost rollback, listeners are notified.
   * @throws if called with no active transaction (depth is 0).
   *
   * Rolling back a nested transaction restores the snapshot from that level.
   * The enclosing transaction stays open with the state from before the inner
   * `beginTransaction` call. Roll back the outer transaction to abort it too.
   */
  rollbackTransaction(): void;
}

/** Store with reconciliation methods, returned by createDocumentStore. */
export interface ReconcilableDocumentStore extends DocumentStore, TransactionControl {
  /**
   * Ask the configured scheduler to reconcile the line index.
   * The default idle scheduler uses requestIdleCallback when available and
   * falls back to setTimeout. The "none" preset does no background work.
   */
  scheduleReconciliation(): void;

  /**
   * Force immediate synchronous reconciliation of the line index.
   * Returns the reconciled state with evaluation mode narrowed to 'eager',
   * guaranteeing no dirty ranges remain.
   * A subscriber may edit during notification, so the returned eager snapshot
   * may already be stale. Use isCurrentSnapshot() to check it.
   * Prefer scheduleReconciliation() when updates can wait.
   */
  reconcileNow(): DocumentState<"eager">;

  /**
   * Reconcile synchronously if `snapshot` is still current.
   * Return null if the store has moved to a different snapshot.
   * Use this after asynchronous work to avoid reconciling a stale view.
   */
  reconcileIfCurrent(snapshot: DocumentState): DocumentState<"eager"> | null;

  /**
   * Set viewport bounds and ensure those lines have accurate offsets.
   * Reconciles visible lines immediately while deferring off-screen updates.
   * @param startLine - First visible line (0-indexed)
   * @param endLine - Last visible line (0-indexed)
   */
  setViewport(startLine: number, endLine: number): void;

  /**
   * Get the current state, reconciling dirty line-index ranges immediately if needed.
   * Return DocumentState<'eager'> with all line offsets resolved.
   * Like reconcileNow(), this preserves the revision number because resolving
   * offsets does not change visible content. A subscriber may edit during notification,
   * so the returned eager snapshot may already be stale.
   * Prefer this over getSnapshot() when APIs that require DocumentState<'eager'>
   * (e.g. query.getLineRange) are needed without an explicit reconciliation call.
   */
  getEagerSnapshot(): DocumentState<"eager">;

  /**
   * Emergency reset when a rollback dispatch itself throws.
   * Clears all transaction state, restores the earliest snapshot, and notifies listeners.
   * Returns the restored state, or null if no snapshot was available.
   */
  emergencyReset(): DocumentState | null;

  /**
   * Return a Promise that resolves with an eager (fully-reconciled) state.
   *
   * Resolves immediately when `lineIndex.rebuildPending` is already false.
   * Otherwise wait for a state update with `rebuildPending` false after
   * background reconciliation or a `reconcileNow()` call. In `reconcileMode: "none"`,
   * Reed reconciles immediately because no background scheduler exists.
   *
   * Await this method when an operation requires `DocumentState<"eager">`.
   *
   * @example
   * ```ts
   * const eager = await store.whenReconciled();
   * const range = query.getLineRange(eager, 0);
   * ```
   *
   * Rejects if `dispose()` is called before reconciliation completes.
   */
  whenReconciled(): Promise<DocumentState<"eager">>;

  /**
   * Cancel any pending background maintenance owned by this store.
   * Call when permanently discarding a store instance.
   * Pending `whenReconciled()` callers are rejected during disposal.
   */
  dispose(): void;
}

/**
 * Read-only subset of DocumentStore for consumers that only need to read state.
 * Useful for selectors and derived state.
 */
export interface ReadonlyDocumentStore {
  subscribe(listener: StoreListener): Unsubscribe;
  getSnapshot(): DocumentState;
  getServerSnapshot?: (() => DocumentState) | undefined;
  isCurrentSnapshot(snapshot: DocumentState): boolean;
}

/**
 * Pure function that produces a new state from the previous state and an action.
 */
export type DocumentReducer = (state: DocumentState, action: DocumentAction) => DocumentState;

/**
 * Store interface with typed events emitted on dispatch.
 * Subscribe to content, selection, or history events to receive details about
 * specific changes.
 */
export interface DocumentStoreWithEvents extends ReconcilableDocumentStore {
  /**
   * Subscribe to typed document events.
   * Receive details about specific changes through typed events.
   *
   * @example
   * ```typescript
   * store.addEventListener('content-change', (event) => {
   *   console.log('Changed ranges:', event.affectedRanges);
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
    handler: EventHandler<DocumentEventMap[K]>,
  ): Unsubscribe;

  /**
   * Remove a previously registered event listener.
   *
   * @param type - Event type
   * @param handler - The same handler function passed to addEventListener
   */
  removeEventListener<K extends keyof DocumentEventMap>(
    type: K,
    handler: EventHandler<DocumentEventMap[K]>,
  ): void;

  /**
   * Access the underlying event emitter for advanced use cases.
   * Prefer addEventListener/removeEventListener for typical usage.
   */
  readonly events: DocumentEventEmitter;
}

// ReadTextFn and DeleteBoundaryContext are defined in types/operations.ts.
// They are parameters of line-index functions.
