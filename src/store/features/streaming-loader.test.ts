import { describe, it, expect, vi } from "vitest";
import { createDocumentStore } from "./store.js";
import { createStreamingDocumentLoader } from "./streaming-loader.js";
import { getValue } from "../core/piece-table.js";

describe("StreamingDocumentLoader", () => {
  it("setViewport throws on invalid chunk range (start > end)", async () => {
    const store = createDocumentStore({ chunkSize: 1 });
    const metadata = [
      { chunkIndex: 0, byteLength: 1, lineCount: 1 },
      { chunkIndex: 1, byteLength: 1, lineCount: 1 },
    ];
    const loader = createStreamingDocumentLoader(
      store,
      { loadChunk: async () => new Uint8Array([0]), totalChunkCount: 2 },
      metadata,
    );
    await expect(loader.setViewport(3, 1)).rejects.toThrow(
      "setViewport: invalid chunk range [3, 1]",
    );
    loader.dispose();
  });

  it("rejects non-chunked stores at construction time", () => {
    const store = createDocumentStore();
    const loader = { loadChunk: vi.fn(async () => new Uint8Array([0])) };

    expect(() => createStreamingDocumentLoader(store, loader, [])).toThrow(
      "StreamingDocumentLoader requires a store configured with chunkSize > 0",
    );
  });

  it("suppresses stale prefetches after a newer viewport supersedes an older one", async () => {
    const store = createDocumentStore({ chunkSize: 1 });
    let resolveChunk0: (() => void) | undefined;
    let resolveChunk4: (() => void) | undefined;

    const loadChunk = vi.fn(async (chunkIndex: number): Promise<Uint8Array> => {
      await new Promise<void>((resolve) => {
        if (chunkIndex === 0) {
          resolveChunk0 = resolve;
          return;
        }
        if (chunkIndex === 4) {
          resolveChunk4 = resolve;
          return;
        }
        resolve();
      });
      return new TextEncoder().encode(String(chunkIndex));
    });

    const loader = {
      loadChunk,
      totalChunkCount: 5,
    };
    const metadata = Array.from({ length: 5 }, (_, chunkIndex) => ({
      chunkIndex,
      byteLength: 1,
      lineCount: 1,
    }));
    const streamingLoader = createStreamingDocumentLoader(store, loader, metadata, {
      prefetchWindowSize: 1,
      chunkManagerConfig: { maxLoadedChunks: 10 },
    });

    const firstViewport = streamingLoader.setViewport(0, 0);
    const secondViewport = streamingLoader.setViewport(4, 4);

    resolveChunk4?.();
    await secondViewport;
    expect(loadChunk.mock.calls.map(([chunkIndex]) => chunkIndex)).toEqual([0, 4, 3]);

    resolveChunk0?.();
    await firstViewport;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadChunk.mock.calls.map(([chunkIndex]) => chunkIndex)).toEqual([0, 4, 3]);
    streamingLoader.dispose();
  });

  it("trims late chunks from a superseded multi-chunk viewport", async () => {
    const store = createDocumentStore({ chunkSize: 1 });
    const resolvers = new Map<number, () => void>();
    const loadChunk = vi.fn(async (chunkIndex: number): Promise<Uint8Array> => {
      if (chunkIndex < 2) {
        await new Promise<void>((resolve) => {
          resolvers.set(chunkIndex, resolve);
        });
      }
      return new TextEncoder().encode(String(chunkIndex));
    });
    const metadata = Array.from({ length: 6 }, (_, chunkIndex) => ({
      chunkIndex,
      byteLength: 1,
      lineCount: 0,
    }));
    const streamingLoader = createStreamingDocumentLoader(
      store,
      { loadChunk, totalChunkCount: metadata.length },
      metadata,
      {
        prefetchWindowSize: 0,
        chunkManagerConfig: { maxLoadedChunks: 2 },
      },
    );

    const staleViewport = streamingLoader.setViewport(0, 1);
    await vi.waitFor(() => expect(resolvers.size).toBe(2));

    await streamingLoader.setViewport(4, 5);
    expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([4, 5]);

    resolvers.get(0)?.();
    resolvers.get(1)?.();
    await staleViewport;

    expect([...store.getSnapshot().pieceTable.chunkMap.keys()].sort()).toEqual([4, 5]);
    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(2);
    streamingLoader.dispose();
  });

  it("preserves chunk order across viewport eviction and out-of-order reload", async () => {
    const chunks = ["A\n", "B\n", "C\n", "D"];
    const store = createDocumentStore({
      chunkSize: 2,
      totalFileSize: chunks.reduce((total, chunk) => total + chunk.length, 0),
      reconcileMode: "none",
    });
    const loadChunk = vi.fn(async (chunkIndex: number) =>
      new TextEncoder().encode(chunks[chunkIndex]),
    );
    const metadata = chunks.map((chunk, chunkIndex) => ({
      chunkIndex,
      byteLength: chunk.length,
      lineCount: 1,
    }));
    const loader = createStreamingDocumentLoader(
      store,
      { loadChunk, totalChunkCount: chunks.length },
      metadata,
      {
        prefetchWindowSize: 0,
        chunkManagerConfig: { maxLoadedChunks: 2 },
      },
    );

    await loader.setViewport(0, 1);
    expect(getValue(store.getSnapshot().pieceTable)).toBe("A\nB\n");

    await loader.setViewport(2, 3);
    expect(getValue(store.getSnapshot().pieceTable)).toBe("C\nD");
    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(2);

    await loader.setViewport(1, 2);
    expect(getValue(store.getSnapshot().pieceTable)).toBe("B\nC\n");
    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(2);
    expect(loadChunk.mock.calls.map(([chunkIndex]) => chunkIndex)).toEqual([0, 1, 2, 3, 1]);

    loader.dispose();
  });

  it("rejects metadata with a duplicate chunk index at construction", () => {
    const store = createDocumentStore({ chunkSize: 1 });
    const loader = { loadChunk: vi.fn(async () => new Uint8Array([0])) };
    expect(() =>
      createStreamingDocumentLoader(store, loader, [
        { chunkIndex: 0, byteLength: 1, lineCount: 1 },
        { chunkIndex: 0, byteLength: 1, lineCount: 1 },
      ]),
    ).toThrow(/duplicate chunk metadata for index 0/);
  });

  it("rejects metadata with an out-of-range chunk index at construction", () => {
    const store = createDocumentStore({ chunkSize: 1 });
    const loader = { loadChunk: vi.fn(async () => new Uint8Array([0])) };
    // Two entries (totalChunks === 2) but an index of 5 leaves index 1 uncovered.
    expect(() =>
      createStreamingDocumentLoader(store, loader, [
        { chunkIndex: 0, byteLength: 1, lineCount: 1 },
        { chunkIndex: 5, byteLength: 1, lineCount: 1 },
      ]),
    ).toThrow(/out of range/);
  });

  it("setViewport rejects a range entirely beyond the last chunk", async () => {
    const store = createDocumentStore({ chunkSize: 1 });
    const loadChunk = vi.fn(async () => new Uint8Array([0]));
    const metadata = [
      { chunkIndex: 0, byteLength: 1, lineCount: 1 },
      { chunkIndex: 1, byteLength: 1, lineCount: 1 },
    ];
    const loader = createStreamingDocumentLoader(
      store,
      { loadChunk, totalChunkCount: 2 },
      metadata,
    );

    await expect(loader.setViewport(5, 9)).rejects.toThrow(/out of range for 2 chunks/);
    expect(loadChunk).not.toHaveBeenCalled();
    loader.dispose();
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid prefetchWindowSize %s",
    (prefetchWindowSize) => {
      const store = createDocumentStore({ chunkSize: 1 });
      const chunkLoader = { loadChunk: vi.fn(async () => new Uint8Array([0])) };
      expect(() =>
        createStreamingDocumentLoader(store, chunkLoader, [], { prefetchWindowSize }),
      ).toThrow(/prefetchWindowSize must be a non-negative integer/);
      store.dispose();
    },
  );

  it("rejects invalid manager config before mutating the store", () => {
    const store = createDocumentStore({ chunkSize: 4, totalFileSize: 4 });
    const listener = vi.fn();
    store.subscribe(listener);
    const chunkLoader = {
      totalChunkCount: 1,
      loadChunk: vi.fn(async () => new Uint8Array([0, 0, 0, 0])),
    };

    expect(() =>
      createStreamingDocumentLoader(
        store,
        chunkLoader,
        [{ chunkIndex: 0, byteLength: 4, lineCount: 1 }],
        { chunkManagerConfig: { maxLoadedChunks: 0 } },
      ),
    ).toThrow(/maxLoadedChunks must be a positive integer/);
    expect(store.getSnapshot().pieceTable.chunkMetadata.size).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    store.dispose();
  });

  it("rejects invalid metadata values before mutating the store", () => {
    const store = createDocumentStore({ chunkSize: 4 });
    const chunkLoader = { loadChunk: vi.fn(async () => new Uint8Array([0])) };

    expect(() =>
      createStreamingDocumentLoader(store, chunkLoader, [
        { chunkIndex: 0, byteLength: 4, lineCount: -1 },
      ]),
    ).toThrow(/chunk metadata requires/);
    expect(store.getSnapshot().lineIndex.unloadedLineCount).toBe(0);
    store.dispose();
  });

  it("rejects metadata that contradicts known file geometry", () => {
    const store = createDocumentStore({ chunkSize: 4, totalFileSize: 6 });
    const chunkLoader = {
      totalChunkCount: 2,
      loadChunk: vi.fn(async () => new Uint8Array([0])),
    };

    expect(() =>
      createStreamingDocumentLoader(store, chunkLoader, [
        { chunkIndex: 0, byteLength: 4, lineCount: 0 },
        { chunkIndex: 1, byteLength: 1, lineCount: 0 },
      ]),
    ).toThrow(/chunk 1 declares 1 bytes; expected 2/);
    store.dispose();
  });
});
