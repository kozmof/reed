/**
 * Test that every action discarding history without undoing or redoing it
 * fires `history-drop` with the entries it discarded, and that the store warns
 * of the history an EVICT_CHUNKS discarded once that is final.
 */

import { describe, it, expect, vi } from "vitest";
import { createDocumentStore, createDocumentStoreWithEvents } from "./store.js";
import { DocumentActions } from "./actions.js";
import { createChunkManager } from "./chunk-manager.js";
import { getRedoCount } from "./history.js";
import { byteOffset } from "../../types/branded.js";
import type { HistoryDropEvent } from "./events.js";

const CHUNK_SIZE = 8;
const encode = (text: string) => new TextEncoder().encode(text);

/** A store with chunks 0 and 1 loaded and a redo entry that points into chunk 0. */
function pinnedStore(warn: (message: string) => void = () => {}) {
  const store = createDocumentStoreWithEvents({
    chunkSize: CHUNK_SIZE,
    totalFileSize: CHUNK_SIZE * 2,
    historyEvictionPolicy: "pin-bounded",
    reconcileMode: "none",
    logger: { warn },
  });
  store.dispatch(DocumentActions.loadChunk(0, encode("aaaaaaaa")));
  store.dispatch(DocumentActions.loadChunk(1, encode("bbbbbbbb")));
  store.dispatch(DocumentActions.insert(byteOffset(2), "X"));
  store.dispatch(DocumentActions.undo());
  return store;
}

const evict = DocumentActions.evictChunks([0], 1);

/** A loader for a ChunkManager these tests never ask to load. */
const unusedLoader = {
  loadChunk: async (): Promise<Uint8Array> => {
    throw new Error("not loaded in these tests");
  },
};

describe("history-drop", () => {
  /** A store with two undo entries and one redo entry. */
  const withHistory = () => {
    const store = createDocumentStoreWithEvents({ content: "abc", reconcileMode: "none" });
    for (const text of ["x", "y", "z"]) {
      store.dispatch(DocumentActions.insert(byteOffset(0), text));
    }
    store.dispatch(DocumentActions.undo());
    const drops: HistoryDropEvent[] = [];
    store.addEventListener("history-drop", (event) => drops.push(event));
    return { store, drops };
  };

  it.each([
    [
      "APPLY_REMOTE",
      DocumentActions.applyRemote([{ type: "insert", start: byteOffset(0), text: "R" }]),
    ],
    ["HISTORY_CLEAR", DocumentActions.historyClear()],
  ])("fires when %s clears history, with the entries it cleared", (_, action) => {
    const { store, drops } = withHistory();
    store.dispatch(action);
    expect(drops).toHaveLength(1);
    expect(drops[0]!.undoDropped).toBe(2);
    expect(drops[0]!.redoDropped).toBe(1);
    expect(getRedoCount(drops[0]!.nextState)).toBe(0);
  });

  it("does not fire when the history cleared was already empty", () => {
    const store = createDocumentStoreWithEvents({ content: "abc", reconcileMode: "none" });
    const drop = vi.fn();
    store.addEventListener("history-drop", drop);
    store.dispatch(
      DocumentActions.applyRemote([{ type: "insert", start: byteOffset(0), text: "R" }]),
    );
    store.dispatch(DocumentActions.historyClear());
    expect(drop).not.toHaveBeenCalled();
  });

  it("counts the entries an eviction discarded", () => {
    const store = pinnedStore();
    const drops: HistoryDropEvent[] = [];
    store.addEventListener("history-drop", (event) => drops.push(event));
    store.dispatch(evict);
    expect(drops.map((d) => [d.undoDropped, d.redoDropped])).toEqual([[0, 1]]);
  });
});

describe("eviction warning", () => {
  it("warns through the store's logger when EVICT_CHUNKS discards history", () => {
    const warn = vi.fn();
    const store = pinnedStore(warn);
    store.dispatch(evict);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("discarded 0 undo and 1 redo entries");
    expect(warn.mock.calls[0]![0]).toContain("within 1 loaded chunks");
  });

  it("does not warn for EVICT_CHUNKS with keepHistory, or for EVICT_CHUNK", () => {
    const warn = vi.fn();
    const store = pinnedStore(warn);
    store.dispatch(DocumentActions.evictChunks([0], 1, true));
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(true);
    store.dispatch(DocumentActions.evictChunk(0, true));
    expect(getRedoCount(store.getSnapshot())).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns for an eviction committed again after a rollback discarded the first", () => {
    const warn = vi.fn();
    const store = pinnedStore(warn);
    store.beginTransaction();
    store.dispatch(evict);
    store.rollbackTransaction();
    expect(getRedoCount(store.getSnapshot())).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    store.beginTransaction();
    store.dispatch(evict);
    store.commitTransaction();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns in commit order, before listeners hear of the change", () => {
    const order: string[] = [];
    const store = pinnedStore((message) =>
      order.push(message.includes("discarded") ? "warn" : message),
    );
    store.subscribe(() => order.push("listener"));
    store.dispatch(evict);
    expect(order).toEqual(["warn", "listener"]);
  });

  it("warns only through the store's logger when both have one", () => {
    const storeWarn = vi.fn();
    const store = pinnedStore(storeWarn);
    const managerWarn = vi.fn();
    const manager = createChunkManager(store, unusedLoader, { logger: { warn: managerWarn } });
    store.dispatch(evict);
    expect(storeWarn).toHaveBeenCalledTimes(1);
    expect(managerWarn).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("reports a logger that throws instead of throwing from dispatch", () => {
    const error = vi.fn();
    const store = createDocumentStore({
      chunkSize: CHUNK_SIZE,
      totalFileSize: CHUNK_SIZE * 2,
      historyEvictionPolicy: "pin-bounded",
      reconcileMode: "none",
      logger: {
        warn: () => {
          throw new Error("sink down");
        },
        error,
      },
    });
    store.dispatch(DocumentActions.loadChunk(0, encode("aaaaaaaa")));
    store.dispatch(DocumentActions.loadChunk(1, encode("bbbbbbbb")));
    store.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    store.dispatch(DocumentActions.undo());
    expect(() => store.dispatch(evict)).not.toThrow();
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
    expect(error).toHaveBeenCalledWith(
      "The logger threw after an eviction committed",
      expect.anything(),
    );
  });
});
