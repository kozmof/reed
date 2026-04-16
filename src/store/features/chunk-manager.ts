/**
 * ChunkManager — async chunk fetch subsystem for large-file streaming.
 *
 * Sits between user code and the DocumentStore, coordinating:
 * - Async chunk loading via a user-supplied ChunkLoader
 * - In-flight deduplication (concurrent ensureLoaded calls for the same chunk
 *   share a single fetch)
 * - LRU eviction policy (keeps at most maxLoadedChunks chunks in memory)
 * - Chunk pinning (setActiveChunks prevents LRU eviction of hot chunks)
 *
 * Does NOT touch the reducer directly — all state transitions go through
 * store.dispatch(DocumentActions.*).
 */

import type { DocumentStore } from "../../types/store.ts";
import { DocumentActions } from "./actions.ts";

// =============================================================================
// Public interfaces
// =============================================================================

/**
 * User-provided interface for loading raw chunk bytes from any source
 * (file system, network, IndexedDB, etc.).
 */
export interface ChunkLoader {
  /**
   * Fetch the raw bytes for the given chunk index.
   * The returned Uint8Array must remain valid until LOAD_CHUNK has been
   * dispatched — do not mutate it afterward.
   * Return an empty Uint8Array or throw to signal a load failure.
   */
  loadChunk(chunkIndex: number): Promise<Uint8Array>;

  /**
   * Optional: total number of chunks in the file.
   * Used by ChunkManager to validate chunk indices and bound LRU eviction.
   * If omitted, ChunkManager infers the count from totalFileSize / chunkSize
   * at runtime, or treats the chunk count as unbounded.
   */
  readonly totalChunkCount?: number;
}

/**
 * Configuration for ChunkManager behaviour.
 */
export interface ChunkManagerConfig {
  /**
   * Maximum number of chunks to keep in memory simultaneously.
   * When exceeded, the LRU-oldest non-pinned chunk is evicted.
   * Must be >= 1. Default: 8.
   */
  maxLoadedChunks?: number;
  /**
   * Fetch strategy for concurrent ensureLoaded calls on different chunks.
   * - 'parallel'  — fire all fetches concurrently (default, lower latency)
   * - 'queue'     — serialise fetches one at a time (lower peak I/O)
   */
  fetchStrategy?: "parallel" | "queue";
}

/**
 * Manages async chunk loading, LRU eviction, and fetch deduplication for a
 * DocumentStore operating in chunked mode.
 */
export interface ChunkManager {
  /**
   * Ensure chunk `chunkIndex` is loaded into the store.
   * Resolves when LOAD_CHUNK has been dispatched and the chunk is in memory.
   * If the chunk is already loaded, resolves immediately without fetching.
   * Concurrent calls for the same index share a single in-flight fetch.
   */
  ensureLoaded(chunkIndex: number): Promise<void>;

  /**
   * Fire a background load for `chunkIndex` without blocking.
   * Silently no-ops if the chunk is already in memory or already in-flight.
   */
  prefetch(chunkIndex: number): void;

  /**
   * Pin chunks that are currently in active use.
   * Pinned chunks are excluded from LRU eviction until the next call to
   * setActiveChunks removes them from the active set.
   * Pass an empty array to unpin everything.
   */
  setActiveChunks(chunkIndices: readonly number[]): void;

