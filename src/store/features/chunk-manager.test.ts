/**
 * Test asynchronous chunk loading with ChunkManager.
 * Cover deduplication, LRU eviction, pinning, prefetch, and disposal.
 */

import { describe, it, expect, vi } from "vitest";
import { createChunkManager } from "./chunk-manager.js";
import { createDocumentStore, createDocumentStoreWithEvents } from "./store.js";
import { DocumentActions, deserializeAction, serializeAction } from "./actions.js";
import { byteOffset } from "../../types/branded.js";
import type { DocumentStore } from "../../types/store.js";
import type { DocumentAction } from "../../types/actions.js";
import { getRedoCount, getUndoCount } from "./history.js";
import { getValue } from "../core/piece-table.js";
import { documentReducer } from "./reducer.js";
import { evictionCandidate } from "./chunk-actions.js";
import type { DocumentState, HistoryEvictionPolicy } from "../../types/state.js";
import { makeDeterministicRng, randomInt } from "../../../test-utils/large-content.js";

const CHUNK_SIZE = 8;

function makeBytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function makeStore() {
  return createDocumentStore({ chunkSize: CHUNK_SIZE });
}

function makeLoader(chunks: Record<number, string>) {
  const loadChunk = vi.fn(async (i: number): Promise<Uint8Array> => {
    if (!(i in chunks)) throw new Error(`No chunk ${i}`);
    return makeBytes(chunks[i]!);
  });
  return { loadChunk };
}

describe("ChunkManager.ensureLoaded", () => {
  it("dispatches LOAD_CHUNK and resolves when chunk arrives", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb" });
    const manager = createChunkManager(store, loader);

    await manager.ensureLoaded(0);

    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(true);
    manager.dispose();
  });

  it("loads many chunks in one store transition", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb", 1: "ccccdddd" });
    const manager = createChunkManager(store, loader, { maxLoadedChunks: 1 });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications++;
    });

    await manager.ensureLoadedMany([0, 1]);

    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(2);
    expect(store.getSnapshot().revision).toBe(2);
    expect(notifications).toBe(1);
    unsubscribe();
    manager.dispose();
  });

  it("resolves immediately if chunk is already in memory", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb" });
    const manager = createChunkManager(store, loader);

    await manager.ensureLoaded(0);
    const callsBefore = loader.loadChunk.mock.calls.length;
    await manager.ensureLoaded(0); // The second call finds the chunk already loaded.
    expect(loader.loadChunk.mock.calls.length).toBe(callsBefore); // no extra fetch
    manager.dispose();
  });

  it("deduplicates concurrent requests for the same chunk", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb" });
    const manager = createChunkManager(store, loader);

    const [p1, p2, p3] = [
      manager.ensureLoaded(0),
      manager.ensureLoaded(0),
      manager.ensureLoaded(0),
    ];
    await Promise.all([p1, p2, p3]);

    // Concurrent requests share one fetch.
    expect(loader.loadChunk.mock.calls.length).toBe(1);
    manager.dispose();
  });

  it("loads chunks out-of-order (random access)", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb", 2: "ccccdddd" });
    const manager = createChunkManager(store, loader);

    await manager.ensureLoaded(2); // chunk 2 before chunk 0
    expect(store.getSnapshot().pieceTable.chunkMap.has(2)).toBe(true);
    manager.dispose();
  });

  it("rejects (throws) when the loader throws", async () => {
    const store = makeStore();
    const loader = {
      loadChunk: vi.fn(async () => {
        throw new Error("network error");
      }),
    };
    const manager = createChunkManager(store, loader);

    await expect(manager.ensureLoaded(0)).rejects.toThrow("network error");
    // Check that the chunk is absent from the store.
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
    manager.dispose();
  });

  it("retries after a failed load (no stale in-flight entry)", async () => {
    const store = makeStore();
    let callCount = 0;
    const loader = {
      loadChunk: vi.fn(async (): Promise<Uint8Array> => {
        callCount++;
        if (callCount === 1) throw new Error("transient");
        return makeBytes("aaaabbbb");
      }),
    };
    const manager = createChunkManager(store, loader);

    await expect(manager.ensureLoaded(0)).rejects.toThrow();
    // Retry successfully after the failed fetch.
    await manager.ensureLoaded(0);
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(true);
    manager.dispose();
  });

  it("rejects negative chunk indices before fetching", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb" });
    const manager = createChunkManager(store, loader);

    await expect(manager.ensureLoaded(-1)).rejects.toThrow(
      "Chunk index must be a non-negative integer: -1",
    );
    expect(loader.loadChunk).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("rejects out-of-range chunk indices using loader.totalChunkCount", async () => {
    const store = makeStore();
    const loader = {
      ...makeLoader({ 0: "aaaabbbb", 1: "bbbbcccc" }),
      totalChunkCount: 2,
    };
    const manager = createChunkManager(store, loader);

    await expect(manager.ensureLoaded(2)).rejects.toThrow("Chunk index 2 is out of range");
    expect(loader.loadChunk).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("rejects out-of-range chunk indices inferred from totalFileSize", async () => {
    const store = createDocumentStore({ chunkSize: CHUNK_SIZE, totalFileSize: CHUNK_SIZE * 2 });
    const loader = makeLoader({ 0: "aaaabbbb", 1: "bbbbcccc" });
    const manager = createChunkManager(store, loader);

    await expect(manager.ensureLoaded(2)).rejects.toThrow("Chunk index 2 is out of range");
    expect(loader.loadChunk).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("rejects immediately when the store is not configured for chunked mode", async () => {
    const store = createDocumentStore();
    const loader = makeLoader({ 0: "aaaabbbb" });
    const manager = createChunkManager(store, loader);

    await expect(manager.ensureLoaded(0)).rejects.toThrow(
      "ChunkManager requires a store configured with chunkSize > 0",
    );
    expect(loader.loadChunk).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("rejects if LOAD_CHUNK does not leave the chunk resident in the store", async () => {
    const backingStore = makeStore();
    const state = backingStore.getSnapshot();
    const fakeStore = {
      subscribe: () => () => {},
      getSnapshot: () => state,
      isCurrentSnapshot: (snapshot: typeof state) => snapshot === state,
      dispatch: vi.fn(() => state),
      batch: vi.fn(() => state),
    } as unknown as DocumentStore;
    const loader = makeLoader({ 0: "aaaabbbb" });
    const manager = createChunkManager(fakeStore, loader);

    await expect(manager.ensureLoaded(0)).rejects.toThrow(
      "Chunk 0 was fetched but the store did not retain it after LOAD_CHUNK dispatch",
    );
    expect(loader.loadChunk).toHaveBeenCalledTimes(1);
    manager.dispose();
  });
});

describe("ChunkManager LRU eviction", () => {
  it("evicts the LRU chunk when maxLoadedChunks is exceeded", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb", 1: "bbbbcccc", 2: "ccccdddd" });
    const manager = createChunkManager(store, loader, { maxLoadedChunks: 2 });

    await manager.ensureLoaded(0);
    await manager.ensureLoaded(1);
    // Loading chunk 2 evicts the least recently used chunk, chunk 0.
    await manager.ensureLoaded(2);

    const snap = store.getSnapshot();
    expect(snap.pieceTable.chunkMap.size).toBeLessThanOrEqual(2);
    manager.dispose();
  });

  it("does not evict pinned chunks", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb", 1: "bbbbcccc", 2: "ccccdddd" });
    const manager = createChunkManager(store, loader, { maxLoadedChunks: 2 });

    await manager.ensureLoaded(0);
    manager.setActiveChunks([0]); // pin chunk 0
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2); // should evict chunk 1, not pinned chunk 0

    const snap = store.getSnapshot();
    expect(snap.pieceTable.chunkMap.has(0)).toBe(true); // Keep the pinned chunk resident.
    manager.dispose();
  });

  it("reports a throwing pressure warning through error, keeping the load", async () => {
    const store = createDocumentStore({ chunkSize: CHUNK_SIZE, totalFileSize: CHUNK_SIZE * 3 });
    const loader = makeLoader({ 0: "aaaabbbb", 1: "bbbbcccc", 2: "ccccdddd" });
    const failure = new Error("warn failed");
    const warn = vi.fn(() => {
      throw failure;
    });
    const error = vi.fn();
    const manager = createChunkManager(store, loader, {
      maxLoadedChunks: 1,
      logger: { warn, error },
    });
    manager.setActiveChunks([0, 1]);
    await manager.ensureLoaded(0);
    // Pinned chunks keep the cache over the limit, so the manager warns.
    await expect(manager.ensureLoaded(1)).resolves.toBeUndefined();
    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("eviction pressure: 2 chunks loaded"),
    );
    expect(error).toHaveBeenCalledWith(expect.any(String), failure);
    // A pass that shrinks the active set returns normally too.
    expect(() => manager.setActiveChunks([1])).not.toThrow();
    manager.dispose();
  });

  it("re-applies eviction pressure when the active chunk set shrinks", async () => {
    const store = createDocumentStore({ chunkSize: CHUNK_SIZE, totalFileSize: CHUNK_SIZE * 3 });
    const loader = makeLoader({ 0: "aaaabbbb", 1: "bbbbcccc", 2: "ccccdddd" });
    const manager = createChunkManager(store, loader, { maxLoadedChunks: 2 });

    manager.setActiveChunks([0, 1, 2]);
    await manager.ensureLoaded(0);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);
    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(3);

    manager.setActiveChunks([2]);

    const snap = store.getSnapshot();
    expect(snap.pieceTable.chunkMap.size).toBe(2);
    expect(snap.pieceTable.chunkMap.has(2)).toBe(true);
    expect(snap.pieceTable.chunkMap.has(0)).toBe(false);

    manager.dispose();
  });

  it("keeps the requested chunk resident when an older dirty chunk cannot be evicted", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb", 1: "bbbbcccc" });
    const warn = vi.fn();
    const manager = createChunkManager(store, loader, { maxLoadedChunks: 1, logger: { warn } });

    await manager.ensureLoaded(0);
    store.dispatch(DocumentActions.delete(byteOffset(2), byteOffset(4)));

    await manager.ensureLoaded(1);

    const snap = store.getSnapshot();
    expect(snap.pieceTable.chunkMap.has(0)).toBe(true);
    expect(snap.pieceTable.chunkMap.has(1)).toBe(true);
    expect(warn).toHaveBeenCalled();

    manager.dispose();
  });
});

