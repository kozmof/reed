/**
 * Document store implementation for the Reed document editor.
 * Factory function that creates a DocumentStore with encapsulated state.
 */

import {
  advanceMaintenance,
  reconcileIncrementally,
  compactIncrementally,
  createCompactionWorkspace,
  type CompactionWorkspace,
  type ReconciliationCache,
} from "../core/incremental-maintenance.js";

import type {
  DocumentState,
  DocumentStoreConfig,
  DocumentStoreRestoreConfig,
  DocumentStoreRuntimeConfig,
} from "../../types/state.js";
import type { CheckpointRestoreOptions } from "../../types/checkpoint.js";
import type { DocumentAction } from "../../types/actions.js";
import type {
  DocumentStore,
  ReconcilableDocumentStore,
  DocumentStoreWithEvents,
  StoreListener,
  Unsubscribe,
} from "../../types/store.js";
import {
  assertValidDocumentStoreRuntimeConfig,
  assertValidHistoryEvictionPolicy,
  createInitialState,
  withState,
} from "../core/state.js";
import { restoreCheckpoint } from "./checkpoint.js";
import { reduceDocument, type DocumentTransition } from "./reducer.js";
import { reconcileFull, reconcileViewport } from "../core/line-index.js";
import { getBufferStats, compactAddBuffer } from "../core/piece-table.js";
import { createTransactionManager, makeBatch, type CommitResult } from "./transaction.js";
import { MAX_OBSERVER_REENTRANT_STEPS, reportCaughtError } from "./diagnostics.js";
import { withEvents } from "./event-store.js";
import {
  createReconciliationScheduler,
  type ReconciliationSchedulerOptions,
} from "./reconciliation-scheduler.js";

// Automatically compact the add buffer when more than this fraction of allocated bytes
// are unreferenced and the buffer exceeds AUTO_COMPACT_MIN_BYTES.
// Checked after each mutation in the idle callback, alongside reconciliation.
const AUTO_COMPACT_WASTE_RATIO = 0.5;
const AUTO_COMPACT_MIN_BYTES = 16384; // 16 KB

/**
 * Create a document store with private listeners and transaction state.
 *
 * @param config - Optional configuration for the store
 * @returns A new DocumentStore instance
 */
export function createDocumentStore(config: DocumentStoreConfig = {}): ReconcilableDocumentStore {
  return createStoreOverState(createInitialState(config), config).store;
}

/**
 * A store together with its commit function. `commit` applies an action like
 * `dispatch` but returns the reducer's transition for it: the state it
 * produced, before any listener notified by it dispatches again, and whether
 * it dropped stale history. The event layer describes that transition, so it
 * does not depend on the order of the store's listeners.
 */
interface StoreCore {
  readonly store: ReconcilableDocumentStore;
  readonly commit: (action: DocumentAction) => DocumentTransition;
}

/**
 * The warning for history an EVICT_CHUNKS discarded, or null.
 *
 * EVICT_CHUNKS chooses which chunks go, so its caller, such as ChunkManager
 * keeping within maxLoadedChunks, does not choose the history lost. Undo then
 * stops short with no other sign, so the store that commits it says so.
 * EVICT_CHUNK names its chunk, so its caller chose the loss, and
 * `history-drop` reports both.
 */
function evictionWarning(action: DocumentAction, transition: DocumentTransition): string | null {
  const loss = transition.historyDropped;
  if (action.type !== "EVICT_CHUNKS" || loss === null) return null;
  return (
    `[Reed] evicting chunks to stay within ${action.maxLoaded} loaded chunks ` +
    `discarded ${loss.undo} undo and ${loss.redo} redo entries that pointed into them, ` +
    `under the "${transition.state.history.evictionPolicy}" history eviction policy. ` +
    `Raise the chunk limit (ChunkManager's maxLoadedChunks), or use "pin" to keep history at the cost of memory.`
  );
}

/**
 * Shared store body. Takes the state to start from, so a store can be built
 * either from configuration (`createDocumentStore`) or from an already-assembled
 * state (`createDocumentStoreFromCheckpoint`).
 *
 * Listeners, transaction depth, the scheduler, and reconciliation waiters start
 * fresh even when the state contains restored history.
 */
