/**
 * Tests for `EventOrigin`: which action produced an event, which other events
 * that action emits, and which transaction it was dispatched in.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createHistoryDropEvent,
  createAttentionChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  createStoreEventEmitter,
  type AnyDocumentEvent,
  type DocumentEventMap,
  type DocumentEventEmitter,
  type SaveEvent,
  type EventOrigin,
  type StoreEvent,
} from "./events.js";
import { createInitialState } from "../core/state.js";
import { DocumentActions } from "./actions.js";
import { createDocumentStoreWithEvents } from "./store.js";
import type { DocumentAction } from "../../types/actions.js";
import type { DocumentStoreWithEvents } from "../../types/store.js";
import { byteOffset, type AttentionID } from "../../types/branded.js";

const EVENT_TYPES: readonly (keyof DocumentEventMap)[] = [
  "content-change",
  "selection-change",
  "history-change",
  "history-drop",
  "attention-change",
  "save",
  "dirty-change",
];

/** Record every event the store emits. */
function record(store: DocumentStoreWithEvents): StoreEvent<AnyDocumentEvent>[] {
  const events: StoreEvent<AnyDocumentEvent>[] = [];
  for (const type of EVENT_TYPES) {
    store.addEventListener(type, (event) => events.push(event));
  }
  return events;
}

const enc = (text: string) => new TextEncoder().encode(text);

const caret = (offset: number) =>
  [{ anchor: byteOffset(offset), head: byteOffset(offset) }] as const;

/** Dispatch `action` and return the events it emitted. */
function eventsOf(
  store: DocumentStoreWithEvents,
  action: DocumentAction,
): StoreEvent<AnyDocumentEvent>[] {
  const events = record(store);
  store.dispatch(action);
  return events;
}

/** The single origin shared by `events`, failing if they do not share one. */
function sharedOrigin(events: readonly StoreEvent<AnyDocumentEvent>[]): EventOrigin {
  const origin = events[0]?.origin;
  expect(origin).toBeDefined();
  for (const event of events) expect(event.origin).toBe(origin);
  return origin!;
}