describe("ChunkManager with the 'pin-bounded' history policy", () => {
  const chunks = { 0: "aaaaaaa\n", 1: "bbbbbbb\n", 2: "ccccccc\n" };
  const setup = (historyEvictionPolicy: HistoryEvictionPolicy) => {
    // The store warns of history an eviction discards, and the manager of
    // chunks that stay resident, so both share one logger here.
    const warn = vi.fn();
    const store = createDocumentStore({
      chunkSize: CHUNK_SIZE,
      totalFileSize: CHUNK_SIZE * 3,
      historyEvictionPolicy,
      reconcileMode: "none",
      logger: { warn },
    });
    const manager = createChunkManager(store, makeLoader(chunks), {
      maxLoadedChunks: 2,
      logger: { warn },
    });
    return { store, manager, warn };
  };
  /** Type inside chunk 0 and undo, so the redo entry pins the pristine chunk. */
  const pinChunk0 = (store: DocumentStore) => {
    store.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    store.dispatch(DocumentActions.undo());
  };

  it("evicts a chunk history does not pin before dropping history", async () => {
    const { store, manager } = setup("pin-bounded");
    await manager.ensureLoaded(0);
    pinChunk0(store);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);

    const snap = store.getSnapshot();
    // Chunk 1 was evictable without touching history, so chunk 0 stays.
    expect([...snap.pieceTable.chunkMap.keys()].sort()).toEqual([0, 2]);
    expect(snap.history.redoStack).not.toBeNull();
    store.dispatch(DocumentActions.redo());
    expect(store.getSnapshot().pieceTable.totalLength).toBe(17);
    manager.dispose();
  });

  it("drops the pinning history once nothing else can be evicted", async () => {
    const { store, manager, warn } = setup("pin-bounded");
    await manager.ensureLoaded(0);
    pinChunk0(store);
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);

    const snap = store.getSnapshot();
    expect([...snap.pieceTable.chunkMap.keys()].sort()).toEqual([1, 2]);
    expect(snap.history.redoStack).toBeNull();
    // The drop is reported, but the cache is within the limit: no pressure warning.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("discarded 0 undo and 1 redo entries");
    expect(warn.mock.calls[0]![0]).toContain('"pin-bounded"');
    manager.dispose();
  });

  it("drops the fewest history entries, not the least recently used chunk's", async () => {
    const { store, manager } = setup("pin-bounded");
    await manager.ensureLoaded(0);
    await manager.ensureLoaded(1);
    // Type inside chunk 0, then inside chunk 1, and undo both. The next redo
    // points inside chunk 0, so evicting it drops both redo entries; evicting
    // chunk 1 drops only the later one.
    store.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    store.dispatch(DocumentActions.insert(byteOffset(11), "Y"));
    store.dispatch(DocumentActions.undo());
    store.dispatch(DocumentActions.undo());
    expect(getRedoCount(store.getSnapshot())).toBe(2);
    // Chunk 0 is the least recently used.
    await manager.ensureLoaded(2);

    const snap = store.getSnapshot();
    expect([...snap.pieceTable.chunkMap.keys()].sort()).toEqual([0, 2]);
    expect(getRedoCount(snap)).toBe(1);
    store.dispatch(DocumentActions.redo());
    expect(getValue(store.getSnapshot().pieceTable).startsWith("aaXaaaaa\n")).toBe(true);
    manager.dispose();
  });

  it("evicts a chunk history does not pin first under 'drop' too", async () => {
    const { store, manager } = setup("drop");
    await manager.ensureLoaded(0);
    pinChunk0(store);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);

    const snap = store.getSnapshot();
    // Chunk 0 is the least recently used, but evicting it would drop the redo.
    expect([...snap.pieceTable.chunkMap.keys()].sort()).toEqual([0, 2]);
    expect(getRedoCount(snap)).toBe(1);
    manager.dispose();
  });

  it("defaults to 'pin-bounded', which keeps the cache within the limit", async () => {
    const store = createDocumentStore({
      chunkSize: CHUNK_SIZE,
      totalFileSize: CHUNK_SIZE * 3,
      reconcileMode: "none",
    });
    expect(store.getSnapshot().history.evictionPolicy).toBe("pin-bounded");
    const manager = createChunkManager(store, makeLoader(chunks), { maxLoadedChunks: 2 });
    await manager.ensureLoaded(0);
    pinChunk0(store);
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);
    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(2);
    manager.dispose();
  });

  it("warns once when the cache goes over the limit, and again if it returns", async () => {
    const { store, manager, warn } = setup("pin");
    await manager.ensureLoaded(0);
    pinChunk0(store);
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);
    expect(warn).toHaveBeenCalledTimes(1);
    // Still over the limit: no new warning.
    manager.setActiveChunks([1, 2]);
    manager.setActiveChunks([2, 1]);
    expect(warn).toHaveBeenCalledTimes(1);

    // Clearing history lets chunk 0 go, which ends the pressure.
    store.dispatch(DocumentActions.historyClear());
    manager.setActiveChunks([]);
    expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([1, 2]);
    // History pins chunk 1 (now at offset 0), and loading chunk 0 again goes over.
    store.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    store.dispatch(DocumentActions.undo());
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(0);
    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it("names what keeps chunks resident, and warns again when a new reason does", async () => {
    const { store, manager, warn } = setup("pin");
    // Every chunk was just requested, so none can go; history holds none.
    await manager.ensureLoadedMany([0, 1, 2]);
    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("3 just loaded for the current request");
    expect(warn.mock.calls[0]![0]).not.toContain("undo history");

    // Still over the limit, now because history holds chunk 0 and the others
    // are pinned: both reasons are new, so it warns again and names them.
    pinChunk0(store);
    manager.setActiveChunks([1, 2]);
    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]![0]).toContain("2 pinned as active");
    expect(warn.mock.calls[1]![0]).toContain("1 hold user edits or undo history");
    expect(warn.mock.calls[1]![0]).toContain('"pin-bounded"');

    // The same reasons again: no new warning.
    manager.setActiveChunks([2, 1]);
    expect(warn).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it("names an attention anchor, not history, when one keeps a chunk resident", async () => {
    const { store, manager, warn } = setup("pin-bounded");
    await manager.ensureLoaded(0);
    // No edits and no history: only the attention keeps chunk 0.
    store.dispatch(DocumentActions.createAttention(byteOffset(1), byteOffset(3)));
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);

    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("1 hold an attention anchor");
    expect(warn.mock.calls[0]![0]).not.toContain("undo history");
    manager.dispose();
  });

  it("names history too when it would keep an anchored chunk under 'pin'", async () => {
    const { store, manager, warn } = setup("pin");
    await manager.ensureLoaded(0);
    pinChunk0(store);
    store.dispatch(DocumentActions.createAttention(byteOffset(1), byteOffset(3)));
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);

    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    // Counted once, as anchored, so the counts add up to the chunks loaded.
    expect(message).toContain(
      "1 hold an attention anchor, 1 of which also hold user edits or undo history",
    );
    expect(message).not.toContain("; 1 hold user edits or undo history");
    expect(message).toContain('"pin-bounded"');
    manager.dispose();
  });

  it("names edits for an anchored chunk without the 'pin' hint when history keeps nothing", async () => {
    const { store, manager, warn } = setup("pin");
    await manager.ensureLoaded(0);
    // An edit, not history, keeps chunk 0; clearing history leaves nothing to pin.
    store.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    store.dispatch(DocumentActions.historyClear());
    store.dispatch(DocumentActions.createAttention(byteOffset(1), byteOffset(3)));
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);

    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain(
      "1 hold an attention anchor, 1 of which also hold user edits or undo history",
    );
    expect(message).not.toContain('"pin-bounded"');
    manager.dispose();
  });

  it("does not name history for an anchored chunk history would not keep", async () => {
    const { store, manager, warn } = setup("pin-bounded");
    await manager.ensureLoaded(0);
    pinChunk0(store);
    store.dispatch(DocumentActions.createAttention(byteOffset(1), byteOffset(3)));
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("1 hold an attention anchor");
    expect(warn.mock.calls[0]![0]).not.toContain("undo history");
    manager.dispose();
  });

  it("does not offer chunks history pins again until the document changes", async () => {
    const { store, manager } = setup("pin");
    await manager.ensureLoaded(0);
    pinChunk0(store);
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);
    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(3);

    // History still pins chunk 0, so a pass would evict nothing.
    const dispatch = vi.spyOn(store, "dispatch");
    manager.setActiveChunks([2, 1]);
    expect(dispatch.mock.calls.filter(([action]) => action.type.startsWith("EVICT"))).toEqual([]);

    // Once history changes, chunk 0 is offered again and goes.
    store.dispatch(DocumentActions.historyClear());
    manager.setActiveChunks([1, 2]);
    expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([1, 2]);
    manager.dispose();
  });

  it("offers a refused chunk again once a load parts it from the text that kept it", async () => {
    const store = createDocumentStore({
      chunkSize: CHUNK_SIZE,
      totalFileSize: CHUNK_SIZE * 6,
      reconcileMode: "none",
    });
    const six = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i, `${i}`.repeat(8)]));
    const manager = createChunkManager(store, makeLoader(six), { maxLoadedChunks: 3 });
    manager.setActiveChunks([0, 1, 2, 5]);
    for (const i of [0, 1, 2, 5]) await manager.ensureLoaded(i);
    // Text typed at the end of chunk 2 lies right before chunk 5, so chunk 5
    // cannot go once it is no longer pinned.
    store.dispatch(DocumentActions.insert(byteOffset(24), "X"));
    manager.setActiveChunks([0, 1, 2]);
    expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([0, 1, 2, 5]);

    // Chunk 3 loads between that text and chunk 5, which can now go.
    expect(evictionCandidate(store.getSnapshot(), 5)).toBeNull();
    await manager.ensureLoaded(3);
    expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([0, 1, 2, 3]);
    manager.dispose();
  });

  it("offers a refused chunk again when a listener frees it while the pass evicts", async () => {
    const { store, manager } = setup("pin");
    const limited = createChunkManager(store, makeLoader(chunks), { maxLoadedChunks: 1 });
    manager.dispose();
    await limited.ensureLoaded(0);
    pinChunk0(store);
    // History pins chunk 0, so it stays and is skipped from now on.
    await limited.ensureLoaded(1);
    expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([0, 1]);

    // Evicting chunk 1 notifies a listener that clears history, which frees
    // chunk 0 in the same pass.
    let cleared = false;
    store.subscribe(() => {
      if (cleared || store.getSnapshot().pieceTable.chunkMap.has(1)) return;
      cleared = true;
      store.dispatch(DocumentActions.historyClear());
    });
    await limited.ensureLoaded(2);
    expect(cleared).toBe(true);
    expect([...store.getSnapshot().pieceTable.chunkMap.keys()]).toEqual([2]);
    limited.dispose();
  });
  it("reports only the history the eviction discards when a listener edits as it evicts", async () => {
    const { store, manager, warn } = setup("pin-bounded");
    await manager.ensureLoaded(0);
    pinChunk0(store);
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    // Evicting chunk 0 discards the redo entry; typing then pushes an undo
    // entry, which the warning must not count against the eviction.
    let typed = false;
    store.subscribe(() => {
      if (typed || store.getSnapshot().pieceTable.chunkMap.has(0)) return;
      typed = true;
      store.dispatch(DocumentActions.insert(byteOffset(0), "Y"));
    });
    await manager.ensureLoaded(2);

    expect(typed).toBe(true);
    expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([1, 2]);
    expect(getUndoCount(store.getSnapshot())).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("discarded 0 undo and 1 redo entries");
    manager.dispose();
  });

  describe("when the store is wrapped", () => {
    /** Evict chunk 0, discarding its redo entry, while a listener types. */
    const evictWhileTyping = async (wrap: (store: DocumentStore) => DocumentStore) => {
      const warn = vi.fn();
      const store = fresh(warn);
      const manager = createChunkManager(wrap(store), makeLoader(chunks), {
        maxLoadedChunks: 2,
        logger: { warn },
      });
      await manager.ensureLoaded(0);
      pinChunk0(store);
      manager.setActiveChunks([1, 2]);
      await manager.ensureLoaded(1);
      let typed = false;
      store.subscribe(() => {
        if (typed || store.getSnapshot().pieceTable.chunkMap.has(0)) return;
        typed = true;
        store.dispatch(DocumentActions.insert(byteOffset(0), "Y"));
      });
      await manager.ensureLoaded(2);
      expect(typed).toBe(true);
      expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([1, 2]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("discarded 0 undo and 1 redo entries");
      manager.dispose();
    };
    const fresh = (warn: (message: string) => void = () => {}) =>
      createDocumentStore({
        chunkSize: CHUNK_SIZE,
        totalFileSize: CHUNK_SIZE * 3,
        historyEvictionPolicy: "pin-bounded",
        reconcileMode: "none",
        logger: { warn },
      });

    it("sends the eviction that discards history through a patched dispatch", async () => {
      const seen: DocumentAction[] = [];
      await evictWhileTyping((store) => {
        const original = store.dispatch;
        store.dispatch = (action) => {
          seen.push(action);
          return original(action);
        };
        return store;
      });
      expect(
        seen.some((action) => action.type === "EVICT_CHUNKS" && action.keepHistory !== true),
      ).toBe(true);
    });

    it("reports the eviction's own loss for a copy of the store", async () => {
      await evictWhileTyping((store) => ({ ...store }));
    });

    it("reports the eviction's own loss when a wrapper dispatches a copy of the action", async () => {
      await evictWhileTyping((store) => ({
        ...store,
        dispatch: (action) => store.dispatch({ ...action }),
      }));
    });

    it("reports the eviction's own loss through a wrapper whose snapshot is a copy", async () => {
      await evictWhileTyping((store) => ({
        ...store,
        getSnapshot: () => ({ ...store.getSnapshot() }),
      }));
    });

    it("measures the loss from the state the eviction reduced when a wrapper dispatches first", async () => {
      const warn = vi.fn();
      const store = fresh(warn);
      // Clearing history first leaves the eviction nothing to discard.
      const wrapped: DocumentStore = {
        ...store,
        dispatch: (action) => {
          if (action.type === "EVICT_CHUNKS" && action.keepHistory !== true) {
            store.dispatch(DocumentActions.historyClear());
          }
          return store.dispatch(action);
        },
      };
      const manager = createChunkManager(wrapped, makeLoader(chunks), {
        maxLoadedChunks: 2,
        logger: { warn },
      });
      await manager.ensureLoaded(0);
      pinChunk0(store);
      manager.setActiveChunks([1, 2]);
      await manager.ensureLoaded(1);
      await manager.ensureLoaded(2);
      expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([1, 2]);
      expect(warn).not.toHaveBeenCalled();
      manager.dispose();
    });

    it("takes the loss from the base store's commit through a copy of an event store", async () => {
      const warn = vi.fn();
      const store = createDocumentStoreWithEvents({
        chunkSize: CHUNK_SIZE,
        totalFileSize: CHUNK_SIZE * 3,
        historyEvictionPolicy: "pin-bounded",
        reconcileMode: "none",
        logger: { warn },
      });
      // Clearing history first leaves the eviction nothing to discard, which
      // only the store's own commit of the eviction can tell.
      const wrapped: DocumentStore = {
        ...store,
        dispatch: (action) => {
          if (action.type === "EVICT_CHUNKS" && action.keepHistory !== true) {
            store.dispatch(DocumentActions.historyClear());
          }
          return store.dispatch(action);
        },
      };
      const manager = createChunkManager(wrapped, makeLoader(chunks), {
        maxLoadedChunks: 2,
        logger: { warn },
      });
      await manager.ensureLoaded(0);
      pinChunk0(store);
      manager.setActiveChunks([1, 2]);
      await manager.ensureLoaded(1);
      await manager.ensureLoaded(2);
      expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([1, 2]);
      expect(warn).not.toHaveBeenCalled();
      manager.dispose();
    });

    it("does not count a listener's edit when a wrapper changes the action", async () => {
      const warn = vi.fn();
      const store = fresh(warn);
      // Repeating the chunks evicts the same ones in a different action.
      const wrapped: DocumentStore = {
        ...store,
        dispatch: (action) =>
          store.dispatch(
            action.type === "EVICT_CHUNKS"
              ? { ...action, chunkIndices: [...action.chunkIndices, ...action.chunkIndices] }
              : action,
          ),
      };
      const manager = createChunkManager(wrapped, makeLoader(chunks), {
        maxLoadedChunks: 2,
        logger: { warn },
      });
      await manager.ensureLoaded(0);
      pinChunk0(store);
      await manager.ensureLoaded(1);
      // The pass evicts chunk 1 at no cost to history while a listener types,
      // which pushes an undo entry and clears the redo one.
      let typed = false;
      store.subscribe(() => {
        if (typed || store.getSnapshot().pieceTable.chunkMap.has(1)) return;
        typed = true;
        store.dispatch(DocumentActions.insert(byteOffset(0), "Y"));
      });
      await manager.ensureLoaded(2);
      expect(typed).toBe(true);
      expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([0, 2]);
      expect(warn).not.toHaveBeenCalled();
      manager.dispose();
    });

    it("warns through the store whose eviction discards history, not a mirror's", async () => {
      const warn = vi.fn();
      const mirrorWarn = vi.fn();
      const store = fresh(warn);
      // A mirror whose redo entries pin chunks 0 and 1, so evicting either
      // there discards history.
      const mirror = fresh(mirrorWarn);
      for (const i of [0, 1, 2] as const) {
        mirror.dispatch(DocumentActions.loadChunk(i, new TextEncoder().encode(chunks[i])));
      }
      mirror.dispatch(DocumentActions.insert(byteOffset(2), "X"));
      mirror.dispatch(DocumentActions.insert(byteOffset(CHUNK_SIZE + 4), "Z"));
      mirror.dispatch(DocumentActions.undo());
      mirror.dispatch(DocumentActions.undo());
      const mirrorHistory = mirror.getSnapshot().history;
      const wrapped: DocumentStore = {
        ...store,
        dispatch: (action) => {
          if (action.type === "EVICT_CHUNKS" && action.keepHistory !== true) {
            mirror.dispatch(action);
          }
          return store.dispatch(action);
        },
      };
      const manager = createChunkManager(wrapped, makeLoader(chunks), {
        maxLoadedChunks: 2,
        logger: { warn },
      });
      await manager.ensureLoaded(0);
      pinChunk0(store);
      await manager.ensureLoaded(1);
      // Here the pass evicts chunk 1 at no cost to history.
      await manager.ensureLoaded(2);
      expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([0, 2]);
      expect(mirror.getSnapshot().history).not.toBe(mirrorHistory);
      expect(warn).not.toHaveBeenCalled();
      expect(mirrorWarn).toHaveBeenCalledTimes(1);
      expect(mirrorWarn.mock.calls[0]![0]).toContain("discarded 0 undo and 1 redo entries");
      manager.dispose();
    });
  });

  it("keeps the warning silent when the store's own logger has no warn", async () => {
    const store = createDocumentStore({
      chunkSize: CHUNK_SIZE,
      totalFileSize: CHUNK_SIZE * 3,
      historyEvictionPolicy: "pin-bounded",
      reconcileMode: "none",
      logger: { error: () => {} },
    });
    const warn = vi.fn();
    const manager = createChunkManager(store, makeLoader(chunks), {
      maxLoadedChunks: 2,
      logger: { warn },
    });
    await manager.ensureLoaded(0);
    pinChunk0(store);
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);
    expect(getRedoCount(store.getSnapshot())).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    manager.dispose();
  });

  describe("when the store has no logger", () => {
    const bare = () =>
      createDocumentStore({
        chunkSize: CHUNK_SIZE,
        totalFileSize: CHUNK_SIZE * 3,
        historyEvictionPolicy: "pin-bounded",
        reconcileMode: "none",
      });
    /** Have `manager` evict chunk 0, discarding the redo entry that pins it. */
    const evictPinned = async (
      store: DocumentStore,
      manager: ReturnType<typeof createChunkManager>,
    ) => {
      await manager.ensureLoaded(0);
      pinChunk0(store);
      manager.setActiveChunks([1, 2]);
      await manager.ensureLoaded(1);
      await manager.ensureLoaded(2);
      expect(getRedoCount(store.getSnapshot())).toBe(0);
    };

    it.each([
      ["the store itself", (store: DocumentStore): DocumentStore => store],
      ["a copy of the store", (store: DocumentStore): DocumentStore => ({ ...store })],
      [
        "a wrapper that forwards dispatch",
        (store: DocumentStore): DocumentStore => ({
          ...store,
          dispatch: (action) => store.dispatch({ ...action }),
        }),
      ],
      [
        "a wrapper that sends the action through serialization",
        (store: DocumentStore): DocumentStore => ({
          ...store,
          dispatch: (action) => store.dispatch(deserializeAction(serializeAction(action))),
        }),
      ],
      [
        "a wrapper that rebuilds the eviction",
        (store: DocumentStore): DocumentStore => ({
          ...store,
          dispatch: (action) =>
            store.dispatch(
              action.type === "EVICT_CHUNKS"
                ? DocumentActions.evictChunks(
                    [...action.chunkIndices],
                    action.maxLoaded,
                    action.keepHistory,
                  )
                : action,
            ),
        }),
      ],
    ])("warns through the manager's logger, given %s", async (_, wrap) => {
      const store = bare();
      const warn = vi.fn();
      const manager = createChunkManager(wrap(store), makeLoader(chunks), {
        maxLoadedChunks: 2,
        logger: { warn },
      });
      await evictPinned(store, manager);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("discarded 0 undo and 1 redo entries");
      manager.dispose();
    });

    it("warns through the manager's logger for a copy of a store with events", async () => {
      const store = createDocumentStoreWithEvents({
        chunkSize: CHUNK_SIZE,
        totalFileSize: CHUNK_SIZE * 3,
        historyEvictionPolicy: "pin-bounded",
        reconcileMode: "none",
      });
      const warn = vi.fn();
      const manager = createChunkManager({ ...store }, makeLoader(chunks), {
        maxLoadedChunks: 2,
        logger: { warn },
      });
      await evictPinned(store, manager);
      expect(warn).toHaveBeenCalledTimes(1);
      manager.dispose();
    });

    it("warns through the logger of the manager that evicts, not one dropped before it", async () => {
      const store = bare();
      const staleWarn = vi.fn();
      // Dropped without dispose.
      createChunkManager(store, makeLoader(chunks), { logger: { warn: staleWarn } });
      const warn = vi.fn();
      const manager = createChunkManager(store, makeLoader(chunks), {
        maxLoadedChunks: 2,
        logger: { warn },
      });
      await evictPinned(store, manager);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(staleWarn).not.toHaveBeenCalled();
      manager.dispose();
    });

    it("does not warn through the manager's logger for an eviction it did not dispatch", () => {
      const store = bare();
      const warn = vi.fn();
      const manager = createChunkManager(store, makeLoader(chunks), { logger: { warn } });
      for (const i of [0, 1] as const) {
        store.dispatch(DocumentActions.loadChunk(i, makeBytes(chunks[i])));
      }
      pinChunk0(store);
      store.dispatch(DocumentActions.evictChunks([0], 1));
      expect(getRedoCount(store.getSnapshot())).toBe(0);
      expect(warn).not.toHaveBeenCalled();
      manager.dispose();
    });

    it("does not credit another store's eviction to the manager whose dispatch runs", async () => {
      const store = bare();
      const other = bare();
      for (const i of [0, 1] as const) {
        other.dispatch(DocumentActions.loadChunk(i, makeBytes(chunks[i])));
      }
      pinChunk0(other);
      // While the manager's eviction notifies it, a listener evicts chunk 0
      // of an unrelated store, discarding its redo entry.
      let evicted = false;
      store.subscribe(() => {
        if (evicted || store.getSnapshot().pieceTable.chunkMap.has(0)) return;
        evicted = true;
        other.dispatch(DocumentActions.evictChunks([0], 1));
      });
      const warn = vi.fn();
      const manager = createChunkManager(store, makeLoader(chunks), {
        maxLoadedChunks: 2,
        logger: { warn },
      });
      await evictPinned(store, manager);
      expect(evicted).toBe(true);
      expect(getRedoCount(other.getSnapshot())).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      manager.dispose();
    });

    it("keeps a manager without a logger silent inside another manager's dispatch", async () => {
      const store = bare();
      const other = bare();
      // A manager without a logger, over its limit with every chunk active,
      // and a redo entry pinning chunk 0.
      const silent = createChunkManager(other, makeLoader(chunks), { maxLoadedChunks: 2 });
      await silent.ensureLoaded(0);
      pinChunk0(other);
      silent.setActiveChunks([0, 1, 2]);
      await silent.ensureLoaded(1);
      await silent.ensureLoaded(2);
      // While the logging manager's eviction notifies it, a listener lets the
      // silent manager evict chunk 0, discarding its redo entry.
      let released = false;
      store.subscribe(() => {
        if (released || store.getSnapshot().pieceTable.chunkMap.has(0)) return;
        released = true;
        silent.setActiveChunks([1, 2]);
      });
      const warn = vi.fn();
      const manager = createChunkManager(store, makeLoader(chunks), {
        maxLoadedChunks: 2,
        logger: { warn },
      });
      await evictPinned(store, manager);
      expect(released).toBe(true);
      expect(getRedoCount(other.getSnapshot())).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      manager.dispose();
      silent.dispose();
    });

    it("reports a manager logger's throw through that logger's error", async () => {
      const store = bare();
      const error = vi.fn();
      const manager = createChunkManager(store, makeLoader(chunks), {
        maxLoadedChunks: 2,
        logger: {
          warn: () => {
            throw new Error("sink down");
          },
          error,
        },
      });
      await evictPinned(store, manager);
      expect(error).toHaveBeenCalledWith(
        "The logger threw after an eviction committed",
        expect.anything(),
      );
      manager.dispose();
    });
  });

  describe("inside a transaction", () => {
    /** Load chunks 0-2 as active, with chunk 0 pinned by a redo entry. */
    const overLimit = async () => {
      const { store, manager, warn } = setup("pin-bounded");
      await manager.ensureLoaded(0);
      pinChunk0(store);
      manager.setActiveChunks([0, 1, 2]);
      await manager.ensureLoaded(1);
      await manager.ensureLoaded(2);
      warn.mockClear();
      return { store, manager, warn };
    };

    it("does not report history a rollback restores", async () => {
      const { store, manager, warn } = await overLimit();
      store.beginTransaction();
      manager.setActiveChunks([1, 2]);
      expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
      store.rollbackTransaction();
      expect(getRedoCount(store.getSnapshot())).toBe(1);
      expect(warn).not.toHaveBeenCalled();
      manager.dispose();
    });

    it("reports the history discarded once the outermost transaction commits", async () => {
      const { store, manager, warn } = await overLimit();
      store.beginTransaction();
      store.beginTransaction();
      manager.setActiveChunks([1, 2]);
      store.commitTransaction();
      expect(warn).not.toHaveBeenCalled();
      // A rollback of a later inner level keeps what the outer level holds.
      store.beginTransaction();
      store.rollbackTransaction();
      store.commitTransaction();
      expect(getRedoCount(store.getSnapshot())).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("discarded 0 undo and 1 redo entries");
      manager.dispose();
    });

    it("reports the committed loss when a listener disposes the store as it commits", async () => {
      const { store, manager, warn } = await overLimit();
      store.beginTransaction();
      manager.setActiveChunks([1, 2]);
      store.subscribe(() => store.dispose());
      store.commitTransaction();
      expect(getRedoCount(store.getSnapshot())).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("discarded 0 undo and 1 redo entries");
      manager.dispose();
    });

    it("does not report a loss a listener's still open transaction holds", async () => {
      const { store, manager, warn } = await overLimit();
      // As the outer transaction commits, a listener opens one of its own and
      // evicts chunk 0 there, discarding the redo entry, but leaves it open.
      let opened = false;
      const unsubscribe = store.subscribe(() => {
        if (opened) return;
        opened = true;
        store.beginTransaction();
        manager.setActiveChunks([1, 2]);
      });
      store.beginTransaction();
      store.dispatch(
        DocumentActions.setSelection([{ anchor: byteOffset(1), head: byteOffset(1) }]),
      );
      store.commitTransaction();
      unsubscribe();
      expect(opened).toBe(true);
      expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      store.rollbackTransaction();
      expect(getRedoCount(store.getSnapshot())).toBe(1);
      expect(warn).not.toHaveBeenCalled();
      manager.dispose();
    });

    it("does not report history an outer rollback restores", async () => {
      const { store, manager, warn } = await overLimit();
      store.beginTransaction();
      store.beginTransaction();
      manager.setActiveChunks([1, 2]);
      store.commitTransaction();
      store.rollbackTransaction();
      expect(getRedoCount(store.getSnapshot())).toBe(1);
      expect(warn).not.toHaveBeenCalled();
      manager.dispose();
    });
  });

  it("stops the pass when a listener disposes the manager during the eviction", async () => {
    const store = createDocumentStore({
      chunkSize: CHUNK_SIZE,
      totalFileSize: CHUNK_SIZE * 3,
      historyEvictionPolicy: "pin",
      reconcileMode: "none",
    });
    const warn = vi.fn();
    const manager = createChunkManager(store, makeLoader(chunks), {
      maxLoadedChunks: 1,
      logger: { warn },
    });
    manager.setActiveChunks([0, 1, 2]);
    for (const i of [0, 1, 2]) await manager.ensureLoaded(i);
    pinChunk0(store);
    let disposedByListener = false;
    store.subscribe(() => {
      if (disposedByListener || store.getSnapshot().pieceTable.chunkMap.has(1)) return;
      disposedByListener = true;
      manager.dispose();
    });
    warn.mockClear();
    // History pins chunk 0, so the pass would stay over the limit and warn.
    manager.setActiveChunks([]);
    expect(disposedByListener).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not report history discarded for an edit a listener makes while the pass evicts", async () => {
    const { store, manager, warn } = setup("pin-bounded");
    await manager.ensureLoaded(0);
    pinChunk0(store);
    await manager.ensureLoaded(1);
    // Typing clears the redo entry, and pushes an undo one, while the pass
    // evicts chunk 1 at no cost to history.
    let typed = false;
    store.subscribe(() => {
      if (typed || store.getSnapshot().pieceTable.chunkMap.has(1)) return;
      typed = true;
      store.dispatch(DocumentActions.insert(byteOffset(0), "Y"));
    });
    await manager.ensureLoaded(2);

    expect(typed).toBe(true);
    expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([0, 2]);
    expect(getUndoCount(store.getSnapshot())).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("reports only the eviction's loss through a store that coalesces notifications", async () => {
    const { store: base, warn } = setup("pin-bounded");
    // A wrapper Reed did not build, which notifies its listeners once per
    // outermost dispatch and folds in whatever they dispatch meanwhile.
    const listeners = new Set<() => void>();
    let depth = 0;
    let dirty = false;
    let notifying = false;
    base.subscribe(() => {
      dirty = true;
    });
    const store: DocumentStore = {
      ...base,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispatch(action) {
        depth++;
        try {
          base.dispatch(action);
        } finally {
          depth--;
        }
        if (depth === 0 && dirty && !notifying) {
          dirty = false;
          notifying = true;
          try {
            for (const listener of listeners) listener();
          } finally {
            notifying = false;
          }
        }
        return base.getSnapshot();
      },
    };
    const manager = createChunkManager(store, makeLoader(chunks), {
      maxLoadedChunks: 2,
      logger: { warn },
    });
    await manager.ensureLoaded(0);
    pinChunk0(store);
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    let typed = false;
    store.subscribe(() => {
      if (typed || store.getSnapshot().pieceTable.chunkMap.has(0)) return;
      typed = true;
      store.dispatch(DocumentActions.insert(byteOffset(0), "Y"));
    });
    await manager.ensureLoaded(2);

    expect(typed).toBe(true);
    expect(getUndoCount(store.getSnapshot())).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("discarded 0 undo and 1 redo entries");
    manager.dispose();
  });

  it("measures an anchored chunk's edits again once a load parts it from them", async () => {
    const store = createDocumentStore({
      chunkSize: CHUNK_SIZE,
      totalFileSize: CHUNK_SIZE * 6,
      historyEvictionPolicy: "drop",
      reconcileMode: "none",
    });
    const six = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i, `${i}`.repeat(8)]));
    const warn = vi.fn();
    const manager = createChunkManager(store, makeLoader(six), {
      maxLoadedChunks: 1,
      logger: { warn },
    });
    manager.setActiveChunks([2, 4]);
    for (const i of [2, 4]) await manager.ensureLoaded(i);
    // Text typed at the seam of chunks 2 and 4 touches both, and an attention
    // is anchored inside chunk 4.
    store.dispatch(DocumentActions.insert(byteOffset(CHUNK_SIZE), "X"));
    store.dispatch(DocumentActions.createAttention(byteOffset(11), byteOffset(13)));
    // Loading both while pinned already warned; count from the unpinning.
    warn.mockClear();
    manager.setActiveChunks([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(
      "1 hold an attention anchor, 1 of which also hold user edits or undo history",
    );

    // Chunk 3 loads between that text and chunk 4, so no edit touches chunk 4.
    await manager.ensureLoaded(3);
    expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([2, 3, 4]);
    expect(warn).toHaveBeenCalledTimes(2);
    const message = warn.mock.calls[1]![0] as string;
    expect(message).toContain("1 hold an attention anchor;");
    expect(message).not.toContain("of which");
    manager.dispose();
  });

  it("stays over the limit under 'pin' and says how to bound it", async () => {
    const { store, manager, warn } = setup("pin");
    await manager.ensureLoaded(0);
    pinChunk0(store);
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);

    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"pin-bounded"'));
    manager.dispose();
  });
});