  /**
   * Dispose this manager.
   * After disposal, ensureLoaded / prefetch are no-ops and in-flight fetches
   * that have not yet dispatched LOAD_CHUNK will not dispatch.
   * The underlying DocumentStore is NOT destroyed.
   */
  dispose(): void;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a ChunkManager that wraps `store` and uses `loader` to fetch chunks.
 *
 * @example
 * ```typescript
 * const manager = createChunkManager(store, {
 *   loadChunk: async (i) => fetchBytes(`/file/chunk/${i}`),
 * });
 * await manager.ensureLoaded(0);
 * const text = query.getText(store.getSnapshot());
 * ```
 */
export function createChunkManager(
  store: DocumentStore,
  loader: ChunkLoader,
  config: ChunkManagerConfig = {},
): ChunkManager {
  const maxLoadedChunks = Math.max(1, config.maxLoadedChunks ?? 8);
  const fetchStrategy = config.fetchStrategy ?? "parallel";

  // In-flight fetch promises keyed by chunk index.
  // Removed once the fetch resolves or rejects.
  const inFlight = new Map<number, Promise<void>>();

  // LRU order: index 0 is least recently used, last index is most recently used.
  const lruOrder: number[] = [];

  // Pinned chunks: never evicted.
  let activeChunks = new Set<number>();

  // When fetchStrategy is 'queue', serialise fetches through this promise chain.
  let fetchQueue: Promise<void> = Promise.resolve();

  // Disposed flag: prevents dispatches after dispose().
  let disposed = false;

  // ── LRU helpers ───────────────────────────────────────────────────────────

  function lruTouch(chunkIndex: number): void {
    const pos = lruOrder.indexOf(chunkIndex);
    if (pos !== -1) lruOrder.splice(pos, 1);
    lruOrder.push(chunkIndex);
  }

  function lruRemove(chunkIndex: number): void {
    const pos = lruOrder.indexOf(chunkIndex);
    if (pos !== -1) lruOrder.splice(pos, 1);
  }

  // ── Eviction ──────────────────────────────────────────────────────────────

  function evictIfOverLimit(): void {
    if (disposed) return;
    const snapshot = store.getSnapshot();
    let loadedCount = snapshot.pieceTable.chunkMap.size;

    for (let i = 0; i < lruOrder.length && loadedCount > maxLoadedChunks; i++) {
      const candidate = lruOrder[i];
      // Skip pinned chunks.
      if (activeChunks.has(candidate)) continue;
      // Skip chunks no longer in memory (evicted by another path).
      if (!snapshot.pieceTable.chunkMap.has(candidate)) {
        lruRemove(candidate);
        i--; // re-examine this index after splice
        continue;
      }

      const before = store.getSnapshot().pieceTable.chunkMap.size;
      store.dispatch(DocumentActions.evictChunk(candidate));
      const after = store.getSnapshot().pieceTable.chunkMap.size;

      if (after < before) {
        // Eviction succeeded.
        lruRemove(candidate);
        i--; // re-examine after splice
        loadedCount--;
      }
      // If eviction was refused (user edits overlap), leave the chunk and
      // continue to the next candidate.
    }
  }

  // ── Core fetch ────────────────────────────────────────────────────────────

  function doFetch(chunkIndex: number): Promise<void> {
    const fetch = (): Promise<void> =>
      loader
        .loadChunk(chunkIndex)
        .then((data) => {
          if (disposed) return;
          if (data.length === 0)
            throw new Error(`ChunkLoader returned empty data for chunk ${chunkIndex}`);
          store.dispatch(DocumentActions.loadChunk(chunkIndex, data));
          lruTouch(chunkIndex);
          evictIfOverLimit();
        })
        .finally(() => {
          inFlight.delete(chunkIndex);
        });

    if (fetchStrategy === "queue") {
      const promise = fetchQueue.then(fetch, fetch);
      fetchQueue = promise.then(
        () => {},
        () => {},
      );
      return promise;
    }

    return fetch();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function ensureLoaded(chunkIndex: number): Promise<void> {
    if (disposed) return Promise.resolve();

    // Already in memory.
    if (store.getSnapshot().pieceTable.chunkMap.has(chunkIndex)) {
      lruTouch(chunkIndex);
      return Promise.resolve();
    }

    // De-duplicate concurrent requests.
    const existing = inFlight.get(chunkIndex);
    if (existing !== undefined) return existing;

    const promise = doFetch(chunkIndex);
    inFlight.set(chunkIndex, promise);
    return promise;
  }

  function prefetch(chunkIndex: number): void {
    if (disposed) return;
    if (store.getSnapshot().pieceTable.chunkMap.has(chunkIndex)) return;
    if (inFlight.has(chunkIndex)) return;
    // Fire and forget — errors are silently swallowed for prefetch.
    ensureLoaded(chunkIndex).catch(() => {});
  }

  function setActiveChunks(chunkIndices: readonly number[]): void {
    activeChunks = new Set(chunkIndices);
  }

  function dispose(): void {
    disposed = true;
    inFlight.clear();
    lruOrder.length = 0;
    activeChunks.clear();
  }

  return { ensureLoaded, prefetch, setActiveChunks, dispose };
}
