/**
 * Tests for ChunkManager — async chunk fetch subsystem (issue #009, Part 4).
 * Verifies deduplication, LRU eviction, pinning, prefetch, and dispose behaviour.
 */

import { describe, it, expect, vi } from 'vitest';
import { createChunkManager } from './chunk-manager.ts';
import { createDocumentStore } from './store.ts';

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
    return makeBytes(chunks[i]);
  });
  return { loadChunk };
}

describe('ChunkManager.ensureLoaded', () => {
  it('dispatches LOAD_CHUNK and resolves when chunk arrives', async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: 'aaaabbbb' });
    const manager = createChunkManager(store, loader);

    await manager.ensureLoaded(0);

    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(true);
    manager.dispose();
  });

  it('resolves immediately if chunk is already in memory', async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: 'aaaabbbb' });
    const manager = createChunkManager(store, loader);

    await manager.ensureLoaded(0);
    const callsBefore = loader.loadChunk.mock.calls.length;
    await manager.ensureLoaded(0); // second call — already loaded
    expect(loader.loadChunk.mock.calls.length).toBe(callsBefore); // no extra fetch
    manager.dispose();
  });

  it('deduplicates concurrent requests for the same chunk', async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: 'aaaabbbb' });
    const manager = createChunkManager(store, loader);

    const [p1, p2, p3] = [
      manager.ensureLoaded(0),
      manager.ensureLoaded(0),
      manager.ensureLoaded(0),
    ];
    await Promise.all([p1, p2, p3]);

    // Only one fetch should have been issued
    expect(loader.loadChunk.mock.calls.length).toBe(1);
    manager.dispose();
  });

  it('loads chunks out-of-order (random access)', async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: 'aaaabbbb', 2: 'ccccdddd' });
    const manager = createChunkManager(store, loader);

    await manager.ensureLoaded(2); // chunk 2 before chunk 0
    expect(store.getSnapshot().pieceTable.chunkMap.has(2)).toBe(true);
    manager.dispose();
  });

  it('rejects (throws) when the loader throws', async () => {
    const store = makeStore();
    const loader = { loadChunk: vi.fn(async () => { throw new Error('network error'); }) };
    const manager = createChunkManager(store, loader);

    await expect(manager.ensureLoaded(0)).rejects.toThrow('network error');
    // Chunk must NOT be in the store
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
    manager.dispose();
  });

  it('retries after a failed load (no stale in-flight entry)', async () => {
    const store = makeStore();
    let callCount = 0;
    const loader = {
      loadChunk: vi.fn(async (): Promise<Uint8Array> => {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return makeBytes('aaaabbbb');
      }),
    };
    const manager = createChunkManager(store, loader);

    await expect(manager.ensureLoaded(0)).rejects.toThrow();
    // Second attempt should succeed
    await manager.ensureLoaded(0);
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(true);
    manager.dispose();
  });
});

describe('ChunkManager LRU eviction', () => {
  it('evicts the LRU chunk when maxLoadedChunks is exceeded', async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: 'aaaabbbb', 1: 'bbbbcccc', 2: 'ccccdddd' });
    const manager = createChunkManager(store, loader, { maxLoadedChunks: 2 });

    await manager.ensureLoaded(0);
    await manager.ensureLoaded(1);
    // Loading chunk 2 should evict chunk 0 (LRU)
    await manager.ensureLoaded(2);

    const snap = store.getSnapshot();
    expect(snap.pieceTable.chunkMap.size).toBeLessThanOrEqual(2);
    manager.dispose();
  });

  it('does not evict pinned chunks', async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: 'aaaabbbb', 1: 'bbbbcccc', 2: 'ccccdddd' });
    const manager = createChunkManager(store, loader, { maxLoadedChunks: 2 });

    await manager.ensureLoaded(0);
    manager.setActiveChunks([0]); // pin chunk 0
    await manager.ensureLoaded(1);
    await manager.ensureLoaded(2); // should evict chunk 1, not pinned chunk 0

    const snap = store.getSnapshot();
    expect(snap.pieceTable.chunkMap.has(0)).toBe(true); // pinned — must survive
    manager.dispose();
  });
});

describe('ChunkManager.prefetch', () => {
  it('fires a background load without blocking', async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: 'aaaabbbb' });
    const manager = createChunkManager(store, loader);

    manager.prefetch(0); // fire and forget
    // Immediately: chunk may or may not be loaded yet
    // After a tick: it should be loaded
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(true);
    manager.dispose();
  });

  it('is a no-op for a chunk already in memory', async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: 'aaaabbbb' });
    const manager = createChunkManager(store, loader);

    await manager.ensureLoaded(0);
    const callsBefore = loader.loadChunk.mock.calls.length;
    manager.prefetch(0);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(loader.loadChunk.mock.calls.length).toBe(callsBefore);
    manager.dispose();
  });
});

describe('ChunkManager.dispose', () => {
  it('prevents ensureLoaded from dispatching after disposal', async () => {
    const store = makeStore();
    let resolveLoad!: (v: Uint8Array) => void;
    const pending = new Promise<Uint8Array>(resolve => { resolveLoad = resolve; });
    const loader = { loadChunk: vi.fn(() => pending) };
    const manager = createChunkManager(store, loader);

    const promise = manager.ensureLoaded(0);
    manager.dispose(); // dispose before fetch completes
    resolveLoad(makeBytes('aaaabbbb')); // now finish the fetch

    await promise; // resolves (no rejection)
    // Chunk must NOT have been dispatched into the store
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
  });

  it('makes ensureLoaded a no-op after dispose', async () => {
    const store = makeStore();
    const loader = makeLoader({ 0: 'aaaabbbb' });
    const manager = createChunkManager(store, loader);
    manager.dispose();

    await manager.ensureLoaded(0); // should resolve immediately, no fetch
    expect(loader.loadChunk.mock.calls.length).toBe(0);
    expect(store.getSnapshot().pieceTable.chunkMap.has(0)).toBe(false);
  });
});
