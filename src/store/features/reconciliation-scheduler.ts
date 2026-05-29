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
    return {
      schedule() {
        if (running) return;
        if (!hasPendingWork()) return;
        if (shouldDefer()) return;
        runWork();
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

      const hasTime = !deadline || deadline.timeRemaining() > 5;
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