describe("ChunkManager eviction transition", () => {
  it("evicts down to the limit with a single EVICT_CHUNKS dispatch", async () => {
    const store = createDocumentStore({ chunkSize: CHUNK_SIZE, totalFileSize: CHUNK_SIZE * 3 });
    const chunks = { 0: "aaaaaaa\n", 1: "bbbbbbb\n", 2: "ccccccc\n" };
    const manager = createChunkManager(store, makeLoader(chunks), { maxLoadedChunks: 1 });
    manager.setActiveChunks([0, 1, 2]);
    for (const i of [0, 1, 2]) await manager.ensureLoaded(i);
    const dispatch = vi.spyOn(store, "dispatch");
    // Unpinning puts all three over the limit of one.
    manager.setActiveChunks([]);
    const evictions = dispatch.mock.calls.filter(([action]) => action.type.startsWith("EVICT"));
    // Every unpinned chunk is offered; the reducer stops once two have gone.
    expect(evictions).toEqual([[DocumentActions.evictChunks([0, 1, 2], 1)]]);
    expect([...store.getSnapshot().pieceTable.chunkMap.keys()]).toEqual([2]);
    manager.dispose();
  });
});

describe("ChunkManager eviction that discards history", () => {
  const CHUNK_COUNT = 6;
  const content = (i: number) => String.fromCharCode(97 + i).repeat(CHUNK_SIZE - 1) + "\n";
  const lossOf = (state: DocumentState, chunk: number) => {
    const loss = evictionCandidate(state, chunk)?.loss;
    return loss === undefined ? null : loss.undo + loss.redo;
  };

  /**
   * The eviction the manager should do, measuring every loss again after each
   * eviction: chunks that cost no history first, least recently used first,
   * then under "pin-bounded" the one that costs the fewest entries, and under
   * "drop" the least recently used.
   */
  function referenceEviction(
    start: DocumentState,
    lru: readonly number[],
    max: number,
    policy: HistoryEvictionPolicy,
  ): DocumentState {
    let state = start;
    for (const chunk of lru) {
      if (state.pieceTable.chunkMap.size <= max) break;
      if (lossOf(state, chunk) === 0) {
        state = documentReducer(state, DocumentActions.evictChunk(chunk));
      }
    }
    while (state.pieceTable.chunkMap.size > max) {
      let best: number | undefined;
      let bestLoss = Infinity;
      for (const chunk of lru) {
        if (!state.pieceTable.chunkMap.has(chunk)) continue;
        const loss = lossOf(state, chunk);
        if (loss === null) continue;
        if (policy === "drop") {
          best = chunk;
          break;
        }
        if (loss < bestLoss) {
          best = chunk;
          bestLoss = loss;
        }
      }
      if (best === undefined) break;
      const next = documentReducer(state, DocumentActions.evictChunk(best, true));
      if (next === state) break;
      state = next;
    }
    return state;
  }

  it.each(["pin-bounded", "drop"] as const)(
    "matches measuring every loss again after each eviction under '%s'",
    async (policy) => {
      for (let seed = 1; seed <= 40; seed++) {
        const rng = makeDeterministicRng(seed);
        const store = createDocumentStore({
          chunkSize: CHUNK_SIZE,
          totalFileSize: CHUNK_SIZE * CHUNK_COUNT,
          historyEvictionPolicy: policy,
          reconcileMode: "none",
        });
        const chunks = Object.fromEntries(
          Array.from({ length: CHUNK_COUNT }, (_, i) => [i, content(i)]),
        );
        const max = randomInt(rng, 1, 3);
        const manager = createChunkManager(store, makeLoader(chunks), { maxLoadedChunks: max });
        const all = Array.from({ length: CHUNK_COUNT }, (_, i) => i);
        // Pin everything while loading, so the LRU order is the load order.
        manager.setActiveChunks(all);
        for (const i of all) await manager.ensureLoaded(i);
        // Type and delete inside random chunks: each chunk is pristine again,
        // but undo entries point inside it. Undo some of them into redo.
        const rounds = randomInt(rng, 1, 8);
        for (let r = 0; r < rounds; r++) {
          const at = byteOffset(
            randomInt(rng, 0, CHUNK_COUNT - 1) * CHUNK_SIZE + randomInt(rng, 1, 6),
          );
          store.dispatch(DocumentActions.insert(at, "X"));
          store.dispatch(DocumentActions.delete(at, byteOffset(at + 1)));
        }
        const undos = randomInt(rng, 0, rounds * 2);
        for (let u = 0; u < undos; u++) store.dispatch(DocumentActions.undo());
        // Carets in random chunks, carried across every eviction.
        const length = store.getSnapshot().pieceTable.totalLength;
        const caret = () => byteOffset(randomInt(rng, 0, length));
        const at = [caret(), caret(), caret()] as const;
        store.dispatch(
          DocumentActions.setSelection([
            { anchor: at[0], head: at[0] },
            { anchor: at[1], head: at[1] },
            { anchor: at[2], head: at[2] },
          ]),
        );

        const expected = referenceEviction(store.getSnapshot(), all, max, policy);
        manager.setActiveChunks([]);
        const actual = store.getSnapshot();
        const context = `seed ${seed}, max ${max}`;
        expect([...actual.pieceTable.chunkMap.keys()].sort(), context).toEqual(
          [...expected.pieceTable.chunkMap.keys()].sort(),
        );
        expect(getUndoCount(actual), context).toBe(getUndoCount(expected));
        expect(getRedoCount(actual), context).toBe(getRedoCount(expected));
        expect(actual.selection, context).toEqual(expected.selection);
        manager.dispose();
      }
    },
  );
});

