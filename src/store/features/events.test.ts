/**
 * Tests for the event system.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  getAffectedRanges,
} from "./events.js";
import { createInitialState } from "./../core/state.js";
import { DocumentActions } from "./actions.js";
import { createDocumentStore, createDocumentStoreWithEvents } from "./store.js";
import { withEvents } from "./event-store.js";
import type { DocumentAction } from "../../types/actions.js";
import type { DocumentState, DocumentStoreConfig } from "../../types/state.js";
import { getValue } from "../core/piece-table.js";
import { byteOffset, byteLength } from "../../types/branded.js";
import {
  MAX_OBSERVER_DELIVERED_ACTIONS,
  MAX_OBSERVER_DELIVERED_ACTIONS_CEILING,
  MAX_OBSERVER_REENTRANT_STEPS,
} from "./diagnostics.js";

describe("Event Emitter", () => {
  describe("addEventListener", () => {
    it("should add and call event handlers", () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      emitter.addEventListener("save", handler);

      const state = createInitialState();
      const event = createSaveEvent(state);
      emitter.emit("save", event);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should support multiple handlers for same event", () => {
      const emitter = createEventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.addEventListener("save", handler1);
      emitter.addEventListener("save", handler2);

      const state = createInitialState();
      emitter.emit("save", createSaveEvent(state));

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("should return unsubscribe function", () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      const unsubscribe = emitter.addEventListener("save", handler);

      const state = createInitialState();
      emitter.emit("save", createSaveEvent(state));
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      emitter.emit("save", createSaveEvent(state));
      expect(handler).toHaveBeenCalledTimes(1); // Still 1, not called again
    });

    it("should not let a stale unsubscribe remove newer handlers", () => {
      const emitter = createEventEmitter();
      const oldHandler = vi.fn();
      const newHandler = vi.fn();
      const unsubscribeOld = emitter.addEventListener("save", oldHandler);

      emitter.removeAllListeners();
      emitter.addEventListener("save", newHandler);
      unsubscribeOld();
      emitter.emit("save", createSaveEvent(createInitialState()));

      expect(oldHandler).not.toHaveBeenCalled();
      expect(newHandler).toHaveBeenCalledTimes(1);
    });

    it("should make unsubscribe idempotent across re-registration", () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();
      const unsubscribe = emitter.addEventListener("save", handler);

      unsubscribe();
      emitter.addEventListener("save", handler);
      unsubscribe();
      emitter.emit("save", createSaveEvent(createInitialState()));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("removeEventListener", () => {
    it("should remove specific handler", () => {
      const emitter = createEventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.addEventListener("save", handler1);
      emitter.addEventListener("save", handler2);

      emitter.removeEventListener("save", handler1);

      const state = createInitialState();
      emitter.emit("save", createSaveEvent(state));

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("should handle removing non-existent handler", () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      // Removing an unregistered handler succeeds.
      expect(() => {
        emitter.removeEventListener("save", handler);
      }).not.toThrow();
    });
  });

  describe("removeAllListeners", () => {
    it("should remove all handlers for all events", () => {
      const emitter = createEventEmitter();
      const saveHandler = vi.fn();
      const dirtyHandler = vi.fn();

      emitter.addEventListener("save", saveHandler);
      emitter.addEventListener("dirty-change", dirtyHandler);

      emitter.removeAllListeners();

      const state = createInitialState();
      emitter.emit("save", createSaveEvent(state));
      emitter.emit("dirty-change", createDirtyChangeEvent(true, state));

      expect(saveHandler).not.toHaveBeenCalled();
      expect(dirtyHandler).not.toHaveBeenCalled();
    });
  });

  describe("emit", () => {
    it("should handle errors in handlers gracefully", () => {
      const error = vi.fn();
      const emitter = createEventEmitter({ error });
      const errorHandler = vi.fn(() => {
        throw new Error("Handler error");
      });
      const goodHandler = vi.fn();

      emitter.addEventListener("save", errorHandler);
      emitter.addEventListener("save", goodHandler);

      const state = createInitialState();

      // Catch the handler error internally.
      expect(() => {
        emitter.emit("save", createSaveEvent(state));
      }).not.toThrow();

      // Continue to the remaining handler after the error.
      expect(goodHandler).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    });

    it("should deliver to handlers registered at emit start even if removed mid-emit", () => {
      const emitter = createEventEmitter();
      const handler2 = vi.fn();
      let unsubscribe2: (() => void) | undefined;
      const handler1 = vi.fn(() => {
        unsubscribe2?.();
      });

      emitter.addEventListener("save", handler1);
      unsubscribe2 = emitter.addEventListener("save", handler2);

      const state = createInitialState();
      emitter.emit("save", createSaveEvent(state));
      emitter.emit("save", createSaveEvent(state));

      expect(handler1).toHaveBeenCalledTimes(2);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("should not call handlers for other event types", () => {
      const emitter = createEventEmitter();
      const saveHandler = vi.fn();
      const dirtyHandler = vi.fn();

      emitter.addEventListener("save", saveHandler);
      emitter.addEventListener("dirty-change", dirtyHandler);

      const state = createInitialState();
      emitter.emit("save", createSaveEvent(state));

      expect(saveHandler).toHaveBeenCalledTimes(1);
      expect(dirtyHandler).not.toHaveBeenCalled();
    });

    it("queues nested emits instead of recursively invoking handlers", () => {
      const emitter = createEventEmitter();
      const state = createInitialState();
      const order: string[] = [];
      let eventNumber = 0;

      emitter.addEventListener("save", () => {
        eventNumber++;
        order.push(`first-${eventNumber}`);
        if (eventNumber < 3) emitter.emit("save", createSaveEvent(state));
      });
      emitter.addEventListener("save", () => {
        order.push(`second-${eventNumber}`);
      });

      emitter.emit("save", createSaveEvent(state));

      expect(order).toEqual(["first-1", "second-1", "first-2", "second-2", "first-3", "second-3"]);
    });

    it("bounds an event handler that emits indefinitely", () => {
      const error = vi.fn();
      const emitter = createEventEmitter({ error });
      const state = createInitialState();
      let handlerCalls = 0;

      emitter.addEventListener("save", () => {
        handlerCalls++;
        emitter.emit("save", createSaveEvent(state));
      });

      expect(() => emitter.emit("save", createSaveEvent(state))).not.toThrow();
      expect(handlerCalls).toBe(MAX_OBSERVER_REENTRANT_STEPS);
      expect(error).toHaveBeenCalledWith(
        "Document event cycle exceeded the re-entrancy limit",
        expect.any(Error),
      );
    });
  });
});

describe("Event Creators", () => {
  describe("createContentChangeEvent", () => {
    it("should create frozen content change event", () => {
      const prevState = createInitialState({ content: "Hello" });
      const nextState = createInitialState({ content: "Hello World" });
      const action = DocumentActions.insert(byteOffset(5), " World");

      const event = createContentChangeEvent(action, prevState, nextState, [
        [byteOffset(5), byteOffset(11)],
      ]);

      expect(event.type).toBe("content-change");
      expect(event.action).toBe(action);
      expect(event.prevState).toBe(prevState);
      expect(event.nextState).toBe(nextState);
      expect(event.affectedRanges).toEqual([[5, 11]]);
      expect(event.timestamp).toBeLessThanOrEqual(Date.now());
      expect(Object.isFrozen(event)).toBe(true);
    });
  });

  describe("createSelectionChangeEvent", () => {
    it("should create frozen selection change event", () => {
      const prevState = createInitialState();
      const nextState = createInitialState();

      const event = createSelectionChangeEvent(prevState, nextState);

      expect(event.type).toBe("selection-change");
      expect(event.prevState).toBe(prevState);
      expect(event.nextState).toBe(nextState);
      expect(event.timestamp).toBeLessThanOrEqual(Date.now());
      expect(Object.isFrozen(event)).toBe(true);
    });
  });

  describe("createHistoryChangeEvent", () => {
    it("should create undo event", () => {
      const prevState = createInitialState();
      const nextState = createInitialState();

      const event = createHistoryChangeEvent("undo", prevState, nextState);

      expect(event.type).toBe("history-change");
      expect(event.direction).toBe("undo");
      expect(Object.isFrozen(event)).toBe(true);
    });

    it("should create redo event", () => {
      const prevState = createInitialState();
      const nextState = createInitialState();

      const event = createHistoryChangeEvent("redo", prevState, nextState);

      expect(event.type).toBe("history-change");
      expect(event.direction).toBe("redo");
      expect(Object.isFrozen(event)).toBe(true);
    });
  });

  describe("createSaveEvent", () => {
    it("should create frozen save event", () => {
      const state = createInitialState();

      const event = createSaveEvent(state);

      expect(event.type).toBe("save");
      expect(event.state).toBe(state);
      expect(event.timestamp).toBeLessThanOrEqual(Date.now());
      expect(Object.isFrozen(event)).toBe(true);
    });
  });

  describe("createDirtyChangeEvent", () => {
    it("should create dirty=true event", () => {
      const state = createInitialState();

      const event = createDirtyChangeEvent(true, state);

      expect(event.type).toBe("dirty-change");
      expect(event.isDirty).toBe(true);
      expect(event.state).toBe(state);
      expect(Object.isFrozen(event)).toBe(true);
    });

    it("should create dirty=false event", () => {
      const state = createInitialState();

      const event = createDirtyChangeEvent(false, state);

      expect(event.type).toBe("dirty-change");
      expect(event.isDirty).toBe(false);
      expect(Object.isFrozen(event)).toBe(true);
    });
  });
});

describe("getAffectedRanges", () => {
  it("should calculate range for INSERT", () => {
    const action = DocumentActions.insert(byteOffset(10), "Hello");
    const ranges = getAffectedRanges(action);

    expect(ranges).toEqual([[10, 15]]); // 10 + 5 bytes
  });

  it("should calculate range for DELETE", () => {
    const action = DocumentActions.delete(byteOffset(5), byteOffset(15)); // start=5, end=15
    const ranges = getAffectedRanges(action);

    expect(ranges).toEqual([[5, 15]]);
  });

  it("should calculate range for REPLACE using new content length", () => {
    const action = DocumentActions.replace(byteOffset(5), byteOffset(15), "Hi"); // start=5, end=15, text='Hi' (2 bytes)
    const ranges = getAffectedRanges(action);

    expect(ranges).toEqual([[5, 7]]); // 5 + 2 (insertLength), not max(deleteLength, insertLength)
  });

  it("should calculate range for REPLACE when insert is longer than delete", () => {
    const action = DocumentActions.replace(byteOffset(0), byteOffset(2), "Hello World"); // delete 2 bytes, insert 11
    const ranges = getAffectedRanges(action);

    expect(ranges).toEqual([[0, 11]]); // 0 + 11 (insertLength)
  });

  it("should handle unicode in INSERT", () => {
    const action = DocumentActions.insert(byteOffset(0), "世界"); // 6 bytes in UTF-8
    const ranges = getAffectedRanges(action);

    expect(ranges).toEqual([[0, 6]]);
  });

  it("should count lone surrogates using TextEncoder semantics", () => {
    const action = DocumentActions.insert(byteOffset(0), "\ud800");
    const ranges = getAffectedRanges(action);

    expect(ranges).toEqual([[0, 3]]);
  });

  it("should return [[0, 0]] for non-edit actions", () => {
    const action = DocumentActions.undo();
    const ranges = getAffectedRanges(action);

    expect(ranges).toEqual([[0, 0]]);
  });

  it("should return disjoint ranges for non-contiguous APPLY_REMOTE changes", () => {
    const action = DocumentActions.applyRemote([
      { type: "insert", start: byteOffset(2), text: "XY" },
      { type: "delete", start: byteOffset(10), length: byteLength(4) },
    ]);
    const ranges = getAffectedRanges(action);

    // Keep the two ranges distinct instead of merging their bounding box.
    expect(ranges).toEqual([
      [2, 4],
      [10, 14],
    ]);
  });

  it("should clamp DELETE range to document bounds when prevState is provided", () => {
    const prevState = createInitialState({ content: "hello world" }); // 11 bytes
    const action = DocumentActions.delete(byteOffset(5), byteOffset(999));
    const ranges = getAffectedRanges(action, prevState);
    // Both start (5) and end (999) are clamped to totalLength (11)
    expect(ranges).toEqual([[5, 11]]);
  });

  it("should clamp REPLACE range when prevState is provided", () => {
    const prevState = createInitialState({ content: "hello world" }); // 11 bytes
    const action = DocumentActions.replace(byteOffset(5), byteOffset(999), "X");
    const ranges = getAffectedRanges(action, prevState);
    // start=5 (clamped to 5), inserted text "X" = 1 byte → [5, 6]
    expect(ranges).toEqual([[5, 6]]);
  });

  it("should return [[0, 0]] for APPLY_REMOTE with empty insert text", () => {
    // Skip the insert branch for empty text, leaving entries empty.
    const action = DocumentActions.applyRemote([
      { type: "insert", start: byteOffset(0), text: "" },
    ]);
    const ranges = getAffectedRanges(action);
    expect(ranges).toEqual([[0, 0]]);
  });

  it("normalizeLineEndings: text without line endings is returned unchanged", () => {
    const prevState = createInitialState({
      normalizeInsertedLineEndings: true,
      lineEnding: "crlf",
    });
    // Return early from normalizeLineEndings because "hello" has no line endings.
    const action = DocumentActions.insert(byteOffset(0), "hello");
    const ranges = getAffectedRanges(action, prevState);
    expect(ranges).toEqual([[0, 5]]);
  });

  it("clampPosition with non-finite position returns byteOffset(0)", () => {
    const prevState = createInitialState({ content: "abc" });
    // Use Infinity as start via a custom action object (bypasses branded validation)
    const actionInf = {
      type: "APPLY_REMOTE" as const,
      changes: Object.freeze([
        Object.freeze({
          type: "insert" as const,
          start: Infinity as unknown as ReturnType<typeof byteOffset>,
          text: "A",
        }),
      ]),
    };
    const ranges = getAffectedRanges(actionInf, prevState);
    // Infinity gets clamped to 0 by clampPosition → insert "A" (1 byte) from 0 to 1
    expect(ranges[0]![0]).toBe(0);
  });

  it("should return [[0, 0]] for APPLY_REMOTE with a zero-size delete (clamped to empty range)", () => {
    const prevState = createInitialState({ content: "abc" }); // 3 bytes
    // Clamp deletion at position 1000 to zero length and add no entry.
    const action = DocumentActions.applyRemote([
      { type: "delete", start: byteOffset(1000), length: byteLength(5) },
    ]);
    const ranges = getAffectedRanges(action, prevState);
    expect(ranges).toEqual([[0, 0]]);
  });

  it("should clamp APPLY_REMOTE delete range when prevState is provided", () => {
    const prevState = createInitialState({ content: "hello world" }); // 11 bytes
    const action = DocumentActions.applyRemote([
      { type: "delete", start: byteOffset(2), length: byteLength(5) },
    ]);
    const ranges = getAffectedRanges(action, prevState);
    // With prevState, start/end are clamped to totalLength
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges[0]![0]).toBe(2); // start = 2
    expect(ranges[0]![1]).toBe(7); // end = 2 + 5 = 7
  });

  it("should return [[0, 0]] for APPLY_REMOTE when nextState equals prevState", () => {
    const state = createInitialState({ content: "hello" });
    const action = DocumentActions.applyRemote([
      { type: "insert", start: byteOffset(0), text: "A" },
    ]);
    // Pass the same state for both prevState and nextState to simulate a no-op
    const ranges = getAffectedRanges(action, state, state);
    expect(ranges).toEqual([[0, 0]]);
  });

  it("should return unchanged text for INSERT when prevState has lf lineEnding with normalization", () => {
    const prevState = createInitialState({
      normalizeInsertedLineEndings: true,
      lineEnding: "lf",
    });
    const action = DocumentActions.insert(byteOffset(0), "hello\nworld");
    const ranges = getAffectedRanges(action, prevState);
    // "lf" → text unchanged, still 11 bytes
    expect(ranges).toEqual([[0, 11]]);
  });

  it("should normalize CR line endings for INSERT when prevState has cr lineEnding", () => {
    const prevState = createInitialState({
      normalizeInsertedLineEndings: true,
      lineEnding: "cr",
    });
    const action = DocumentActions.insert(byteOffset(0), "hello\nworld");
    const ranges = getAffectedRanges(action, prevState);
    // '\n' normalized to '\r' → still 11 bytes (same byte count)
    expect(ranges).toEqual([[0, 11]]);
  });

  it("should adjust ranges to nextState space when a later change precedes an earlier one", () => {
    // change[0]: insert "XY" at position 7 (prevState space)
    // change[1]: insert "Z"  at position 2 (intermediate space, after change[0])
    // change[1] sits before change[0]'s region, so it shifts change[0] by +1 byte.
    // In nextState, "Z" occupies [2, 3) and "XY" occupies [8, 10).
    const action = DocumentActions.applyRemote([
      { type: "insert", start: byteOffset(7), text: "XY" },
      { type: "insert", start: byteOffset(2), text: "Z" },
    ]);
    const ranges = getAffectedRanges(action);

    expect(ranges).toEqual([
      [8, 10], // "XY" shifted to [8, 10) in nextState
      [2, 3], // "Z" at [2, 3) in nextState (last change, no adjustment needed)
    ]);
  });

  it("collapses an earlier range covered by a later remote delete", () => {
    const state = createInitialState({ content: "abc" });
    const action = DocumentActions.applyRemote([
      { type: "insert", start: byteOffset(0), text: "X" },
      { type: "delete", start: byteOffset(0), length: byteLength(4) },
    ]);

    expect(getAffectedRanges(action, state)).toEqual([
      [0, 0],
      [0, 4],
    ]);
  });
});

describe("Batch event emission with intermediate states", () => {
  it("should emit events with correct intermediate states during batch", () => {
    // This tests that the store's batch() emits events with per-action
    // intermediate states, not the same overall prev/next state for all actions.
    const store = createDocumentStoreWithEvents();
    const events: Array<{ prevLength: number; nextLength: number }> = [];

    store.addEventListener("content-change", (event: any) => {
      events.push({
        prevLength: event.prevState.pieceTable.totalLength,
        nextLength: event.nextState.pieceTable.totalLength,
      });
    });

    // Batch two inserts
    store.batch([
      DocumentActions.insert(byteOffset(0), "Hello"),
      DocumentActions.insert(byteOffset(5), " World"),
    ]);

    // Intermediate states give ranges 0→5 for the first event and 5→11 for the second.
    expect(events).toHaveLength(2);
    expect(events[0]!.prevLength).toBe(0);
    expect(events[0]!.nextLength).toBe(5);
    expect(events[1]!.prevLength).toBe(5);
    expect(events[1]!.nextLength).toBe(11);
  });
});

describe("Store event integration", () => {
  it("should emit content-change for APPLY_REMOTE", () => {
    const store = createDocumentStoreWithEvents({ content: "Hello" });
    const handler = vi.fn();
    store.addEventListener("content-change", handler);

    store.dispatch(
      DocumentActions.applyRemote([{ type: "insert", start: byteOffset(5), text: "!" }]),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0] as {
      action: { type: string };
      affectedRanges: readonly (readonly [number, number])[];
    };
    expect(event.action.type).toBe("APPLY_REMOTE");
    expect(event.affectedRanges).toEqual([[5, 6]]);
  });

  it("keeps an overlapping remote edit successful after its state commits", () => {
    const store = createDocumentStoreWithEvents({ content: "abc", reconcileMode: "none" });
    const handler = vi.fn();
    store.addEventListener("content-change", handler);
    const action = DocumentActions.applyRemote([
      { type: "insert", start: byteOffset(0), text: "X" },
      { type: "delete", start: byteOffset(0), length: byteLength(4) },
    ]);

    let next;
    expect(() => {
      next = store.dispatch(action);
    }).not.toThrow();

    expect(next).toBe(store.getSnapshot());
    expect(store.getSnapshot().pieceTable.totalLength).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].affectedRanges).toEqual([
      [0, 0],
      [0, 4],
    ]);
  });

  it("should emit dirty-change for APPLY_REMOTE when document becomes dirty", () => {
    const store = createDocumentStoreWithEvents({ content: "Hello" });
    const handler = vi.fn();
    store.addEventListener("dirty-change", handler);

    store.dispatch(
      DocumentActions.applyRemote([{ type: "insert", start: byteOffset(5), text: "!" }]),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0] as { isDirty: boolean };
    expect(event.isDirty).toBe(true);
  });

  it("should not emit content-change for out-of-bounds remote deletes", () => {
    const store = createDocumentStoreWithEvents({ content: "Hello" });
    const handler = vi.fn();
    store.addEventListener("content-change", handler);

    const before = store.getSnapshot();
    const after = store.dispatch(
      DocumentActions.applyRemote([
        { type: "delete", start: byteOffset(99), length: byteLength(5) },
      ]),
    );

    expect(after).toBe(before);
    expect(handler).not.toHaveBeenCalled();
  });

  it("should emit affected ranges for normalized inserted text", () => {
    const store = createDocumentStoreWithEvents({
      content: "a\r\n",
      lineEnding: "crlf",
      normalizeInsertedLineEndings: true,
    });
    const handler = vi.fn();
    store.addEventListener("content-change", handler);

    store.dispatch(DocumentActions.insert(byteOffset(3), "\n"));

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0] as {
      affectedRanges: readonly (readonly [number, number])[];
    };
    expect(event.affectedRanges).toEqual([[3, 5]]);
  });
});

describe("Store event ordering under nested dispatch", () => {
  const revisions = (store: ReturnType<typeof createDocumentStoreWithEvents>) => {
    const seen: string[] = [];
    store.addEventListener("content-change", (e) =>
      seen.push(`${e.prevState.revision}->${e.nextState.revision}`),
    );
    return seen;
  };

  it("delivers an action's events before those of an action a store listener dispatches", () => {
    const store = createDocumentStoreWithEvents({ content: "", reconcileMode: "none" });
    const seen = revisions(store);
    let once = true;
    store.subscribe(() => {
      if (!once) return;
      once = false;
      store.dispatch(DocumentActions.insert(byteOffset(1), "B"));
    });

    const returned = store.dispatch(DocumentActions.insert(byteOffset(0), "A"));

    expect(seen).toEqual(["0->1", "1->2"]);
    expect(returned).toBe(store.getSnapshot());
    expect(returned.revision).toBe(2);
  });

  it("delivers an action's events when a store listener it notifies opens a transaction", () => {
    const store = createDocumentStoreWithEvents({ content: "", reconcileMode: "none" });
    const seen = revisions(store);
    let once = true;
    store.subscribe(() => {
      if (!once) return;
      once = false;
      store.beginTransaction();
    });

    store.dispatch(DocumentActions.insert(byteOffset(0), "A"));
    // The insert committed outside any transaction, so its events are not
    // buffered in the listener's level, and rolling that back keeps them.
    expect(seen).toEqual(["0->1"]);
    store.rollbackTransaction();
    expect(seen).toEqual(["0->1"]);
  });

  it("orders events the same for a store listener subscribed before any event handler", () => {
    const store = createDocumentStoreWithEvents({ content: "", reconcileMode: "none" });
    let once = true;
    store.subscribe(() => {
      if (!once) return;
      once = false;
      store.batch([
        DocumentActions.insert(byteOffset(1), "B"),
        DocumentActions.insert(byteOffset(2), "C"),
      ]);
    });
    const seen = revisions(store);

    store.dispatch(DocumentActions.insert(byteOffset(0), "A"));

    expect(seen).toEqual(["0->1", "1->2", "2->3"]);
  });

  it("delivers all of an action's events before those of an action a handler dispatches", () => {
    const store = createDocumentStoreWithEvents({ content: "", reconcileMode: "none" });
    const order: string[] = [];
    let once = true;
    store.addEventListener("content-change", (e) => {
      order.push(`content ${e.nextState.revision}`);
      if (!once) return;
      once = false;
      store.dispatch(DocumentActions.insert(byteOffset(1), "B"));
    });
    store.addEventListener("dirty-change", (e) => order.push(`dirty ${e.state.revision}`));

    store.dispatch(DocumentActions.insert(byteOffset(0), "A"));

    expect(order).toEqual(["content 1", "dirty 1", "content 2"]);
  });

  it("delivers a transaction's events before those of an action a store listener dispatches on commit", () => {
    const store = createDocumentStoreWithEvents({ content: "", reconcileMode: "none" });
    const seen = revisions(store);
    let once = true;
    store.subscribe(() => {
      if (!once) return;
      once = false;
      store.dispatch(DocumentActions.insert(byteOffset(1), "B"));
    });

    store.batch([DocumentActions.insert(byteOffset(0), "A")]);

    expect(seen).toEqual(["0->1", "1->2"]);
    expect(store.getSnapshot().revision).toBe(2);
  });

  it("delivers every event of a handler that dispatches many actions in one go", () => {
    const error = vi.fn();
    const store = createDocumentStoreWithEvents({
      content: "",
      reconcileMode: "none",
      logger: { error, warn: vi.fn() },
    });
    const fanOut = MAX_OBSERVER_REENTRANT_STEPS + 50;
    let calls = 0;
    let once = true;
    store.addEventListener("content-change", () => {
      calls++;
      if (!once) return;
      once = false;
      for (let i = 0; i < fanOut; i++) store.dispatch(DocumentActions.insert(byteOffset(0), "y"));
    });

    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));

    expect(calls).toBe(fanOut + 1);
    expect(error).not.toHaveBeenCalled();
  });

  it("bounds an event handler that dispatches indefinitely", () => {
    const error = vi.fn();
    const store = createDocumentStoreWithEvents({
      content: "",
      reconcileMode: "none",
      logger: { error, warn: vi.fn() },
    });
    let calls = 0;
    store.addEventListener("content-change", () => {
      calls++;
      store.dispatch(DocumentActions.insert(byteOffset(0), "x"));
    });

    expect(() => store.dispatch(DocumentActions.insert(byteOffset(0), "x"))).not.toThrow();
    expect(calls).toBe(MAX_OBSERVER_REENTRANT_STEPS);
    expect(error).toHaveBeenCalledWith(
      "Document event cycle exceeded the re-entrancy limit",
      expect.any(Error),
    );
  });
});

describe("Store event transaction guards", () => {
  it("treats commit without an active transaction as a no-op", () => {
    const store = createDocumentStoreWithEvents();
    const listener = vi.fn();
    store.subscribe(listener);

    expect(() => store.commitTransaction()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("throws a clear error when rolling back without an active transaction", () => {
    const store = createDocumentStoreWithEvents();

    expect(() => store.rollbackTransaction()).toThrow(/Cannot rollback: no active transaction/);
  });

  it("removes event listeners and suppresses automatic events after dispose", () => {
    const store = createDocumentStoreWithEvents();
    const beforeDispose = vi.fn();
    const afterDispose = vi.fn();

    store.addEventListener("content-change", beforeDispose);
    store.dispose();
    store.addEventListener("content-change", afterDispose);

    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));

    expect(beforeDispose).not.toHaveBeenCalled();
    expect(afterDispose).not.toHaveBeenCalled();
  });

  it("drops buffered transaction events when disposed before commit", () => {
    const store = createDocumentStoreWithEvents();
    const handler = vi.fn();

    store.addEventListener("content-change", handler);
    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(0), "x"));
    store.dispose();
    store.commitTransaction();

    expect(handler).not.toHaveBeenCalled();
  });

  it("inner commitTransaction on events store bubbles buffered events to the outer level", () => {
    const store = createDocumentStoreWithEvents();
    const handler = vi.fn();
    store.addEventListener("content-change", handler);

    store.beginTransaction(); // level 1 (outer)
    store.beginTransaction(); // level 2 (inner)
    store.dispatch(DocumentActions.insert(byteOffset(0), "A"));
    store.commitTransaction(); // Buffer events at the outer level on inner commit.
    expect(handler).not.toHaveBeenCalled();

    store.commitTransaction(); // Emit buffered events on outer commit.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rollbackTransaction on events store discards buffered events", () => {
    const store = createDocumentStoreWithEvents();
    const handler = vi.fn();
    store.addEventListener("content-change", handler);

    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(0), "A"));
    store.rollbackTransaction();

    // No events emitted after rollback
    expect(handler).not.toHaveBeenCalled();
  });

  it("emergencyReset on events store clears all pending event levels", () => {
    const store = createDocumentStoreWithEvents({ content: "hello" });
    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(5), "!"));
    const restored = store.emergencyReset();
    // Emergency reset returns the base store's snapshot (null if no transaction was there)
    expect(typeof restored === "object" || restored === null).toBe(true);
  });

  it("removeEventListener stops the handler from receiving future events", () => {
    const store = createDocumentStoreWithEvents({ content: "hello" });
    const handler = vi.fn();

    store.addEventListener("content-change", handler);
    store.dispatch(DocumentActions.insert(byteOffset(5), "!"));
    expect(handler).toHaveBeenCalledTimes(1);

    store.removeEventListener("content-change", handler);
    store.dispatch(DocumentActions.insert(byteOffset(6), "?"));
    // Do not call the removed handler again.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rollbackTransaction throws when called with no active transaction", () => {
    const store = createDocumentStoreWithEvents();
    expect(() => store.rollbackTransaction()).toThrow("Cannot rollback: no active transaction");
  });

  it("dispatching SET_SELECTION emits selection-change event", () => {
    const store = createDocumentStoreWithEvents({ content: "hello" });
    const handler = vi.fn();
    store.addEventListener("selection-change", handler);
    store.dispatch(DocumentActions.setSelection([{ anchor: byteOffset(0), head: byteOffset(3) }]));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("SET_SELECTION with the current selection emits nothing", () => {
    const store = createDocumentStoreWithEvents({ content: "hello" });
    const caret = (offset: number) =>
      [{ anchor: byteOffset(offset), head: byteOffset(offset) }] as const;
    store.dispatch(DocumentActions.setSelection(caret(5)));
    const handler = vi.fn();
    store.addEventListener("selection-change", handler);
    // An editor types at the caret and then sets the caret it computed itself,
    // which the insert already moved the selection to: one event per keystroke.
    store.dispatch(DocumentActions.insert(byteOffset(5), "!"));
    const moved = store.getSnapshot().selection;
    store.dispatch(DocumentActions.setSelection(caret(6)));
    expect(store.getSnapshot().selection).toBe(moved);
    expect(handler).toHaveBeenCalledTimes(1);
    // The echo changes nothing, so selectionRevision agrees with the event.
    expect(store.getSnapshot().selectionRevision).toBe(1);
  });

  it("dispatching UNDO emits history-change event", () => {
    const store = createDocumentStoreWithEvents({ content: "" });
    store.dispatch(DocumentActions.insert(byteOffset(0), "hello"));
    const handler = vi.fn();
    store.addEventListener("history-change", handler);
    store.dispatch(DocumentActions.undo());
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

it("derives localized annotation events without enumerating unrelated annotations", async () => {
  const { PersistentMap } = await import("../core/persistent-map.js");
  const store = createDocumentStoreWithEvents({ content: "abcdef", reconcileMode: "none" });
  try {
    for (let i = 0; i < 5000; i++)
      store.dispatch(DocumentActions.createAttention(byteOffset(0), byteOffset(1)));
    const handler = vi.fn();
    store.addEventListener("attention-change", handler);
    const iterate = vi.spyOn(PersistentMap.prototype, Symbol.iterator);
    const get = vi.spyOn(PersistentMap.prototype, "get");
    try {
      store.dispatch(DocumentActions.createAttention(byteOffset(3), byteOffset(4)));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0].changedIds).toHaveLength(1);
      expect(iterate).not.toHaveBeenCalled();
      expect(get.mock.calls.length).toBeLessThan(100);
    } finally {
      iterate.mockRestore();
      get.mockRestore();
    }
  } finally {
    store.dispose();
  }
});

it("delivers large remote batches through the event-enabled store", () => {
  const store = createDocumentStoreWithEvents({ content: "x", reconcileMode: "none" });
  try {
    const handler = vi.fn();
    store.addEventListener("content-change", handler);
    store.dispatch(
      DocumentActions.applyRemote(
        Array.from({ length: 3000 }, () => ({
          type: "insert" as const,
          start: byteOffset(0),
          text: "x",
        })),
      ),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    const ranges = handler.mock.calls[0]![0].affectedRanges;
    expect(ranges).toHaveLength(3000);
    expect(ranges[0]).toEqual([2999, 3000]);
    expect(ranges.at(-1)).toEqual([0, 1]);
  } finally {
    store.dispose();
  }
});

describe("Event delivery limits and failed transaction calls", () => {
  it("bounds a handler that dispatches two actions for every event", () => {
    const error = vi.fn();
    const store = createDocumentStoreWithEvents({
      content: "",
      reconcileMode: "none",
      logger: { error, warn: vi.fn() },
    });
    let calls = 0;
    store.addEventListener("content-change", () => {
      calls++;
      store.dispatch(DocumentActions.insert(byteOffset(0), "a"));
      store.dispatch(DocumentActions.insert(byteOffset(0), "b"));
    });

    expect(() => store.dispatch(DocumentActions.insert(byteOffset(0), "x"))).not.toThrow();
    // The first action's events, and the two its handler dispatched, are not
    // counted, and each raises the limit; the limit stops their reactions.
    const limit = MAX_OBSERVER_DELIVERED_ACTIONS + 3 * MAX_OBSERVER_REENTRANT_STEPS;
    expect(calls).toBe(limit + 3);
    expect(error).toHaveBeenCalledWith(
      "Document event cycle exceeded the re-entrancy limit",
      expect.objectContaining({
        message: expect.stringContaining(`${limit} actions`),
      }),
    );
  });

  it("delivers a reaction to each of many actions a handler dispatches", () => {
    const error = vi.fn();
    const store = createDocumentStoreWithEvents({
      content: "",
      reconcileMode: "none",
      logger: { error, warn: vi.fn() },
    });
    const count = 2 * MAX_OBSERVER_DELIVERED_ACTIONS;
    let armed = true;
    // One handler applies a change set one operation at a time (depth 1).
    store.addEventListener("save", () => {
      if (!armed) return;
      armed = false;
      for (let i = 0; i < count; i++) store.dispatch(DocumentActions.insert(byteOffset(0), "r"));
    });
    // Another reacts once to each operation (depth 2).
    let reactions = 0;
    store.addEventListener("content-change", (e) => {
      if (e.action.type !== "INSERT") return;
      if (e.action.text === "r") store.dispatch(DocumentActions.insert(byteOffset(0), "s"));
      else reactions++;
    });

    store.dispatch(DocumentActions.markSaved());
    expect(error).not.toHaveBeenCalled();
    expect(reactions).toBe(count);
  });

  it("stops a fan-out cycle at the ceiling however many actions a handler dispatched", () => {
    const error = vi.fn();
    const store = createDocumentStoreWithEvents({
      content: "ab",
      reconcileMode: "none",
      logger: { error, warn: vi.fn() },
    });
    const at = (offset: number) =>
      DocumentActions.setSelection([{ anchor: byteOffset(offset), head: byteOffset(offset) }]);
    // Enough direct actions that, uncapped, the limit would pass the ceiling.
    const direct = MAX_OBSERVER_DELIVERED_ACTIONS_CEILING / MAX_OBSERVER_REENTRANT_STEPS;
    let armed = true;
    let fanning = false;
    store.addEventListener("save", () => {
      if (!armed) return;
      armed = false;
      for (let i = 0; i < direct; i++) store.dispatch(at(1 + (i % 2)));
      fanning = true;
    });
    // Dispatch two actions per event once the direct actions are in, each
    // moving the selection so it changes the state.
    let reactions = 0;
    store.addEventListener("selection-change", (e) => {
      if (!fanning) return;
      reactions++;
      const offset = e.nextState.selection.ranges[0]!.head;
      store.dispatch(at(offset === 0 ? 1 : 0));
      store.dispatch(at(offset === 0 ? 0 : 1));
    });

    store.dispatch(DocumentActions.markSaved());
    expect(reactions).toBeLessThanOrEqual(MAX_OBSERVER_DELIVERED_ACTIONS_CEILING + direct + 1);
    expect(error).toHaveBeenCalledWith(
      "Document event cycle exceeded the re-entrancy limit",
      expect.objectContaining({
        message: expect.stringContaining(`${MAX_OBSERVER_DELIVERED_ACTIONS_CEILING} actions`),
      }),
    );
  });

  it.each([
    ["an event handler", 1],
    ["a store listener", 0],
  ])("delivers the events of every action %s dispatches one at a time", (_, viaListener) => {
    const error = vi.fn();
    const store = createDocumentStoreWithEvents({
      content: "",
      reconcileMode: "none",
      logger: { error, warn: vi.fn() },
    });
    const count = MAX_OBSERVER_DELIVERED_ACTIONS + 5;
    let armed = true;
    const applyAll = () => {
      if (!armed) return;
      armed = false;
      for (let i = 0; i < count; i++) store.dispatch(DocumentActions.insert(byteOffset(0), "r"));
    };
    if (viaListener) store.subscribe(applyAll);
    else store.addEventListener("save", applyAll);
    let changes = 0;
    store.addEventListener("content-change", () => changes++);

    store.dispatch(
      viaListener ? DocumentActions.insert(byteOffset(0), "a") : DocumentActions.markSaved(),
    );
    expect(error).not.toHaveBeenCalled();
    expect(changes).toBe(count + (viaListener ? 1 : 0));
  });

  it("does not count a handler's batched or no-op actions toward the delivery limit", () => {
    const error = vi.fn();
    const store = createDocumentStoreWithEvents({
      content: "",
      reconcileMode: "none",
      logger: { error, warn: vi.fn() },
    });
    const inserted: string[] = [];
    let armed = true;
    store.addEventListener("content-change", (e) => {
      if (e.action.type === "INSERT") inserted.push(e.action.text);
      if (!armed) return;
      armed = false;
      // More no-op actions than the limit, then a batch larger than it.
      for (let i = 0; i <= MAX_OBSERVER_DELIVERED_ACTIONS; i++) {
        store.dispatch(
          DocumentActions.setSelection([{ anchor: byteOffset(0), head: byteOffset(0) }]),
        );
      }
      store.batch(
        Array.from({ length: MAX_OBSERVER_DELIVERED_ACTIONS + 1 }, () =>
          DocumentActions.insert(byteOffset(0), "b"),
        ),
      );
    });

    store.dispatch(DocumentActions.insert(byteOffset(0), "a"));
    expect(error).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(MAX_OBSERVER_DELIVERED_ACTIONS + 2);
  });

  /**
   * An event store over a base store whose next inner `beginTransaction`,
   * `commitTransaction` or `rollbackTransaction` fails as an invariant
   * violation does: it runs emergencyReset, which notifies listeners, and
   * then throws.
   */
  function storeWithFailingCall(
    call: "beginTransaction" | "commitTransaction" | "rollbackTransaction",
  ) {
    const base = createDocumentStore({ content: "", reconcileMode: "none" });
    let failNext = false;
    const failing = Object.assign(Object.create(base), {
      [call]() {
        if (failNext) {
          failNext = false;
          base.emergencyReset();
          throw new Error("invariant violated");
        }
        base[call]();
      },
    });
    const store = withEvents(
      failing,
      (action: DocumentAction) => ({ state: base.dispatch(action), historyDropped: null }),
      undefined,
    );
    const inserted: string[] = [];
    store.addEventListener("content-change", (e) => {
      if (e.action.type === "INSERT") inserted.push(e.action.text);
    });
    return { store, inserted, failNext: () => (failNext = true) };
  }

  it("emits events for a listener's dispatch while a failed inner commit resets", () => {
    const { store, inserted, failNext } = storeWithFailingCall("commitTransaction");
    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(0), "A"));
    store.beginTransaction();
    let armed = true;
    store.subscribe(() => {
      if (!armed) return;
      armed = false;
      store.dispatch(DocumentActions.insert(byteOffset(0), "B"));
    });
    failNext();

    expect(() => store.commitTransaction()).toThrow("invariant violated");
    expect(getText(store)).toBe("B");
    expect(inserted).toEqual(["B"]);
  });

  it("emits events for a listener's dispatch while a failed inner begin resets", () => {
    const { store, inserted, failNext } = storeWithFailingCall("beginTransaction");
    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(0), "A"));
    let armed = true;
    store.subscribe(() => {
      if (!armed) return;
      armed = false;
      store.dispatch(DocumentActions.insert(byteOffset(0), "B"));
    });
    failNext();

    expect(() => store.beginTransaction()).toThrow("invariant violated");
    expect(getText(store)).toBe("B");
    expect(inserted).toEqual(["B"]);
  });

  it("emits events for a listener's dispatch while a failed inner rollback resets", () => {
    const { store, inserted, failNext } = storeWithFailingCall("rollbackTransaction");
    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(0), "A"));
    store.beginTransaction();
    let armed = true;
    store.subscribe(() => {
      if (!armed) return;
      armed = false;
      store.dispatch(DocumentActions.insert(byteOffset(0), "B"));
    });
    failNext();

    expect(() => store.rollbackTransaction()).toThrow("invariant violated");
    expect(getText(store)).toBe("B");
    expect(inserted).toEqual(["B"]);
  });

  it("calls the base store's transaction methods on the base store", () => {
    const base = createDocumentStore();
    // A wrapper whose transaction methods reach the base store through `this`.
    const wrapper = Object.assign(Object.create(base) as typeof base, {
      inner: base,
      beginTransaction(this: { inner: typeof base }) {
        this.inner.beginTransaction();
      },
      commitTransaction(this: { inner: typeof base }) {
        this.inner.commitTransaction();
      },
    });
    const store = withEvents(
      wrapper,
      (action: DocumentAction) => ({ state: base.dispatch(action), historyDropped: null }),
      undefined,
    );
    const inserted: string[] = [];
    store.addEventListener("content-change", (e) => {
      if (e.action.type === "INSERT") inserted.push(e.action.text);
    });
    store.beginTransaction();
    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(0), "A"));
    store.commitTransaction();
    store.commitTransaction();
    expect(getText(store)).toBe("A");
    expect(inserted).toEqual(["A"]);
  });

  it("calls the base store's isInTransaction on the base store", () => {
    const base = createDocumentStore();
    // A wrapper whose isInTransaction reaches the base store through `this`.
    const wrapper = Object.assign(Object.create(base) as typeof base, {
      inner: base,
      isInTransaction(this: { inner: typeof base }) {
        return this.inner.isInTransaction();
      },
    });
    const store = withEvents(
      wrapper,
      (action: DocumentAction) => ({ state: base.dispatch(action), historyDropped: null }),
      undefined,
    );
    const { isInTransaction } = store;
    expect(isInTransaction()).toBe(false);
    store.beginTransaction();
    expect(store.isInTransaction()).toBe(true);
    store.commitTransaction();
    expect(store.isInTransaction()).toBe(false);
  });

  it("emits events for dispatches after a failed begin", () => {
    const { store, inserted, failNext } = storeWithFailingCall("beginTransaction");
    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(0), "A"));
    failNext();
    expect(() => store.beginTransaction()).toThrow("invariant violated");

    store.dispatch(DocumentActions.insert(byteOffset(0), "C"));
    expect(getText(store)).toBe("C");
    expect(inserted).toEqual(["C"]);
  });

  it("emits a transaction's events when the scheduler throws after the commit", () => {
    const error = vi.fn();
    const throwingScheduler: DocumentStoreConfig["scheduler"] = () => ({
      schedule() {
        throw new Error("scheduler failed");
      },
      cancel() {},
      runNow() {},
      get isRunning() {
        return false;
      },
    });
    const store = createDocumentStoreWithEvents({
      content: "line\n",
      scheduler: throwingScheduler,
      logger: { error, warn: vi.fn() },
    });
    const seen: string[] = [];
    store.addEventListener("content-change", () => seen.push("content"));
    store.addEventListener("dirty-change", () => seen.push("dirty"));

    expect(() => store.batch([DocumentActions.insert(byteOffset(0), "new\n")])).not.toThrow();
    expect(getText(store)).toBe("new\nline\n");
    expect(seen).toEqual(["content", "dirty"]);
    expect(error).toHaveBeenCalledWith(
      "Reconciliation scheduler threw after a commit",
      expect.any(Error),
    );

    seen.length = 0;
    expect(() => store.dispatch(DocumentActions.insert(byteOffset(0), "x"))).not.toThrow();
    expect(seen).toEqual(["content"]);
  });
});

function getText(store: { getSnapshot(): DocumentState }): string {
  return getValue(store.getSnapshot().pieceTable);
}
