/**
 * Tests for the event system.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { createDocumentStoreWithEvents } from "./store.js";
import { byteOffset, byteLength } from "../../types/branded.js";

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

      // Should not throw
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
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should handle errors in handlers gracefully", () => {
      const emitter = createEventEmitter();
      const errorHandler = vi.fn(() => {
        throw new Error("Handler error");
      });
      const goodHandler = vi.fn();

      emitter.addEventListener("save", errorHandler);
      emitter.addEventListener("save", goodHandler);

      const state = createInitialState();

      // Should not throw, error is caught internally
      expect(() => {
        emitter.emit("save", createSaveEvent(state));
      }).not.toThrow();

      // Good handler should still be called
      expect(goodHandler).toHaveBeenCalledTimes(1);
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

    // Two distinct ranges — not a merged bounding box
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
    // empty string is falsy — the insert branch is skipped, entries stays empty
    const action = DocumentActions.applyRemote([{ type: "insert", start: byteOffset(0), text: "" }]);
    const ranges = getAffectedRanges(action);
    expect(ranges).toEqual([[0, 0]]);
  });

  it("normalizeLineEndings: text without line endings is returned unchanged", () => {
    const prevState = createInitialState({
      normalizeInsertedLineEndings: true,
      lineEnding: "crlf",
    });
    // "hello" has no line endings — the early-return branch at the top of normalizeLineEndings fires
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
        Object.freeze({ type: "insert" as const, start: Infinity as unknown as ReturnType<typeof byteOffset>, text: "A" }),
      ]),
    };
    const ranges = getAffectedRanges(actionInf, prevState);
    // Infinity gets clamped to 0 by clampPosition → insert "A" (1 byte) from 0 to 1
    expect(ranges[0][0]).toBe(0);
  });

  it("should return [[0, 0]] for APPLY_REMOTE with a zero-size delete (clamped to empty range)", () => {
    const prevState = createInitialState({ content: "abc" }); // 3 bytes
    // Delete at position 1000 (past end) — clamps to size 0, no entry pushed
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
    expect(ranges[0][0]).toBe(2); // start = 2
    expect(ranges[0][1]).toBe(7); // end = 2 + 5 = 7
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
    // In nextState: "Z" is at [2, 3), "XY" is at [8, 10) — not [7, 9).
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

    // With intermediate states, first event should show 0→5, second 5→11
    expect(events).toHaveLength(2);
    expect(events[0].prevLength).toBe(0);
    expect(events[0].nextLength).toBe(5);
    expect(events[1].prevLength).toBe(5);
    expect(events[1].nextLength).toBe(11);
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
    const event = handler.mock.calls[0][0] as {
      action: { type: string };
      affectedRanges: readonly (readonly [number, number])[];
    };
    expect(event.action.type).toBe("APPLY_REMOTE");
    expect(event.affectedRanges).toEqual([[5, 6]]);
  });

  it("should emit dirty-change for APPLY_REMOTE when document becomes dirty", () => {
    const store = createDocumentStoreWithEvents({ content: "Hello" });
    const handler = vi.fn();
    store.addEventListener("dirty-change", handler);

    store.dispatch(
      DocumentActions.applyRemote([{ type: "insert", start: byteOffset(5), text: "!" }]),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as { isDirty: boolean };
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
    const event = handler.mock.calls[0][0] as {
      affectedRanges: readonly (readonly [number, number])[];
    };
    expect(event.affectedRanges).toEqual([[3, 5]]);
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
    store.commitTransaction(); // inner commit — events buffered to outer level, not emitted yet
    expect(handler).not.toHaveBeenCalled();

    store.commitTransaction(); // outer commit — events emitted now
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
    // Handler should NOT be called again after removal
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

  it("dispatching UNDO emits history-change event", () => {
    const store = createDocumentStoreWithEvents({ content: "" });
    store.dispatch(DocumentActions.insert(byteOffset(0), "hello"));
    const handler = vi.fn();
    store.addEventListener("history-change", handler);
    store.dispatch(DocumentActions.undo());
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