describe("ChunkManager.prefetch", () => {
  it("fires a background load without blocking", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb" });
    const manager = createChunkManager(store, loader);

    manager.prefetch(0); // fire and forget
    // Allow the asynchronous fetch to finish before checking the loaded chunk.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(true);
    manager.dispose();
  });

  it("is a no-op for a chunk already in memory", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb" });
    const manager = createChunkManager(store, loader);

    await manager.ensureLoaded(0);
    const callsBefore = loader.loadChunk.mock.calls.length;
    manager.prefetch(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loader.loadChunk.mock.calls.length).toBe(callsBefore);
    manager.dispose();
  });

  it("ignores invalid chunk indices", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb" });
    const manager = createChunkManager(store, loader);

    manager.prefetch(-1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loader.loadChunk).not.toHaveBeenCalled();
    manager.dispose();
  });
});

describe("ChunkManager.cancelPendingOutside", () => {
  it("does not commit canceled bytes already fetched by a pending batch", async () => {
    const store = makeStore();
    let finishSecond!: (bytes: Uint8Array) => void;
    const manager = createChunkManager(store, {
      loadChunk: async (index) =>
        index === 0
          ? makeBytes("aaaabbbb")
          : new Promise<Uint8Array>((resolve) => {
              finishSecond = resolve;
            }),
    });
    const pending = manager.ensureLoadedMany([0, 1]);
    // Let chunk 0 finish while chunk 1 keeps the batch pending.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    manager.cancelPendingOutside([1]);
    finishSecond(makeBytes("ccccdddd"));
    await pending;
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
    expect(store.getSnapshot().pieceTable.chunkMap.has(1)).toBe(true);
    manager.dispose();
    store.dispose();
  });

  it.each(["single", "batch"] as const)(
    "retries canceled %s loads before settlement",
    async (mode) => {
      const store = makeStore();
      const resolvers: Array<(bytes: Uint8Array) => void> = [];
      const loadChunk = vi.fn(() => new Promise<Uint8Array>((resolve) => resolvers.push(resolve)));
      const manager = createChunkManager(store, { loadChunk });
      const load = () =>
        mode === "single" ? manager.ensureLoaded(0) : manager.ensureLoadedMany([0]);
      const stale = load();
      manager.cancelPendingOutside([]);
      const retry = load();
      expect(loadChunk).toHaveBeenCalledTimes(2);
      // A loader that ignores abort must not remove the replacement request.
      resolvers[0]!(makeBytes("staledat"));
      await stale;
      expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
      const duplicate = load();
      expect(loadChunk).toHaveBeenCalledTimes(2);
      resolvers[1]!(makeBytes("new data"));
      await Promise.all([retry, duplicate]);
      expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(true);
      manager.dispose();
      store.dispose();
    },
  );

  it("does not start canceled work that is waiting in the fetch queue", async () => {
    const store = makeStore();
    let resolveFirst!: (bytes: Uint8Array) => void;
    const firstLoad = new Promise<Uint8Array>((resolve) => {
      resolveFirst = resolve;
    });
    const loadChunk = vi.fn((chunkIndex: number) =>
      chunkIndex === 0 ? firstLoad : Promise.resolve(makeBytes("ccccdddd")),
    );
    const manager = createChunkManager(store, { loadChunk }, { fetchStrategy: "queue" });

    const first = manager.ensureLoaded(0);
    const canceled = manager.ensureLoaded(1);
    await Promise.resolve();
    manager.cancelPendingOutside([0]);
    resolveFirst(makeBytes("aaaabbbb"));
    await Promise.all([first, canceled]);

    expect(loadChunk).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(true);
    expect(store.getSnapshot().pieceTable.chunkMap.has(1)).toBe(false);
    await manager.ensureLoaded(1);
    expect(loadChunk).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().pieceTable.chunkMap.has(1)).toBe(true);
    manager.dispose();
    store.dispose();
  });
});
describe("ChunkManager.dispose", () => {
  it("prevents ensureLoaded from dispatching after disposal", async () => {
    const store = makeStore();
    let resolveLoad!: (v: Uint8Array) => void;
    const pending = new Promise<Uint8Array>((resolve) => {
      resolveLoad = resolve;
    });
    const loader = { loadChunk: vi.fn(() => pending) };
    const manager = createChunkManager(store, loader);

    const promise = manager.ensureLoaded(0);
    manager.dispose(); // dispose before fetch completes
    resolveLoad(makeBytes("aaaabbbb")); // now finish the fetch

    await promise; // resolves (no rejection)
    // Check that the chunk was not dispatched into the store.
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
  });

  it("makes ensureLoaded a no-op after dispose", async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: "aaaabbbb" });
    const manager = createChunkManager(store, loader);
    manager.dispose();

    await manager.ensureLoaded(0); // should resolve immediately, no fetch
    expect(loader.loadChunk.mock.calls.length).toBe(0);
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
  });

  it("aborts cooperative in-flight loads and resolves without dispatching", async () => {
    const store = makeStore();
    let receivedSignal: AbortSignal | undefined;
    const loader = {
      loadChunk: vi.fn((_chunkIndex: number, signal?: AbortSignal): Promise<Uint8Array> => {
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    };
    const manager = createChunkManager(store, loader);

    const pending = manager.ensureLoaded(0);
    manager.dispose();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).resolves.toBeUndefined();
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
  });
});