describe("EventOrigin on store events", () => {
  it("lists every event type the action emits, in delivery order", () => {
    const store = createDocumentStoreWithEvents({ content: "hello world" });
    store.dispatch(DocumentActions.setSelection(caret(5)));
    const action = DocumentActions.insert(byteOffset(5), "!!");

    const events = eventsOf(store, action);
    const origin = sharedOrigin(events);

    expect(events.map((e) => e.type)).toEqual([
      "content-change",
      "selection-change",
      "dirty-change",
    ]);
    expect(origin.types).toEqual(events.map((e) => e.type));
    expect(origin.action).toBe(action);
    expect(origin.transactionId).toBeNull();
    expect(Object.isFrozen(origin)).toBe(true);
    expect(Object.isFrozen(origin.types)).toBe(true);
  });

  it("lets a selection-change handler see events delivered after it", () => {
    const store = createDocumentStoreWithEvents({ content: "hello world" });
    store.dispatch(DocumentActions.setSelection(caret(5)));
    store.dispatch(DocumentActions.insert(byteOffset(5), "!!"));

    let seen: readonly string[] | undefined;
    store.addEventListener("selection-change", (e) => {
      seen = e.origin.types;
    });
    store.dispatch(DocumentActions.undo());

    // history-change is delivered after selection-change.
    expect(seen).toEqual(["selection-change", "history-change"]);
  });

  it.each<[string, (store: DocumentStoreWithEvents) => DocumentAction, string[]]>([
    ["SET_SELECTION", () => DocumentActions.setSelection(caret(3)), ["selection-change"]],
    [
      "INSERT after the caret",
      (store) => {
        store.dispatch(DocumentActions.insert(byteOffset(0), "x"));
        return DocumentActions.insert(byteOffset(12), "y");
      },
      ["content-change"],
    ],
    [
      "UNDO that leaves the selection in place",
      (store) => {
        store.dispatch(DocumentActions.insert(byteOffset(11), "y"));
        return DocumentActions.undo();
      },
      ["history-change"],
    ],
    [
      "MARK_SAVED",
      (store) => {
        store.dispatch(DocumentActions.insert(byteOffset(11), "y"));
        return DocumentActions.markSaved();
      },
      ["save", "dirty-change"],
    ],
    [
      "APPLY_REMOTE before the caret",
      (store) => {
        store.dispatch(DocumentActions.setSelection(caret(5)));
        store.dispatch(DocumentActions.insert(byteOffset(11), "y"));
        return DocumentActions.applyRemote([{ type: "insert", start: byteOffset(0), text: "zz" }]);
      },
      ["content-change", "selection-change", "history-drop"],
    ],
    [
      "HISTORY_CLEAR",
      (store) => {
        store.dispatch(DocumentActions.insert(byteOffset(11), "y"));
        return DocumentActions.historyClear();
      },
      ["history-drop"],
    ],
    [
      "CREATE_ATTENTION",
      () => DocumentActions.createAttention(byteOffset(0), byteOffset(2)),
      ["attention-change"],
    ],
    [
      "DELETE before the caret",
      (store) => {
        store.dispatch(DocumentActions.setSelection(caret(11)));
        return DocumentActions.delete(byteOffset(0), byteOffset(2));
      },
      ["content-change", "selection-change", "dirty-change"],
    ],
    [
      "REPLACE",
      () => DocumentActions.replace(byteOffset(0), byteOffset(2), "XYZ"),
      ["content-change", "selection-change", "dirty-change"],
    ],
    [
      "REDO",
      (store) => {
        store.dispatch(DocumentActions.replace(byteOffset(0), byteOffset(2), "XYZ"));
        store.dispatch(DocumentActions.undo());
        return DocumentActions.redo();
      },
      ["selection-change", "history-change"],
    ],
    [
      "DELETE_ATTENTION",
      (store) => {
        let id: AttentionID | undefined;
        const unsubscribe = store.addEventListener("attention-change", (e) => {
          id = e.changedIds[0];
        });
        store.dispatch(DocumentActions.createAttention(byteOffset(0), byteOffset(2)));
        unsubscribe();
        return DocumentActions.deleteAttention(id!);
      },
      ["attention-change"],
    ],
  ])("reports the events of %s", (_label, setup, expected) => {
    const store = createDocumentStoreWithEvents({ content: "hello world" });
    const action = setup(store);
    const events = eventsOf(store, action);
    const origin = sharedOrigin(events);

    expect(events.map((e) => e.type)).toEqual(expected);
    expect(origin.types).toEqual(expected);
    expect(origin.action).toBe(action);
  });

  it("names the chunk load that moved the selection", () => {
    const store = createDocumentStoreWithEvents({
      chunkSize: 8,
      totalFileSize: 16,
      reconcileMode: "none",
    });
    store.dispatch(DocumentActions.loadChunk(1, enc("BBBBBBB\n")));
    store.dispatch(DocumentActions.setSelection(caret(2)));

    const events = eventsOf(store, DocumentActions.loadChunk(0, enc("AAAAAAA\n")));
    const origin = sharedOrigin(events);

    expect(origin.types).toEqual(["selection-change"]);
    expect(origin.action.type).toBe("LOAD_CHUNK");
  });

  it.each<[string, (store: DocumentStoreWithEvents) => DocumentAction, string[]]>([
    [
      "LOAD_CHUNKS that shifts the selection",
      (store) => {
        store.dispatch(DocumentActions.loadChunk(1, enc("bbbbbbbb")));
        store.dispatch(DocumentActions.setSelection(caret(3)));
        return DocumentActions.loadChunks([{ chunkIndex: 0, data: enc("aaaaaaaa") }]);
      },
      ["selection-change"],
    ],
    [
      "EVICT_CHUNKS that discards history",
      (store) => {
        store.dispatch(DocumentActions.loadChunk(0, enc("aaaaaaaa")));
        store.dispatch(DocumentActions.loadChunk(1, enc("bbbbbbbb")));
        store.dispatch(DocumentActions.insert(byteOffset(2), "X"));
        store.dispatch(DocumentActions.undo());
        store.dispatch(DocumentActions.setSelection(caret(3)));
        return DocumentActions.evictChunks([0], 1);
      },
      ["selection-change", "history-drop"],
    ],
  ])("reports the events of %s", (_label, setup, expected) => {
    const store = createDocumentStoreWithEvents({
      chunkSize: 8,
      totalFileSize: 16,
      historyEvictionPolicy: "pin-bounded",
      reconcileMode: "none",
    });
    const action = setup(store);
    const events = eventsOf(store, action);
    const origin = sharedOrigin(events);

    expect(events.map((e) => e.type)).toEqual(expected);
    expect(origin.types).toEqual(expected);
    expect(origin.action).toBe(action);
  });

  it("gives each action a larger id", () => {
    const store = createDocumentStoreWithEvents({ content: "abc" });
    const events = record(store);
    store.dispatch(DocumentActions.setSelection(caret(1)));
    store.dispatch(DocumentActions.insert(byteOffset(1), "x"));
    store.dispatch(DocumentActions.setSelection(caret(0)));

    const ids = events.map((e) => e.origin.id);
    // The insert emits three events with one id.
    expect(ids[1]).toBe(ids[2]);
    expect(ids[2]).toBe(ids[3]);
    expect(ids[0]).toBeLessThan(ids[1]!);
    expect(ids[3]).toBeLessThan(ids[4]!);
  });

  it("skips the id of an action that emits nothing or that no handler hears", () => {
    const store = createDocumentStoreWithEvents({ content: "abc" });
    store.dispatch(DocumentActions.setSelection(caret(1))); // unheard
    const events = record(store);
    store.dispatch(DocumentActions.setSelection(caret(1))); // unchanged: no events
    store.dispatch(DocumentActions.setSelection(caret(2)));

    expect(events).toHaveLength(1);
    expect(events[0]!.origin.id).toBe(3);
  });

  it("gives an action a store listener dispatches a later id", () => {
    const store = createDocumentStoreWithEvents({ content: "abc" });
    const events = record(store);
    let reacted = false;
    store.subscribe(() => {
      if (reacted) return;
      reacted = true;
      store.dispatch(DocumentActions.setSelection(caret(1)));
    });
    // The caret starts at 0, so an insert at 3 leaves it in place.
    store.dispatch(DocumentActions.insert(byteOffset(3), "d"));

    expect(events.map((e) => [e.type, e.origin.action.type])).toEqual([
      ["content-change", "INSERT"],
      ["dirty-change", "INSERT"],
      ["selection-change", "SET_SELECTION"],
    ]);
    const ids = events.map((e) => e.origin.id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBeGreaterThan(ids[1]!);
  });

  it("lists events that a handler disposing the store stops", () => {
    const store = createDocumentStoreWithEvents({ content: "abc" });
    const events = record(store);
    store.addEventListener("content-change", () => store.dispose());
    store.dispatch(DocumentActions.insert(byteOffset(3), "d"));

    expect(events.map((e) => e.type)).toEqual(["content-change"]);
    expect(events[0]!.origin.types).toEqual(["content-change", "dirty-change"]);
  });

  it("gives an action a handler dispatches a later id and no transaction", () => {
    const store = createDocumentStoreWithEvents({ content: "abc" });
    const events = record(store);
    let reacted = false;
    store.addEventListener("content-change", () => {
      if (reacted) return;
      reacted = true;
      store.dispatch(DocumentActions.setSelection(caret(1)));
    });
    // The caret starts at 0, so an insert at 3 leaves it in place.
    store.batch([DocumentActions.insert(byteOffset(3), "d")]);

    const content = events.find((e) => e.type === "content-change")!;
    const selection = events.find((e) => e.type === "selection-change")!;
    expect(content.origin.types).toEqual(["content-change", "dirty-change"]);
    expect(selection.origin.action.type).toBe("SET_SELECTION");
    expect(selection.origin.id).toBeGreaterThan(content.origin.id);
    expect(content.origin.transactionId).not.toBeNull();
    expect(selection.origin.transactionId).toBeNull();
  });

  it("orders ids by delivery when a handler runs a transaction during delivery", () => {
    const store = createDocumentStoreWithEvents({ content: "abc" });
    const events = record(store);
    let reacted = false;
    store.addEventListener("content-change", () => {
      if (reacted) return;
      reacted = true;
      store.dispatch(DocumentActions.setSelection(caret(1)));
      store.beginTransaction();
      store.dispatch(DocumentActions.insert(byteOffset(0), "z"));
      store.commitTransaction();
      store.dispatch(DocumentActions.setSelection(caret(3)));
    });
    store.dispatch(DocumentActions.insert(byteOffset(3), "d"));

    expect(events.map((e) => e.origin.action.type)).toEqual([
      "INSERT",
      "INSERT",
      "SET_SELECTION",
      "INSERT",
      "INSERT",
      "SET_SELECTION",
    ]);
    const ids = events.map((e) => e.origin.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(4);
    expect(events[3]!.origin.transactionId).not.toBeNull();
  });

  it("gives an action a handler dispatches into another handler's open transaction that transaction's id", () => {
    const store = createDocumentStoreWithEvents({ content: "abc" });
    const events = record(store);
    let opened = false;
    store.addEventListener("content-change", () => {
      if (opened) return;
      opened = true;
      store.beginTransaction(); // left open when the handler returns
    });
    let saved = false;
    store.addEventListener("dirty-change", () => {
      if (saved) return;
      saved = true;
      store.dispatch(DocumentActions.markSaved());
    });
    store.dispatch(DocumentActions.insert(byteOffset(3), "d"));

    // The MARK_SAVED joined the open transaction, so its events wait for the commit.
    expect(events.some((e) => e.type === "save")).toBe(false);
    store.commitTransaction();
    const save = events.find((e) => e.type === "save")!;
    expect(save.origin.action.type).toBe("MARK_SAVED");
    expect(save.origin.transactionId).not.toBeNull();
  });

  it("requires an origin on events passed to events.emit", () => {
    const store = createDocumentStoreWithEvents({ content: "abc" });
    const seen: EventOrigin[] = [];
    store.addEventListener("selection-change", (e) => seen.push(e.origin));
    store.events.addEventListener("selection-change", (e) => seen.push(e.origin));
    const state = store.getSnapshot();
    const origin: EventOrigin = {
      id: 0,
      action: DocumentActions.setSelection(caret(0)),
      types: ["selection-change"],
      transactionId: null,
    };

    store.events.emit("selection-change", createSelectionChangeEvent(state, state, origin));
    expect(seen).toEqual([origin, origin]);

    // Type check only: an event without an origin does not compile.
    const emitWithoutOrigin = () =>
      // @ts-expect-error - `events.emit` requires a StoreEvent
      store.events.emit("selection-change", createSelectionChangeEvent(state, state));
    expect(typeof emitWithoutOrigin).toBe("function");
  });

  it("creates a store-typed emitter for store wrappers and test doubles", () => {
    const emitter: DocumentStoreWithEvents["events"] = createStoreEventEmitter();
    const state = createInitialState();
    const origin: EventOrigin = {
      id: 0,
      action: DocumentActions.setSelection(caret(0)),
      types: ["selection-change"],
      transactionId: null,
    };
    const seen: EventOrigin[] = [];
    emitter.addEventListener("selection-change", (e) => seen.push(e.origin));

    emitter.emit("selection-change", createSelectionChangeEvent(state, state, origin));
    expect(seen).toEqual([origin]);

    // Type check only: an event without an origin does not compile.
    const emitWithoutOrigin = () =>
      // @ts-expect-error - `emit` requires a StoreEvent
      emitter.emit("selection-change", createSelectionChangeEvent(state, state));
    expect(typeof emitWithoutOrigin).toBe("function");
  });

  it("reports and drops an event without an origin emitted through a wider type", () => {
    const error = vi.fn();
    const store = createDocumentStoreWithEvents({ content: "abc", logger: { error } });
    const seen: EventOrigin[] = [];
    store.addEventListener("selection-change", (e) => seen.push(e.origin));
    const state = store.getSnapshot();
    const bus: DocumentEventEmitter = store.events;

    bus.emit("selection-change", createSelectionChangeEvent(state, state));

    expect(seen).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toContain("without an origin");

    // Events the store emits itself still arrive.
    store.dispatch(DocumentActions.setSelection(caret(2)));
    expect(seen).toHaveLength(1);
  });

  it("drops an event without an origin on a store-typed emitter", () => {
    const error = vi.fn();
    const emitter = createStoreEventEmitter({ error });
    const handler = vi.fn();
    emitter.addEventListener("save", handler);
    const bus: DocumentEventEmitter = emitter;

    bus.emit("save", createSaveEvent(createInitialState()));

    expect(handler).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("types a factory's event as a StoreEvent only when given an origin", () => {
    const state = createInitialState();
    const origin: EventOrigin = {
      id: 0,
      action: DocumentActions.markSaved(0),
      types: ["save"],
      transactionId: null,
    };
    const withOrigin: StoreEvent<SaveEvent> = createSaveEvent(state, origin);
    // @ts-expect-error - without an origin the factory returns a plain event
    const withoutOrigin: StoreEvent<SaveEvent> = createSaveEvent(state);
    const maybe: EventOrigin | undefined = Math.random() > 2 ? origin : undefined;
    const plain: SaveEvent = createSaveEvent(state, maybe);

    expect(withOrigin.origin).toBe(origin);
    expect("origin" in withoutOrigin).toBe(false);
    expect("origin" in plain).toBe(false);
  });
});

describe("EventOrigin.transactionId", () => {
  it("is shared by every action in one batch, with a separate origin per action", () => {
    const store = createDocumentStoreWithEvents({ content: "hello" });
    const events = record(store);
    // The insert moves the caret from 0 to 1, and SET_SELECTION moves it back.
    store.batch([
      DocumentActions.insert(byteOffset(0), "a"),
      DocumentActions.setSelection(caret(0)),
    ]);

    expect(events.map((e) => e.type)).toEqual([
      "content-change",
      "selection-change",
      "dirty-change",
      "selection-change",
    ]);
    const [insert, , , select] = events.map((e) => e.origin);
    expect(insert!.types).toEqual(["content-change", "selection-change", "dirty-change"]);
    expect(select!.types).toEqual(["selection-change"]);
    expect(insert!.action.type).toBe("INSERT");
    expect(select!.action.type).toBe("SET_SELECTION");
    expect(insert).not.toBe(select);
    expect(insert!.transactionId).not.toBeNull();
    expect(select!.transactionId).toBe(insert!.transactionId);
  });

  it("is the outermost transaction's id inside nested transactions", () => {
    const store = createDocumentStoreWithEvents({ content: "hello" });
    const events = record(store);
    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(0), "a"));
    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(0), "b"));
    store.commitTransaction();
    store.commitTransaction();

    const ids = new Set(events.map((e) => e.origin.transactionId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBeNull();
  });

  it("increases across transactions and skips a rolled-back one", () => {
    const store = createDocumentStoreWithEvents({ content: "hello" });
    const events = record(store);

    store.batch([DocumentActions.insert(byteOffset(0), "a")]);
    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(0), "b"));
    store.rollbackTransaction();
    store.batch([DocumentActions.insert(byteOffset(0), "c")]);

    const [first, second] = events
      .filter((e) => e.type === "content-change")
      .map((e) => e.origin.transactionId!);
    expect(events.filter((e) => e.type === "content-change")).toHaveLength(2);
    expect(second! - first!).toBe(2);
  });

  it("stays on the outer transaction's events after a nested rollback", () => {
    const store = createDocumentStoreWithEvents({ content: "hello" });
    const events = record(store);
    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(5), "a"));
    store.beginTransaction();
    store.dispatch(DocumentActions.insert(byteOffset(6), "b"));
    store.rollbackTransaction();
    store.commitTransaction();

    const content = events.filter((e) => e.type === "content-change");
    expect(content).toHaveLength(1);
    expect(content[0]!.origin.action).toMatchObject({ text: "a" });
    expect(content[0]!.origin.transactionId).not.toBeNull();
  });

  it("is null for an action a store listener dispatches while the transaction commits", () => {
    const store = createDocumentStoreWithEvents({ content: "hello" });
    const events = record(store);
    let reacted = false;
    store.subscribe(() => {
      if (reacted) return;
      reacted = true;
      store.dispatch(DocumentActions.setSelection(caret(2)));
    });
    store.batch([DocumentActions.insert(byteOffset(5), "!")]);

    const selection = events.find((e) => e.type === "selection-change")!;
    const content = events.find((e) => e.type === "content-change")!;
    expect(content.origin.transactionId).not.toBeNull();
    expect(selection.origin.action.type).toBe("SET_SELECTION");
    expect(selection.origin.transactionId).toBeNull();
  });
});

describe("event factories without an origin", () => {
  it("create events with no origin property", () => {
    const prev = createInitialState();
    const next = createInitialState();
    const action = DocumentActions.insert(byteOffset(0), "a");
    const created: AnyDocumentEvent[] = [
      createContentChangeEvent(action, prev, next, [[byteOffset(0), byteOffset(1)]]),
      createSelectionChangeEvent(prev, next),
      createHistoryChangeEvent("undo", prev, next),
      createHistoryDropEvent(prev, next, { undo: 1, redo: 0 }),
      createAttentionChangeEvent(prev, next, []),
      createSaveEvent(next),
      createDirtyChangeEvent(true, next),
    ];
    for (const event of created) {
      expect("origin" in event).toBe(false);
      expect(Object.isFrozen(event)).toBe(true);
    }
  });

  it("attach a given origin", () => {
    const state = createInitialState();
    const origin: EventOrigin = {
      id: 7,
      action: DocumentActions.setSelection(caret(0)),
      types: ["selection-change"],
      transactionId: null,
    };
    expect(createSelectionChangeEvent(state, state, origin).origin).toBe(origin);
    expect(createSaveEvent(state, origin).origin).toBe(origin);
  });
});
