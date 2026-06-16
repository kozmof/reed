import { describe, it, expect, vi } from "vitest";
import { createDocumentStore } from "./store.ts";
import { createStreamingDocumentLoader } from "./streaming-loader.ts";

describe("StreamingDocumentLoader", () => {
  it("suppresses stale prefetches after a newer viewport supersedes an older one", async () => {
    const store = createDocumentStore();
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