describe("ChunkManager config validation", () => {
  it("throws when maxLoadedChunks is NaN", () => {
    const store = makeStore();
    expect(() => createChunkManager(store, makeLoader({}), { maxLoadedChunks: NaN })).toThrow(
      /maxLoadedChunks must be a positive integer/,
    );
  });

  it("throws when maxLoadedChunks is Infinity", () => {
    const store = makeStore();
    expect(() => createChunkManager(store, makeLoader({}), { maxLoadedChunks: Infinity })).toThrow(
      /maxLoadedChunks must be a positive integer/,
    );
  });

  it("throws when maxLoadedChunks is below 1", () => {
    const store = makeStore();
    expect(() => createChunkManager(store, makeLoader({}), { maxLoadedChunks: 0 })).toThrow(
      /maxLoadedChunks must be a positive integer/,
    );
  });

  it("throws for an invalid fetchStrategy", () => {
    const store = makeStore();
    expect(() =>
      createChunkManager(store, makeLoader({}), {
        fetchStrategy: "serial" as unknown as "queue",
      }),
    ).toThrow("fetchStrategy must be 'parallel' or 'queue'");
  });
});

describe("ChunkManager chunk integrity", () => {
  it("rejects with a descriptive error when the loader returns more bytes than chunkSize", async () => {
    const store = makeStore(); // chunkSize = 8
    const loader = { loadChunk: vi.fn(async () => makeBytes("aaaabbbbcccc")) }; // 12 > 8
    const manager = createChunkManager(store, loader);

    await expect(manager.ensureLoaded(0)).rejects.toThrow(/violates the declared file geometry/);
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
    manager.dispose();
  });

  it("rejects when the loader contradicts a chunk's declared byteLength", async () => {
    const store = makeStore(); // chunkSize = 8
    store.dispatch(
      DocumentActions.declareChunkMetadata([{ chunkIndex: 0, byteLength: 4, lineCount: 1 }]),
    );
    const loader = { loadChunk: vi.fn(async () => makeBytes("aaaabbbb")) }; // 8 ≠ 4
    const manager = createChunkManager(store, loader);

    await expect(manager.ensureLoaded(0)).rejects.toThrow(/declared byteLength=4/);
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
    manager.dispose();
  });
});

