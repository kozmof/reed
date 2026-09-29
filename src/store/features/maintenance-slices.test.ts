import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentStore } from "./store.js";
import { DocumentActions } from "./actions.js";
import { byteOffset } from "../../types/branded.js";
import { getValue } from "../core/piece-table.js";
import { collectLines } from "../core/line-index.js";
import { createInitialState } from "../core/state.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function idleQueue(): Array<IdleRequestCallback> {
  const callbacks: IdleRequestCallback[] = [];
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => callbacks.push(callback));
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  return callbacks;
}
const deadline = { didTimeout: false, timeRemaining: () => 50 } as IdleDeadline;
function flush(callbacks: Array<IdleRequestCallback>): void {
  let iterations = 0;
  while (callbacks.length) {
    callbacks.shift()!(deadline);
    expect(++iterations).toBeLessThan(500);
  }
}
describe("idle maintenance slices", () => {
  it("yields, discards stale work, and resolves waiters only on a complete current index", async () => {
    const callbacks = idleQueue();
    const store = createDocumentStore({ content: "abc\n".repeat(6000) });
    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));
    const pending = store.whenReconciled();
    callbacks.shift()!(deadline);
    expect(store.getSnapshot().lineIndex.rebuildPending).toBe(true);
    store.dispatch(DocumentActions.insert(byteOffset(2), "漢\n"));
    const text = getValue(store.getSnapshot().pieceTable);
    flush(callbacks);
    const eager = await pending;
    expect(getValue(eager.pieceTable)).toBe(text);
    const expected = createInitialState({ content: text });
    expect(collectLines(eager.lineIndex.root).map((n) => [n.documentOffset, n.lineLength])).toEqual(
      collectLines(expected.lineIndex.root).map((n) => [n.documentOffset, n.lineLength]),
    );
    store.dispose();
  });
  it("restarts compaction after an intervening edit and preserves its content", () => {
    const callbacks = idleQueue();
    const store = createDocumentStore();
    store.dispatch(DocumentActions.insert(byteOffset(0), "x".repeat(1000000)));
    store.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(600000)));
    // Finish any line repair, then start compaction with a one-unit deadline.
    while (store.getSnapshot().lineIndex.rebuildPending) callbacks.shift()!(deadline);
    let reads = 0;
    callbacks.shift()!({
      didTimeout: false,
      timeRemaining: () => (++reads === 1 ? 50 : 0),
    } as IdleDeadline);
    const old = store.getSnapshot();
    store.dispatch(DocumentActions.insert(byteOffset(1), "changed"));
    const expected = getValue(store.getSnapshot().pieceTable);
    flush(callbacks);
    expect(getValue(store.getSnapshot().pieceTable)).toBe(expected);
    expect(getValue(old.pieceTable)).toBe("x".repeat(400000));
    expect(store.getSnapshot().pieceTable.addBuffer.length).toBe(400007);
    store.dispose();
  });
  it("does not reschedule after disposal from a maintenance notification", () => {
    const callbacks = idleQueue();
    const store = createDocumentStore({ content: "a\n" });
    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));
    store.subscribe(() => store.dispose());
    flush(callbacks);
    expect(callbacks).toHaveLength(0);
  });
  it("uses prompt continuation timers after the initial fallback delay", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const store = createDocumentStore({ content: "a\n".repeat(4000) });
    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));
    vi.advanceTimersByTime(200);
    expect(store.getSnapshot().lineIndex.rebuildPending).toBe(true);
    vi.advanceTimersByTime(20);
    expect(store.getSnapshot().lineIndex.rebuildPending).toBe(false);
    await store.whenReconciled();
    store.dispose();
  });
});
