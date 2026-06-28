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

import type { ReedLogger } from "../../types/state.js";
import type { DocumentStore } from "../../types/store.js";
import { isChunkByteLengthValid } from "../core/piece-table.js";
import { DocumentActions } from "./actions.js";

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
   * When provided, `signal` is aborted if the manager is disposed before the
   * load completes. Loaders should pass it to their underlying I/O operation.
   * The returned Uint8Array must remain valid until LOAD_CHUNK has been
   * dispatched — do not mutate it afterward.
   * Return an empty Uint8Array or throw to signal a load failure.
   */
  loadChunk(chunkIndex: number, signal?: AbortSignal): Promise<Uint8Array>;

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
  /** Optional diagnostics sink. Omit to keep the manager silent. */
  logger?: Pick<ReedLogger, "warn">;
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
   * Rejects if the store is not configured for chunked mode.
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
   * receive an abort signal. Fetches that have not yet dispatched LOAD_CHUNK
   * will not dispatch, even when their loader ignores cancellation.
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
  if (
    config.maxLoadedChunks !== undefined &&
    (!Number.isInteger(config.maxLoadedChunks) || config.maxLoadedChunks < 1)
  ) {
    // Reject NaN / Infinity / 0 / negatives / fractionals: a non-integer or
    // sub-1 cap silently disables LRU eviction (`count > NaN` is always false),
    // letting memory grow unbounded.
    throw new Error(
      `maxLoadedChunks must be a positive integer: ${String(config.maxLoadedChunks)}`,
    );
  }
  const maxLoadedChunks = config.maxLoadedChunks ?? 8;
  const fetchStrategy = config.fetchStrategy ?? "parallel";
  const logger = config.logger;

  // In-flight fetch promises keyed by chunk index.
  // Removed once the fetch resolves or rejects.
  const inFlight = new Map<number, Promise<void>>();

  // Cooperative cancellation for loaders that honor AbortSignal.
  const abortControllers = new Map<number, AbortController>();

  // LRU order: index 0 is least recently used, last index is most recently used.
  const lruOrder: number[] = [];

  // Pinned chunks: never evicted.
  let activeChunks = new Set<number>();

  // When fetchStrategy is 'queue', serialise fetches through this promise chain.
  let fetchQueue: Promise<void> = Promise.resolve();

  // Disposed flag: prevents dispatches after dispose().
  let disposed = false;

  function getChunkedModeError(): string | null {
    return store.getSnapshot().pieceTable.chunkSize > 0
      ? null
      : "ChunkManager requires a store configured with chunkSize > 0";
  }

  function getKnownTotalChunkCount(): number | undefined {
    if (Number.isInteger(loader.totalChunkCount) && loader.totalChunkCount! >= 0) {
      return loader.totalChunkCount;
    }

    const { chunkSize, totalFileSize } = store.getSnapshot().pieceTable;
    if (chunkSize > 0 && totalFileSize > 0) {
      return Math.ceil(totalFileSize / chunkSize);
    }

    return undefined;
  }

  function getChunkIndexError(chunkIndex: number): string | null {
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return `Chunk index must be a non-negative integer: ${chunkIndex}`;
    }

    const totalChunkCount = getKnownTotalChunkCount();
    if (totalChunkCount !== undefined && chunkIndex >= totalChunkCount) {
      return `Chunk index ${chunkIndex} is out of range for ${totalChunkCount} chunks`;
    }

    return null;
  }

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

  function evictIfOverLimit(protectedChunkIndex?: number): void {
    if (disposed) return;
    const snapshot = store.getSnapshot();
    let loadedCount = snapshot.pieceTable.chunkMap.size;

    for (let i = 0; i < lruOrder.length && loadedCount > maxLoadedChunks; i++) {
      const candidate = lruOrder[i]!; // i < lruOrder.length by the loop guard
      // Skip pinned chunks.
      if (activeChunks.has(candidate)) continue;
      // Keep the just-loaded chunk resident for the ensureLoaded()/prefetch caller.
      if (candidate === protectedChunkIndex) continue;
      // Skip chunks no longer in memory (evicted by another path).
      if (!snapshot.pieceTable.chunkMap.has(candidate)) {
        lruRemove(candidate);
        i--; // re-examine this index after splice
        continue;
      }

      store.dispatch(DocumentActions.evictChunk(candidate));

      if (!store.getSnapshot().pieceTable.chunkMap.has(candidate)) {
        // Eviction succeeded.
        lruRemove(candidate);
        i--; // re-examine after splice
        loadedCount--;
      }
      // If eviction was refused (user edits overlap the chunk's byte range),
      // leave the chunk and continue to the next LRU candidate.
    }

    if (loadedCount > maxLoadedChunks) {
      logger?.warn?.(
        `[ChunkManager] eviction pressure: ${loadedCount} chunks loaded but all non-pinned ` +
          `candidates have overlapping user edits. Memory limit (${maxLoadedChunks}) exceeded.`,
      );
    }
  }

  // ── Core fetch ────────────────────────────────────────────────────────────

  function doFetch(chunkIndex: number): Promise<void> {
    const abortController = new AbortController();
    abortControllers.set(chunkIndex, abortController);

    const fetch = (): Promise<void> =>
      disposed
        ? Promise.resolve()
        : loader
            .loadChunk(chunkIndex, abortController.signal)
            .then((data) => {
              if (disposed) return;
              if (data.length === 0)
                throw new Error(`ChunkLoader returned empty data for chunk ${chunkIndex}`);
              // Reject lengths that contradict the declared file geometry before
              // dispatching — otherwise the reducer silently drops the load and the
              // post-dispatch retention check below would report a misleading error.
              const { pieceTable } = store.getSnapshot();
              if (!isChunkByteLengthValid(pieceTable, chunkIndex, data.length)) {
                const declared = pieceTable.chunkMetadata.get(chunkIndex);
                throw new Error(
                  `ChunkLoader returned ${data.length} bytes for chunk ${chunkIndex}, which ` +
                    `violates the declared file geometry (chunkSize=${pieceTable.chunkSize}` +
                    (declared !== undefined ? `, declared byteLength=${declared.byteLength}` : "") +
                    (pieceTable.totalFileSize > 0
                      ? `, totalFileSize=${pieceTable.totalFileSize}`
                      : "") +
                    ")",
                );
              }
              store.dispatch(DocumentActions.loadChunk(chunkIndex, data));
              if (!store.getSnapshot().pieceTable.chunkMap.has(chunkIndex)) {
                throw new Error(
                  `Chunk ${chunkIndex} was fetched but the store did not retain it after LOAD_CHUNK dispatch`,
                );
              }
              lruTouch(chunkIndex);
              evictIfOverLimit(chunkIndex);
            })
            .catch((error: unknown) => {
              // Disposal is successful cancellation from the manager caller's
              // perspective. Pending ensureLoaded() calls continue to resolve.
              if (disposed && abortController.signal.aborted) return;
              throw error;
            })
            .finally(() => {
              inFlight.delete(chunkIndex);
              if (abortControllers.get(chunkIndex) === abortController) {
                abortControllers.delete(chunkIndex);
              }
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

    const chunkedModeError = getChunkedModeError();
    if (chunkedModeError !== null) {
      return Promise.reject(new Error(chunkedModeError));
    }

    const chunkIndexError = getChunkIndexError(chunkIndex);
    if (chunkIndexError !== null) {
      return Promise.reject(new RangeError(chunkIndexError));
    }

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
    if (getChunkedModeError() !== null) return;
    if (getChunkIndexError(chunkIndex) !== null) return;
    if (store.getSnapshot().pieceTable.chunkMap.has(chunkIndex)) return;
    if (inFlight.has(chunkIndex)) return;
    // Fire and forget — errors are silently swallowed for prefetch.
    ensureLoaded(chunkIndex).catch(() => {});
  }

  function setActiveChunks(chunkIndices: readonly number[]): void {
    activeChunks = new Set(chunkIndices);
    evictIfOverLimit();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const controller of abortControllers.values()) {
      controller.abort();
    }
    abortControllers.clear();
    inFlight.clear();
    lruOrder.length = 0;
    activeChunks.clear();
  }

  return { ensureLoaded, prefetch, setActiveChunks, dispose };
}