function createStoreOverState(
  initialState: DocumentState,
  config: DocumentStoreRuntimeConfig,
): StoreCore {
  // Internal mutable state
  let state = initialState;
  const whenReconciledWaiters: Array<{
    resolve(state: DocumentState<"eager">): void;
    reject(error: Error): void;
  }> = [];
  const reconcileMode = config.reconcileMode ?? "idle";
  const logger = config.logger;
  let disposed = false;
  // Clone the listeners array when it changes during notification so the active
  // iteration keeps its snapshot. Otherwise, mutate it in place. Adding a listener
  // takes O(1), and removing one takes O(n) for n listeners.
  let listeners: StoreListener[] = [];
  let notifying = false;
  // A dispatch from inside a listener cannot recurse through the listener list,
  // but its notification must not be lost. The active notification drains this
  // flag in a follow-up pass after its current listener snapshot completes.
  let notificationPending = false;
  const transaction = createTransactionManager();
  // Warnings of history lost to evictions committed inside a transaction
  // (see `evictionWarning`), each with the depth that holds it. The outermost
  // commit logs them, and a rollback discards those its level held, since it
  // restores the history.
  let deferredWarnings: { depth: number; readonly message: string }[] = [];

  /**
   * Replace internal state reference only when it changes.
   */
  function setState(nextState: DocumentState): void {
    if (nextState !== state) {
      if (lineJob && lineJob.source !== nextState.lineIndex) lineJob = null;
      if (compactJob && compactJob.source !== nextState.pieceTable) compactJob = null;
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

  let lineJob: {
    source: DocumentState["lineIndex"];
    work: ReturnType<typeof reconcileIncrementally>;
  } | null = null;
  let compactJob: {
    source: DocumentState["pieceTable"];
    work: ReturnType<typeof compactIncrementally>;
  } | null = null;

  let lineCache: ReconciliationCache = new WeakMap();
  let compactWorkspace: CompactionWorkspace | null = null;
  let preferCompaction = false;

  /** Advance one maintenance job by one bounded step batch, alternating jobs. */
  function runMaintenanceSlice(shouldYield: () => boolean): void {
    const compactPending = needsCompaction();
    if (!compactPending) {
      compactJob = null;
      compactWorkspace = null;
    }
    const runCompaction = compactPending && (preferCompaction || !state.lineIndex.rebuildPending);
    preferCompaction = !runCompaction;
    if (state.lineIndex.rebuildPending && !runCompaction) {
      if (!lineJob || lineJob.source !== state.lineIndex) {
        lineJob = {
          source: state.lineIndex,
          work: reconcileIncrementally(state.lineIndex, state.revision, lineCache),
        };
      }
      const job = lineJob;
      const result = advanceMaintenance(job.work, shouldYield);
      if (result.done && job.source === state.lineIndex) {
        lineJob = null;
        lineCache = new WeakMap();
        setState(withState(state, { lineIndex: result.value }));
        notifyListeners();
      }
    } else if (runCompaction) {
      if (!compactJob || compactJob.source !== state.pieceTable) {
        // Interrupted jobs can reserve spans later deleted by an edit.
        // Bound retained scratch space before resuming on the new tree.
        const used = state.pieceTable.root?.subtreeAddLength ?? 0;
        if (
          compactWorkspace &&
          (compactWorkspace.length > Math.max(used * 2, 65536) ||
            compactWorkspace.pages.length * 65536 > Math.max(used * 4, 65536))
        )
          compactWorkspace = null;
        compactWorkspace ??= createCompactionWorkspace(state.pieceTable);
        compactJob = {
          source: state.pieceTable,
          work: compactIncrementally(state.pieceTable, compactWorkspace),
        };
      }
      const job = compactJob;
      const result = advanceMaintenance(job.work, shouldYield);
      if (result.done && job.source === state.pieceTable) {
        compactJob = null;
        compactWorkspace = null;
        setState(withState(state, { pieceTable: result.value }));
        notifyListeners();
      }
    }
  }

  const schedulerOptions: ReconciliationSchedulerOptions = {
    hasPendingWork: () => !disposed && (state.lineIndex.rebuildPending || needsCompaction()),
    shouldDefer: () => transaction.isActive,
    performWork(shouldYield) {
      if (shouldYield) {
        // A slice stops at advanceMaintenance's step cap, often after about
        // 1 ms. Keep slicing until the time budget is spent, so each callback
        // is not followed by a timer gap after a fraction of its budget.
        do {
          runMaintenanceSlice(shouldYield);
        } while (schedulerOptions.hasPendingWork() && !transaction.isActive && !shouldYield());
        return schedulerOptions.hasPendingWork();
      }
      lineJob = null;
      compactJob = null;
      lineCache = new WeakMap();
      compactWorkspace = null;
      if (state.lineIndex.rebuildPending) {
        const newLineIndex = reconcileFull(state.lineIndex, state.revision);
        if (newLineIndex !== state.lineIndex) {
          setState(withState(state, { lineIndex: newLineIndex }));
          notifyListeners();
        }
      }
      applyCompactionIfNeeded();
    },
  };
  const scheduler =
    typeof config.scheduler === "function"
      ? config.scheduler(schedulerOptions)
      : (config.scheduler ?? createReconciliationScheduler(reconcileMode, schedulerOptions));

  /**
   * Notify all listeners of state change.
   * Only called when not in a transaction.
   *
   * Re-entrant notifications are coalesced into a follow-up pass. This avoids
   * recursive listener execution while ensuring subscribers that ran before a
   * nested dispatch are notified of the resulting state.
   *
   * Subscriptions added or removed during notification clone the listeners
   * array first. The active iteration keeps its original snapshot.
   */
  function notifyListeners(): void {
    if (notifying) {
      notificationPending = true;
      return;
    }
    notifying = true;
    let deliveryPasses = 0;
    try {
      do {
        notificationPending = false;
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            // Don't let one listener's error affect others
            reportCaughtError(logger, "Store listener threw an error", error);
          }
        }
        deliveryPasses++;
        if (notificationPending && deliveryPasses >= MAX_OBSERVER_REENTRANT_STEPS) {
          notificationPending = false;
          reportCaughtError(
            logger,
            "Store listener notification cycle exceeded the re-entrancy limit",
            new Error(
              `A listener requested more than ${MAX_OBSERVER_REENTRANT_STEPS} synchronous notification passes`,
            ),
          );
        }
      } while (notificationPending);
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
    // Preserve the active notification snapshot by cloning before adding a
    // listener. Outside notification, append in place in O(1).
    if (notifying) {
      listeners = [...listeners, listener];
    } else {
      listeners.push(listener);
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const idx = listeners.indexOf(listener);
      if (idx === -1) return;
      if (notifying) {
        // Preserve the active iteration snapshot while removing only this
        // subscription when the same callback was registered more than once.
        listeners = [...listeners.slice(0, idx), ...listeners.slice(idx + 1)];
      } else {
        listeners.splice(idx, 1);
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
   * Notify listeners synchronously when dispatch changes state outside a transaction.
   * During a transaction, defer notification until the outermost commit or rollback.
   */
  function dispatch(action: DocumentAction): DocumentState {
    commit(action);
    return state;
  }

  /**
   * Apply an action and return the reducer's transition for it. A listener
   * the action notifies can dispatch again, so `state` can already be later.
   */
  function commit(action: DocumentAction): DocumentTransition {
    if (disposed) return { state, historyDropped: null };
    const transition = reduceDocument(state, action);
    const changed = transition.state !== state;
    if (changed) setState(transition.state);
    // Warn before listeners hear of the change, so warnings follow the order
    // their evictions committed, even when a listener evicts again.
    const warning = evictionWarning(action, transition);
    if (warning !== null) {
      if (transaction.isActive)
        deferredWarnings.push({ depth: transaction.depth, message: warning });
      else logWarnings([warning]);
    }
    if (changed && !transaction.isActive) afterCommit();
    return transition;
  }

  /**
   * Notify listeners of a committed change and schedule reconciliation.
   *
   * The change has already committed, so neither step may throw: a listener's
   * error is reported by `notifyListeners`, and a scheduler's error here. A
   * caller can then rely on a throw from `dispatch` or `commitTransaction`
   * meaning the change did not take effect.
   */
  function afterCommit(): void {
    notifyListeners();
    try {
      if (state.lineIndex.rebuildPending || needsCompaction()) {
        scheduleReconciliation();
      }
    } catch (error) {
      reportCaughtError(logger, "Reconciliation scheduler threw after a commit", error);
    }
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
   * On throw (invariant violation) the store calls emergencyReset before rethrowing,
   * so a throw means the transaction did not commit. Errors after the commit
   * are reported instead (see `afterCommit`).
   * Do not attempt rollback if `commitTransaction` throws.
   */
  function commitTransaction(): void {
    if (disposed) return;
    let result: CommitResult;
    try {
      result = transaction.commit();
    } catch (e) {
      emergencyReset();
      throw e;
    }
    if (result.isOutermost) {
      // Warn before notifying, in commit order: a listener may evict again
      // and warn of its own loss, dispose the store, which clears the queue,
      // or open a transaction of its own, whose losses have not committed yet.
      const warnings = deferredWarnings;
      deferredWarnings = [];
      logWarnings(warnings.map((entry) => entry.message));
      afterCommit();
    } else {
      // The enclosing level now holds what this one committed.
      for (const entry of deferredWarnings) {
        if (entry.depth > transaction.depth) entry.depth = transaction.depth;
      }
    }
  }

  /**
   * Log warnings of history lost to evictions that have committed. The change
   * has committed, so a logger's error is reported, not thrown.
   */
  function logWarnings(messages: readonly string[]): void {
    const warn = logger?.warn;
    if (warn === undefined) return;
    for (const message of messages) {
      try {
        warn.call(logger, message);
      } catch (error) {
        reportCaughtError(logger, "The logger threw after an eviction committed", error);
      }
    }
  }

  /**
   * Roll back the current transaction level to its starting snapshot.
   * Notifies listeners when the outermost rollback completes.
   * @throws if called with no active transaction (depth is 0).
   */
  function rollbackTransaction(): void {
    if (disposed) return;
    const result = transaction.rollback();
    if (deferredWarnings.length > 0) {
      deferredWarnings = deferredWarnings.filter((entry) => entry.depth <= transaction.depth);
    }
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
    deferredWarnings = [];
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
    lineJob = null;
    compactJob = null;
    lineCache = new WeakMap();
    compactWorkspace = null;
    listeners = [];
    deferredWarnings = [];
    rejectWhenReconciledWaiters(
      new Error("DocumentStore was disposed before reconciliation completed"),
    );
  }

  /**
   * Apply `reconcileFull` to the current state and return an eager state.
   * Resolving cached offsets preserves revision because it leaves content unchanged.
   */
  function reconcileInPlace(): DocumentState<"eager"> {
    if (!state.lineIndex.rebuildPending) return state as DocumentState<"eager">;
    const newLineIndex = reconcileFull(state.lineIndex, state.revision);
    // Capture the eager state before a subscriber can make it lazy again.
    const eagerSnapshot = withState(state, { lineIndex: newLineIndex }) as DocumentState<"eager">;
    if (newLineIndex !== state.lineIndex) {
      setState(eagerSnapshot);
      // Reconciliation changes the snapshot reference even though document
      // content and revision stay unchanged. External-store consumers must be
      // notified whenever getSnapshot() can return a new reference.
      if (!transaction.isActive) {
        notifyListeners();
      }
    }
    resolveWhenReconciledIfReady();
    return eagerSnapshot;
  }

  /**
   * Get the current state with all dirty line-index ranges resolved.
   * Reconciles in-place without incrementing the revision number (offset resolution
   * does not change visible content, so no revision increment is warranted).
   */
  function getEagerSnapshot(): DocumentState<"eager"> {
    return reconcileInPlace();
  }

  /**
   * Force immediate reconciliation (blocking).
   * Prefer scheduleReconciliation() when updates can wait.
   *
   * Preserve `state.revision` because resolving offsets leaves text unchanged.
   * Callers that need to detect whether lines are ready should inspect
   * `lineIndex.rebuildPending`, not compare revision numbers.
   */
  function reconcileNow(): DocumentState<"eager"> {
    scheduler.cancel();
    return reconcileInPlace();
  }

  /**
   * Reconcile synchronously if `snapshot` is still current.
   * Return null if the store has moved to a different snapshot.
   */
  function reconcileIfCurrent(snapshot: DocumentState): DocumentState<"eager"> | null {
    if (!isCurrentSnapshot(snapshot)) return null;
    return reconcileNow();
  }

  /**
   * Return a Promise that resolves once the line index is fully reconciled.
   * Resolve immediately if rebuildPending is false, or wait until a store state
   * update leaves the index clean.
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
      // Register the waiter first because a custom scheduler is allowed to
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
    const newLineIndex = reconcileViewport(state.lineIndex, startLine, endLine, state.revision);
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
  const store: ReconcilableDocumentStore = {
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
  return { store, commit };
}

/**
 * Create a DocumentStore with integrated event emission.
 * Wraps a base store to automatically emit typed events on dispatch.
 *
 * Events are emitted after state changes:
 * - 'content-change': On INSERT, DELETE, REPLACE, APPLY_REMOTE
 * - 'selection-change': On SET_SELECTION, and when INSERT, DELETE, REPLACE, APPLY_REMOTE, UNDO,
 *   REDO, or a chunk load or eviction moves the selection. An edit moves it past the edit, so
 *   typing at the cursor fires it, and so does a remote edit before the cursor
 * - 'history-change': On UNDO and REDO that apply an entry
 * - 'history-drop': When an action discards undo or redo entries without undoing or redoing
 *   them: EVICT_CHUNK or EVICT_CHUNKS that drops entries, UNDO or REDO that drops an entry no
 *   longer resolving inside the document, and APPLY_REMOTE or HISTORY_CLEAR that clears history
 * - 'attention-change': When the attention layer changes
 * - 'save': On MARK_SAVED
 * - 'dirty-change': When isDirty state changes
 *
 * Buffer transaction events at each nesting depth. Flush them in order
 * when the outermost transaction commits.
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
 * // Event fires with affectedRanges: [[5, 11]]
 * ```
 *
 * @param config - Optional configuration for the store
 * @returns A DocumentStoreWithEvents instance
 */
export function createDocumentStoreWithEvents(
  config: DocumentStoreConfig = {},
): DocumentStoreWithEvents {
  const { store, commit } = createStoreOverState(createInitialState(config), config);
  return withEvents(store, commit, config.logger);
}

/**
 * Configuration keys that describe state rather than runtime. A restored store
 * takes each of these from its checkpoint, so passing one would be silently
 * ignored. Reject those options to prevent configuration mistakes.
 */
const STATE_BEARING_CONFIG_KEYS = [
  "content",
  "historyLimit",
  "chunkSize",
  "encoding",
  "lineEnding",
  "normalizeInsertedLineEndings",
  "undoGroupTimeout",
  "totalFileSize",
  "maxDirtyRanges",
] as const;

function assertRuntimeOnlyConfig(config: DocumentStoreRestoreConfig): void {
  const offending = STATE_BEARING_CONFIG_KEYS.filter(
    (key) => (config as Record<string, unknown>)[key] !== undefined,
  );
  if (offending.length > 0) {
    throw new Error(
      `createDocumentStoreFromCheckpoint: ${offending.join(", ")} describe${offending.length === 1 ? "s" : ""} state and come${offending.length === 1 ? "s" : ""} from the checkpoint; only logger, reconcileMode/scheduler, and historyEvictionPolicy may be configured`,
    );
  }
}

/**
 * Create a store whose state comes from a checkpoint rather than from config.
 *
 * Validate the checkpoint before creating a store. Payloads that violate
 * piece-table or line-index invariants raise `CheckpointError`.
 *
 * Only runtime configuration is accepted. Content, history limit, line ending,
 * chunk size, and the rest of the state-bearing options come from the
 * checkpoint. `historyEvictionPolicy` is the exception: when given, it replaces
 * the checkpoint's policy (see `DocumentStoreRestoreConfig`). The new store starts with empty listener and transaction state
 * and a fresh reconciliation scheduler. A caller restoring a
 * chunked document rebuilds its `ChunkManager` as well.
 *
 * Pass resource limits as the third argument when the checkpoint comes from
 * outside the application.
 *
 * @example
 * ```ts
 * const store = createDocumentStoreFromCheckpoint(JSON.parse(saved), {
 *   reconcileMode: "idle",
 * });
 * ```
 *
 * @throws CheckpointError when the checkpoint is not restorable
 * @throws Error when `config` carries a state-bearing option
 */
export function createDocumentStoreFromCheckpoint(
  checkpoint: unknown,
  config: DocumentStoreRestoreConfig = {},
  restoreOptions: CheckpointRestoreOptions = {},
): ReconcilableDocumentStore {
  return restoreStoreCore(checkpoint, config, restoreOptions).store;
}

function restoreStoreCore(
  checkpoint: unknown,
  config: DocumentStoreRestoreConfig,
  restoreOptions: CheckpointRestoreOptions,
): StoreCore {
  assertValidDocumentStoreRuntimeConfig(config);
  assertValidHistoryEvictionPolicy(config.historyEvictionPolicy);
  assertRuntimeOnlyConfig(config);
  const restored = restoreCheckpoint(checkpoint, restoreOptions);
  const policy = config.historyEvictionPolicy;
  const state =
    policy === undefined || policy === restored.history.evictionPolicy
      ? restored
      : withState(restored, {
          history: Object.freeze({ ...restored.history, evictionPolicy: policy }),
        });
  return createStoreOverState(state, config);
}

/**
 * Checkpoint-restoring counterpart of `createDocumentStoreWithEvents`.
 *
 * The restored store starts with no listeners and emits no restore events.
 * Later dispatches emit events for subscribed listeners.
 *
 * Pass resource limits as the third argument when the checkpoint comes from
 * outside the application.
 *
 * @throws CheckpointError when the checkpoint is not restorable
 * @throws Error when `config` carries a state-bearing option
 */
export function createDocumentStoreWithEventsFromCheckpoint(
  checkpoint: unknown,
  config: DocumentStoreRestoreConfig = {},
  restoreOptions: CheckpointRestoreOptions = {},
): DocumentStoreWithEvents {
  const { store, commit } = restoreStoreCore(checkpoint, config, restoreOptions);
  return withEvents(store, commit, config.logger);
}

/**
 * Execute a callback within a transaction boundary on the given store.
 *
 * The callback must be synchronous. Promise and thenable results are rejected
 * and synchronous changes are rolled back. Complete asynchronous work before
 * entering the transaction. Already-started asynchronous work cannot be cancelled.
 *
 * Provides the same error-handling resilience as `batch`: the callback runs
 * inside a beginTransaction / commitTransaction bracket. On any exception from
 * the callback a rollback is attempted, falling back to `emergencyReset` if
 * rollback itself throws.
 *
 * If commitTransaction throws (invariant violation), the store has already called
 * emergencyReset internally, so no further rollback is attempted.
 *
 * If a transaction is already active, begin an inner transaction.
 * Only completion of the outermost transaction notifies listeners.
 *
 * @param store - The store to transact against
 * @param fn - Callback whose return value is forwarded to the caller
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
  fn: (
    store: ReconcilableDocumentStore,
  ) => T & (Extract<T, { then: (...args: never[]) => unknown }> extends never ? unknown : never),
): T {
  if (Object.prototype.toString.call(fn) === "[object AsyncFunction]") {
    throw new TypeError("withTransaction requires a synchronous callback");
  }
  store.beginTransaction();
  let result: T;
  try {
    result = fn(store);
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      // Observe rejection while rejecting this unsupported callback and rolling back.
      void Promise.resolve(result).catch(() => {});
      throw new TypeError("withTransaction requires a synchronous callback");
    }
  } catch (e) {
    try {
      store.rollbackTransaction();
    } catch {
      store.emergencyReset();
    }
    throw e;
  }
  // Commit after the callback succeeds. Commit handles failures with emergencyReset.
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
