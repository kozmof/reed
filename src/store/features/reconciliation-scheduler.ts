/**
 * ReconciliationScheduler — encapsulates the async scheduling lifecycle for
 * background maintenance (line-index reconciliation and add-buffer compaction).
 *
 * Extracted from createDocumentStore so that:
 * - The store remains focused on state transitions and listener notifications.
 * - Tests can inject a custom scheduler (via DocumentStoreConfig.scheduler)
 *   without relying on the reconcileMode: 'sync' config toggle.
 * - The idle/sync/none dispatch logic lives in one well-tested place.
 */

// =============================================================================
// Public interface
// =============================================================================

/**
 * Options passed to createReconciliationScheduler.
 * All three callbacks are live closures — the scheduler always reads the
 * latest store state when they are invoked.
 */
export interface ReconciliationSchedulerOptions {
  /** Return true when there is pending work (reconciliation or compaction). */
  hasPendingWork(): boolean;
  /**
   * Return true when work should be skipped this tick (e.g. a transaction is
   * active and state mutations should not be flushed yet).
   */
  shouldDefer(): boolean;
  /** Execute all pending maintenance work synchronously. */
  performWork(): void;
}

/**
 * Factory for a custom reconciliation scheduler.
 *
 * Prefer this over passing a pre-built scheduler instance: the factory receives
 * the store's live maintenance callbacks, so it can schedule work without
 * circularly capturing the store being constructed.
 */
export type ReconciliationSchedulerFactory = (
  options: ReconciliationSchedulerOptions,
) => ReconciliationScheduler;

/**
 * Coordinates when background maintenance fires.
 * Implementations differ by mode but share the same surface area.
 */
export interface ReconciliationScheduler {
  /**
   * Request that maintenance runs soon.
   * - `none`  — no-op.
   * - `sync`  — runs immediately unless `shouldDefer()` is true.
   * - `idle`  — registers a requestIdleCallback / setTimeout if not already
   *             scheduled and `hasPendingWork()` is true.
   */
  schedule(): void;

  /**
   * Cancel any pending idle callback.
   * Safe to call when nothing is scheduled.
   */
  cancel(): void;

  /**
   * Run maintenance synchronously right now, bypassing the idle queue.
   * Also cancels any previously scheduled callback to avoid double-execution.
   */
  runNow(): void;

  /** True while performWork() is executing, preventing re-entrant scheduling. */
  readonly isRunning: boolean;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a ReconciliationScheduler for the given mode.
 *
 * @param mode    - Scheduling strategy: 'idle' | 'sync' | 'none'.
 * @param options - Live callbacks into the store (state accessors / mutators).
 */
export function createReconciliationScheduler(
  mode: "idle" | "sync" | "none",
  options: ReconciliationSchedulerOptions,
): ReconciliationScheduler {
  const { hasPendingWork, shouldDefer, performWork } = options;

  let idleCallbackId: number | null = null;
  let running = false;

  function runWork(): void {
    running = true;
    try {
      performWork();
    } finally {
      running = false;
    }
  }

  function cancel(): void {
    if (idleCallbackId === null) return;
    if (typeof cancelIdleCallback !== "undefined") {
      cancelIdleCallback(idleCallbackId);
    } else {
      clearTimeout(idleCallbackId);
    }
    idleCallbackId = null;
  }

  function runNow(): void {
    cancel();
    if (!hasPendingWork()) return;
    runWork();
  }

  if (mode === "none") {
    return {
      schedule() {},
      cancel() {},
      runNow,
      get isRunning() {
        return running;
      },
    };
  }

  if (mode === "sync") {
    // Set when schedule() is called re-entrantly while a drain is in progress.
    let pendingReschedule = false;
    return {
      schedule() {
        // A re-entrant call (a listener dispatched during performWork) must not
        // recurse — record the request and let the active drain loop pick it up.
        if (running) {
          pendingReschedule = true;
          return;
        }
        // Drain rather than run once. performWork() notifies listeners, and a
        // listener may dispatch another edit that flips rebuildPending back on.
        // That edit's schedule() sets pendingReschedule above; loop until no
        // re-entrant work remains so the follow-up is reconciled before we return.
        do {
          pendingReschedule = false;
          if (!hasPendingWork() || shouldDefer()) return;
          runWork();
        } while (pendingReschedule);
      },
      cancel() {},
      runNow,
      get isRunning() {
        return running;
      },
    };
  }

  // mode === 'idle'
  // NOTE: `hasPendingWork` and `shouldDefer` are live closures that always
  // read the latest store state — not snapshots from when schedule() was called.
  function scheduleIdle(): void {
    if (idleCallbackId !== null) return; // already scheduled
    if (!hasPendingWork()) return;

    const callback = (deadline?: IdleDeadline) => {
      idleCallbackId = null;

      if (shouldDefer()) {
        scheduleIdle();
        return;
      }

      const hasTime = !deadline || deadline.didTimeout || deadline.timeRemaining() > 5;
      if (!hasTime) {
        scheduleIdle();
        return;
      }

      if (!hasPendingWork()) return;
      runWork();
    };

    if (typeof requestIdleCallback !== "undefined") {
      idleCallbackId = requestIdleCallback(callback, { timeout: 1000 });
    } else {
      // Fallback for environments without requestIdleCallback (e.g. Node.js).
      // 200 ms avoids the 16 ms frame-rate storm in high-throughput scenarios.
      idleCallbackId = setTimeout(callback, 200) as unknown as number;
    }
  }

  return {
    schedule: scheduleIdle,
    cancel,
    runNow,
    get isRunning() {
      return running;
    },
  };
}
