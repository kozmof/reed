import { describe, it, expect, vi } from "vitest";
import { createDocumentStore } from "./store.js";
import { createStreamingDocumentLoader } from "./streaming-loader.js";

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
});
