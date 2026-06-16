import { afterEach, describe, expect, it, vi } from "vitest";
import { createReconciliationScheduler } from "./reconciliation-scheduler.ts";

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

    callbacks[0]({
      didTimeout: false,
      timeRemaining: () => 0,
    } as IdleDeadline);
    expect(workCount).toBe(0);
    expect(callbacks).toHaveLength(2);

    callbacks[1]({
      didTimeout: false,
      timeRemaining: () => 10,
    } as IdleDeadline);
    expect(workCount).toBe(1);

    scheduler.cancel();
    expect(cancelCount).toBe(0);
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
    callbacks[1]({
      didTimeout: false,
      timeRemaining: () => 10,
    } as IdleDeadline);
    expect(workCount).toBe(0);
    expect(callbacks).toHaveLength(3);

    shouldDefer = false;
    callbacks[2]({
      didTimeout: false,
      timeRemaining: () => 10,
    } as IdleDeadline);
    expect(workCount).toBe(1);
  });
});
