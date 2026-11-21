/**
 * Test that the eviction pressure warning does not visit the piece tree again
 * on passes that cannot report anything new.
 */

import { describe, it, expect, vi } from "vitest";
import { byteOffset } from "../../types/branded.js";
import { DocumentActions } from "./actions.js";
import { createChunkManager } from "./chunk-manager.js";
import { createDocumentStore } from "./store.js";
import * as chunkActions from "./chunk-actions.js";

vi.mock("./chunk-actions.js", async (importOriginal) => {
  const original = await importOriginal<typeof chunkActions>();
  return {
    ...original,
    hasAttentionAnchoredToChunk: vi.fn(original.hasAttentionAnchoredToChunk),
    chunkHoldReason: vi.fn(original.chunkHoldReason),
  };
});

const CHUNK_SIZE = 8;
const chunks: Record<number, string> = { 0: "aaaaaaa\n", 1: "bbbbbbb\n", 2: "ccccccc\n" };
const loader = {
  loadChunk: async (i: number) => new TextEncoder().encode(chunks[i]!),
};

describe("ChunkManager eviction pressure warning", () => {
  it("does not visit the piece tree again while the document stays as it was", async () => {
    const store = createDocumentStore({
      chunkSize: CHUNK_SIZE,
      totalFileSize: CHUNK_SIZE * 3,
      reconcileMode: "none",
    });
    const warn = vi.fn();
    const manager = createChunkManager(store, loader, { maxLoadedChunks: 2, logger: { warn } });
    await manager.ensureLoaded(0);
    // Only the attention keeps chunk 0 resident.
    store.dispatch(DocumentActions.createAttention(byteOffset(1), byteOffset(3)));
    manager.setActiveChunks([1, 2]);
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("1 hold an attention anchor");

    const anchored = vi.mocked(chunkActions.hasAttentionAnchoredToChunk);
    const holdReason = vi.mocked(chunkActions.chunkHoldReason);
    anchored.mockClear();
    holdReason.mockClear();
    // Scrolling within the same chunks: each call runs a pass, over the limit.
    for (let i = 0; i < 10; i++) manager.setActiveChunks(i % 2 === 0 ? [2, 1] : [1, 2]);
    expect(store.getSnapshot().pieceTable.chunkMap.size).toBe(3);
    expect(anchored).not.toHaveBeenCalled();
    expect(holdReason).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    // A change to the document measures again.
    store.dispatch(DocumentActions.insert(byteOffset(2), "X"));
    manager.setActiveChunks([1, 2]);
    expect(anchored).toHaveBeenCalled();
    manager.dispose();
  });
});
