/**
 * Test that an awaited eviction is claimed only by a commit into the store it
 * was awaited on, whatever else commits meanwhile, and that the store reports
 * the loss in commit order and only once it is final.
 */

import { describe, it, expect, vi } from "vitest";
import { dispatchEviction } from "./eviction-report.js";
import { createDocumentStore, createDocumentStoreWithEvents } from "./store.js";
import { DocumentActions } from "./actions.js";
import { getRedoCount } from "./history.js";
import { byteOffset } from "../../types/branded.js";
import type { DocumentAction } from "../../types/actions.js";
import type { DocumentStore, ReconcilableDocumentStore } from "../../types/store.js";

const CHUNK_SIZE = 8;
const encode = (text: string) => new TextEncoder().encode(text);

/** A store with chunks 0 and 1 loaded and a redo entry that points into chunk 0. */
function pinnedStore(withEvents = false): ReconcilableDocumentStore {
  const config = {
    chunkSize: CHUNK_SIZE,
    totalFileSize: CHUNK_SIZE * 2,
    historyEvictionPolicy: "pin-bounded" as const,
    reconcileMode: "none" as const,
  };
  const store = withEvents ? createDocumentStoreWithEvents(config) : createDocumentStore(config);
  store.dispatch(DocumentActions.loadChunk(0, encode("aaaaaaaa")));
  store.dispatch(DocumentActions.loadChunk(1, encode("bbbbbbbb")));
  store.dispatch(DocumentActions.insert(byteOffset(2), "X"));
  store.dispatch(DocumentActions.undo());
  return store;
}

const evict = DocumentActions.evictChunks([0], 1);

/** Forwards to `base` by listing its methods, so nothing but behaviour is shared. */
class ForwardingStore implements Pick<DocumentStore, "getSnapshot" | "subscribe" | "dispatch"> {
  private readonly base: DocumentStore;
  private readonly before: (action: DocumentAction) => void;
  constructor(base: DocumentStore, before: (action: DocumentAction) => void = () => {}) {
    this.base = base;
    this.before = before;
  }
  getSnapshot() {
    return this.base.getSnapshot();
  }
  subscribe(listener: () => void) {
    return this.base.subscribe(listener);
  }
  dispatch(action: DocumentAction) {
    this.before(action);
    return this.base.dispatch(action);
  }
}

const asStore = (s: ForwardingStore) => s as unknown as DocumentStore;

describe("dispatchEviction", () => {
  it.each([false, true])("reports what the eviction discarded (events: %s)", (withEvents) => {
    const store = pinnedStore(withEvents);
    const from = store.getSnapshot().history;
    const onDropped = vi.fn();
    dispatchEviction(store, evict, onDropped);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped.mock.calls[0]![0].from).toBe(from);
    expect(getRedoCount(onDropped.mock.calls[0]![0].to)).toBe(0);
  });

  it("reports through a wrapper that lists its methods", () => {
    const store = pinnedStore();
    const onDropped = vi.fn();
    dispatchEviction(asStore(new ForwardingStore(store)), evict, onDropped);
    expect(onDropped).toHaveBeenCalledTimes(1);
  });

  it("measures from the history the eviction reduced when a wrapper dispatches first", () => {
    const store = pinnedStore();
    const wrapped = new ForwardingStore(store, (action) => {
      if (action.type === "EVICT_CHUNKS") store.dispatch(DocumentActions.historyClear());
    });
    const onDropped = vi.fn();
    dispatchEviction(asStore(wrapped), evict, onDropped);
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("ignores the eviction another store commits", () => {
    const store = createDocumentStore({ content: "hello" });
    const mirror = pinnedStore();
    const wrapped = new ForwardingStore(store, (action) => mirror.dispatch(action));
    const onDropped = vi.fn();
    dispatchEviction(asStore(wrapped), evict, onDropped);
    expect(getRedoCount(mirror.getSnapshot())).toBe(0);
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("does not report history a rollback restores, through any wrapper", () => {
    const store = pinnedStore();
    const onDropped = vi.fn();
    store.beginTransaction();
    dispatchEviction(asStore(new ForwardingStore(store)), evict, onDropped);
    expect(onDropped).not.toHaveBeenCalled();
    store.rollbackTransaction();
    expect(getRedoCount(store.getSnapshot())).toBe(1);
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("reports a loss held by a transaction before a listener's later one", () => {
    const store = pinnedStore();
    const other = pinnedStore();
    const order: string[] = [];
    store.beginTransaction();
    dispatchEviction(store, evict, () => order.push("first"));
    const unsubscribe = store.subscribe(() => {
      unsubscribe();
      dispatchEviction(other, evict, () => order.push("second"));
    });
    store.commitTransaction();
    expect(order).toEqual(["first", "second"]);
  });

  it("reports a loss before a listener's eviction outside a transaction", () => {
    const store = pinnedStore();
    const other = pinnedStore();
    const order: string[] = [];
    const unsubscribe = store.subscribe(() => {
      unsubscribe();
      dispatchEviction(other, evict, () => order.push("second"));
    });
    dispatchEviction(store, evict, () => order.push("first"));
    expect(order).toEqual(["first", "second"]);
  });
});
