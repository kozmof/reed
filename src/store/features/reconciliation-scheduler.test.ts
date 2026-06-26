import { afterEach, describe, expect, it, vi } from "vitest";
import { createReconciliationScheduler } from "./reconciliation-scheduler.js";

const g = globalThis as typeof globalThis & {
  requestIdleCallback?: (
    callback: (deadline?: IdleDeadline) => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (id: number) => void;
};

describe("ReconciliationScheduler", () => {
  const originalRequestIdleCallback = g.requestIdleCallback;
  const originalCancelIdleCallback = g.cancelIdleCallback;

  afterEach(() => {
    g.requestIdleCallback = originalRequestIdleCallback;
    g.cancelIdleCallback = originalCancelIdleCallback;
    vi.restoreAllMocks();
  });

  it("mode 'none' ignores schedule but still supports runNow", () => {
    let workCount = 0;
    const scheduler = createReconciliationScheduler("none", {
      hasPendingWork: () => true,
      shouldDefer: () => false,
      performWork: () => {
        workCount++;
      },
    });

    scheduler.schedule();
    expect(workCount).toBe(0);

    scheduler.runNow();
    expect(workCount).toBe(1);
  });

  it("mode 'sync' defers work until shouldDefer becomes false", () => {
    let shouldDefer = true;
    let workCount = 0;
    const scheduler = createReconciliationScheduler("sync", {
      hasPendingWork: () => true,
      shouldDefer: () => shouldDefer,
      performWork: () => {
        workCount++;
      },
    });

    scheduler.schedule();
    expect(workCount).toBe(0);

    shouldDefer = false;
    scheduler.schedule();
    expect(workCount).toBe(1);
  });

  it("mode 'idle' reschedules when the deadline has no time remaining", () => {
    const callbacks: IdleRequestCallback[] = [];
    let cancelCount = 0;
    let workCount = 0;

    g.requestIdleCallback = (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    };
    g.cancelIdleCallback = () => {
      cancelCount++;
    };

    const scheduler = createReconciliationScheduler("idle", {
      hasPendingWork: () => true,
      shouldDefer: () => false,
      performWork: () => {
        workCount++;
      },
    });

    scheduler.schedule();
    expect(callbacks).toHaveLength(1);

    callbacks[0]!({
      didTimeout: false,
      timeRemaining: () => 0,
    } as IdleDeadline);
    expect(workCount).toBe(0);
    expect(callbacks).toHaveLength(2);

    callbacks[1]!({
      didTimeout: false,
      timeRemaining: () => 10,
    } as IdleDeadline);
    expect(workCount).toBe(1);

    scheduler.cancel();
    expect(cancelCount).toBe(0);
  });

  it("mode 'idle' runs work when the idle callback times out", () => {
    const callbacks: IdleRequestCallback[] = [];
    let workCount = 0;

    g.requestIdleCallback = (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    };

    const scheduler = createReconciliationScheduler("idle", {
      hasPendingWork: () => true,
      shouldDefer: () => false,
      performWork: () => {
        workCount++;
      },
    });

    scheduler.schedule();

    callbacks[0]!({
      didTimeout: true,
      timeRemaining: () => 0,
    } as IdleDeadline);

    expect(workCount).toBe(1);
    expect(callbacks).toHaveLength(1);
  });

  it("mode 'idle' cancels the scheduled callback and reschedules after deferral", () => {
    const callbacks: IdleRequestCallback[] = [];
    let cancelCount = 0;
    let shouldDefer = true;
    let workCount = 0;

    g.requestIdleCallback = (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    };
    g.cancelIdleCallback = () => {
      cancelCount++;
    };

    const scheduler = createReconciliationScheduler("idle", {
      hasPendingWork: () => true,
      shouldDefer: () => shouldDefer,
      performWork: () => {
        workCount++;
      },
    });

    scheduler.schedule();
    expect(callbacks).toHaveLength(1);

    scheduler.cancel();
    expect(cancelCount).toBe(1);

    scheduler.schedule();
    callbacks[1]!({
      didTimeout: false,
      timeRemaining: () => 10,
    } as IdleDeadline);
    expect(workCount).toBe(0);
    expect(callbacks).toHaveLength(3);

    shouldDefer = false;
    callbacks[2]!({
      didTimeout: false,
      timeRemaining: () => 10,
    } as IdleDeadline);
    expect(workCount).toBe(1);
  });

  describe("isRunning lifecycle", () => {
    it("mode 'none' reports isRunning only while performWork executes (via runNow)", () => {
      let observedDuringWork: boolean | null = null;
      const scheduler = createReconciliationScheduler("none", {
        hasPendingWork: () => true,
        shouldDefer: () => false,
        performWork: () => {
          observedDuringWork = scheduler.isRunning;
        },
      });

      expect(scheduler.isRunning).toBe(false);
      scheduler.runNow();
      expect(observedDuringWork).toBe(true);
      expect(scheduler.isRunning).toBe(false);
    });

    it("mode 'sync' reports isRunning only while performWork executes", () => {
      let observedDuringWork: boolean | null = null;
      const scheduler = createReconciliationScheduler("sync", {
        hasPendingWork: () => true,
        shouldDefer: () => false,
        performWork: () => {
          observedDuringWork = scheduler.isRunning;
        },
      });

      expect(scheduler.isRunning).toBe(false);
      scheduler.schedule();
      expect(observedDuringWork).toBe(true);
      expect(scheduler.isRunning).toBe(false);
    });

    it("mode 'idle' reports isRunning only while the idle callback runs work", () => {
      const callbacks: IdleRequestCallback[] = [];
      g.requestIdleCallback = (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      };

      let observedDuringWork: boolean | null = null;
      const scheduler = createReconciliationScheduler("idle", {
        hasPendingWork: () => true,
        shouldDefer: () => false,
        performWork: () => {
          observedDuringWork = scheduler.isRunning;
        },
      });

      expect(scheduler.isRunning).toBe(false);
      scheduler.schedule();
      expect(scheduler.isRunning).toBe(false);

      callbacks[0]!({ didTimeout: true, timeRemaining: () => 0 } as IdleDeadline);
      expect(observedDuringWork).toBe(true);
      expect(scheduler.isRunning).toBe(false);
    });

    it("resets isRunning to false even when performWork throws", () => {
      const scheduler = createReconciliationScheduler("sync", {
        hasPendingWork: () => true,
        shouldDefer: () => false,
        performWork: () => {
          throw new Error("boom");
        },
      });

      expect(() => scheduler.schedule()).toThrow("boom");
      expect(scheduler.isRunning).toBe(false);
    });

    it("mode 'sync' suppresses re-entrant schedule() while work is running", () => {
      let workCount = 0;
      let reentrantRunningFlag: boolean | null = null;
      const scheduler = createReconciliationScheduler("sync", {
        hasPendingWork: () => true,
        shouldDefer: () => false,
        performWork: () => {
          workCount++;
          if (workCount === 1) {
            // Re-entrant call must be a no-op: the running guard prevents recursion.
            reentrantRunningFlag = scheduler.isRunning;
            scheduler.schedule();
          }
        },
      });

      scheduler.schedule();
      expect(reentrantRunningFlag).toBe(true);
      expect(workCount).toBe(1);
    });
  });

  describe("pending work disappearing before execution", () => {
    it("mode 'none' runNow skips work when nothing is pending", () => {
      let workCount = 0;
      const scheduler = createReconciliationScheduler("none", {
        hasPendingWork: () => false,
        shouldDefer: () => false,
        performWork: () => {
          workCount++;
        },
      });

      scheduler.runNow();
      expect(workCount).toBe(0);
    });

    it("mode 'sync' schedule skips work when nothing is pending", () => {
      let workCount = 0;
      const scheduler = createReconciliationScheduler("sync", {
        hasPendingWork: () => false,
        shouldDefer: () => false,
        performWork: () => {
          workCount++;
        },
      });

      scheduler.schedule();
      expect(workCount).toBe(0);
    });

    it("mode 'idle' skips work when pending work vanishes before the callback fires", () => {
      const callbacks: IdleRequestCallback[] = [];
      g.requestIdleCallback = (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      };

      let pending = true;
      let workCount = 0;
      const scheduler = createReconciliationScheduler("idle", {
        hasPendingWork: () => pending,
        shouldDefer: () => false,
        performWork: () => {
          workCount++;
        },
      });

      scheduler.schedule();
      expect(callbacks).toHaveLength(1);

      // Work completes through another path before the idle callback runs.
      pending = false;
      callbacks[0]!({ didTimeout: true, timeRemaining: () => 0 } as IdleDeadline);
      expect(workCount).toBe(0);
    });
  });
});