it("commits fast batch results while a slow chunk remains pending", async () => {
  const store = makeStore();
  let finishSlow!: (bytes: Uint8Array) => void;
  const manager = createChunkManager(store, {
    loadChunk: async (index) =>
      index === 0
        ? makeBytes("aaaabbbb")
        : new Promise<Uint8Array>((resolve) => {
            finishSlow = resolve;
          }),
  });
  let settled = false;
  const pending = manager.ensureLoadedMany([0, 1]).then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(true));
  expect(settled).toBe(false);
  finishSlow(makeBytes("ccccdddd"));
  await pending;
  expect(store.getSnapshot().pieceTable.chunkMap.has(1)).toBe(true);
  manager.dispose();
  store.dispose();
});

it("bounds batch fetch concurrency and continues after individual failures", async () => {
  const store = makeStore();
  const resolvers = new Map<number, (bytes: Uint8Array) => void>();
  const loadChunk = vi.fn(
    (index: number) =>
      new Promise<Uint8Array>((resolve, reject) => {
        if (index === 0) reject(new Error("fetch failed"));
        else resolvers.set(index, resolve);
      }),
  );
  const manager = createChunkManager(store, { loadChunk }, { maxConcurrentFetches: 2 });
  const pending = manager.ensureLoadedMany([0, 1, 2, 3]);
  const rejected = expect(pending).rejects.toThrow("fetch failed");
  expect(loadChunk).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(resolvers.has(2)).toBe(true));
  expect(loadChunk).toHaveBeenCalledTimes(3);
  resolvers.get(1)!(makeBytes("ccccdddd"));
  await vi.waitFor(() => expect(resolvers.has(3)).toBe(true));
  expect(loadChunk).toHaveBeenCalledTimes(4);
  resolvers.get(2)!(makeBytes("eeeeffff"));
  resolvers.get(3)!(makeBytes("gggghhhh"));
  await rejected;
  expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([1, 2, 3]);
  manager.dispose();
  store.dispose();
});

it.each([0, -1, NaN, 1.5, Infinity])(
  "rejects invalid fetch concurrency %s",
  (maxConcurrentFetches) => {
    const store = makeStore();
    expect(() => createChunkManager(store, makeLoader({}), { maxConcurrentFetches })).toThrow(
      "maxConcurrentFetches must be a positive integer",
    );
    store.dispose();
  },
);

describe("ChunkManager eviction after another path evicted a chunk", () => {
  it("does not offer a chunk that is already gone", async () => {
    const store = createDocumentStore({ chunkSize: CHUNK_SIZE, totalFileSize: CHUNK_SIZE * 4 });
    const chunks = { 0: "aaaaaaa\n", 1: "bbbbbbb\n", 2: "ccccccc\n", 3: "ddddddd\n" };
    const manager = createChunkManager(store, makeLoader(chunks), { maxLoadedChunks: 2 });
    manager.setActiveChunks([0, 1, 2, 3]);
    for (const i of [0, 1, 2, 3]) await manager.ensureLoaded(i);
    // Evicted behind the manager's back: still first in its LRU order.
    store.dispatch(DocumentActions.evictChunk(0));
    const dispatch = vi.spyOn(store, "dispatch");
    manager.setActiveChunks([]);
    const evictions = dispatch.mock.calls.filter(([action]) => action.type.startsWith("EVICT"));
    expect(evictions).toEqual([[DocumentActions.evictChunks([1, 2, 3], 2)]]);
    expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([2, 3]);
    manager.dispose();
  });
});
