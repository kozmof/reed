/**
 * ChunkManager loads and evicts chunks for large-file streaming.
 *
 * Sits between user code and the DocumentStore, coordinating:
 * - Async chunk loading via a user-supplied ChunkLoader
 * - In-flight deduplication (concurrent ensureLoaded calls for the same chunk
 *   share a single fetch)
 * - LRU eviction toward maxLoadedChunks when unpinned chunks can be removed
 * - Chunk pinning (setActiveChunks prevents LRU eviction of hot chunks)
 *
 * Apply all state transitions through store.dispatch(DocumentActions.*).
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
   * Keep the returned Uint8Array valid until LOAD_CHUNK is dispatched.
   * Do not mutate it afterward.
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
   * When exceeded, evict the least recently used unpinned chunk if possible.
   * Must be >= 1. Default: 8.
   */
  maxLoadedChunks?: number;
  /** Maximum simultaneous fetches within ensureLoadedMany. Default: 8. */
  maxConcurrentFetches?: number;
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
   * Ensure several chunks are loaded with bounded concurrency. Completions in
   * the same turn share a transition; slow fetches do not hold up others.
   * Successful chunks remain loaded if another fetch in the batch fails.
   */
  ensureLoadedMany(chunkIndices: readonly number[]): Promise<void>;

  /**
   * Start a background load for `chunkIndex` without waiting.
   * Do nothing if the chunk is already loaded or a fetch is in progress.
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
   * Cancel pending loads for chunks outside `chunkIndices`.
   *
   * Canceled requests settle without dispatching `LOAD_CHUNK`. This is useful
   * when a newer viewport makes older fetches unnecessary.
   */
  cancelPendingOutside(chunkIndices: readonly number[]): void;

  /**
   * Dispose this manager.
   * After disposal, ensureLoaded / prefetch are no-ops and in-flight fetches
   * receive an abort signal. Fetches that have not yet dispatched LOAD_CHUNK
   * will not dispatch, even when their loader ignores cancellation.
   * The underlying DocumentStore remains usable.
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
 * const text = scan.getValue(store.getSnapshot().pieceTable);
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
    // Require a positive integer cap. An invalid cap can
    // disable LRU eviction and allow unbounded memory growth.
    // For example, `count > NaN` is always false.
    throw new Error(
      `maxLoadedChunks must be a positive integer: ${String(config.maxLoadedChunks)}`,
    );
  }
  if (
    config.fetchStrategy !== undefined &&
    config.fetchStrategy !== "parallel" &&
    config.fetchStrategy !== "queue"
  ) {
    throw new RangeError(
      `fetchStrategy must be 'parallel' or 'queue': ${String(config.fetchStrategy)}`,
    );
  }
  if (
    config.maxConcurrentFetches !== undefined &&
    (!Number.isInteger(config.maxConcurrentFetches) || config.maxConcurrentFetches < 1)
  ) {
    throw new RangeError("maxConcurrentFetches must be a positive integer");
  }
  const maxConcurrentFetches = config.maxConcurrentFetches ?? 8;
  const maxLoadedChunks = config.maxLoadedChunks ?? 8;
  const fetchStrategy = config.fetchStrategy ?? "parallel";
  const logger = config.logger;

  // In-flight fetch promises keyed by chunk index.
  // Removed once the fetch resolves or rejects.
  const inFlight = new Map<number, Promise<void>>();

  // Cooperative cancellation for loaders that honor AbortSignal.
  const abortControllers = new Map<number, AbortController>();

  // Set iteration runs from least to most recently used.
  const lruOrder = new Set<number>();

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
    lruOrder.delete(chunkIndex);
    lruOrder.add(chunkIndex);
  }

  function lruRemove(chunkIndex: number): void {
    lruOrder.delete(chunkIndex);
  }

  // ── Eviction ──────────────────────────────────────────────────────────────

  function evictIfOverLimit(protectedChunkIndices?: number | ReadonlySet<number>): void {
    if (disposed) return;
    const snapshot = store.getSnapshot();
    let loadedCount = snapshot.pieceTable.chunkMap.size;

    for (const candidate of lruOrder) {
      if (loadedCount <= maxLoadedChunks) break;
      // Skip pinned chunks.
      if (activeChunks.has(candidate)) continue;
      // Keep the just-loaded chunk resident for the ensureLoaded()/prefetch caller.
      if (
        typeof protectedChunkIndices === "number"
          ? candidate === protectedChunkIndices
          : protectedChunkIndices?.has(candidate)
      ) {
        continue;
      }
      // Skip chunks no longer in memory (evicted by another path).
      if (!snapshot.pieceTable.chunkMap.has(candidate)) {
        lruRemove(candidate);
        continue;
      }

      store.dispatch(DocumentActions.evictChunk(candidate));

      if (!store.getSnapshot().pieceTable.chunkMap.has(candidate)) {
        // Eviction succeeded.
        lruRemove(candidate);
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

    const fetch = async (): Promise<void> =>
      disposed || abortController.signal.aborted
        ? Promise.resolve()
        : loader
            .loadChunk(chunkIndex, abortController.signal)
            .then((data) => {
              if (disposed || abortController.signal.aborted) return;
              if (data.length === 0)
                throw new Error(`ChunkLoader returned empty data for chunk ${chunkIndex}`);
              // Reject lengths that contradict the declared file geometry before dispatch.
              // Otherwise the reducer drops the load and the retention check
              // below reports a misleading error.
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
              // Manager-owned cancellation settles pending calls without loading.
              if (abortController.signal.aborted) return;
              throw error;
            });

    // Clean up even when cancellation prevents a queued fetch from starting.
    const promise = (fetchStrategy === "queue" ? fetchQueue.then(fetch, fetch) : fetch()).finally(
      () => {
        if (inFlight.get(chunkIndex) === promise) inFlight.delete(chunkIndex);
        if (abortControllers.get(chunkIndex) === abortController) {
          abortControllers.delete(chunkIndex);
        }
      },
    );
    if (fetchStrategy === "queue") {
      fetchQueue = promise.then(
        () => {},
        () => {},
      );
      return promise;
    }

    return promise;
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

  function ensureLoadedMany(chunkIndices: readonly number[]): Promise<void> {
    if (disposed || chunkIndices.length === 0) return Promise.resolve();

    const chunkedModeError = getChunkedModeError();
    if (chunkedModeError !== null) return Promise.reject(new Error(chunkedModeError));

    const unique = [...new Set(chunkIndices)];
    for (const chunkIndex of unique) {
      const error = getChunkIndexError(chunkIndex);
      if (error !== null) return Promise.reject(new RangeError(error));
    }

    const pending: Promise<void>[] = [];
    const fresh: number[] = [];
    const snapshot = store.getSnapshot();
    for (const chunkIndex of unique) {
      if (snapshot.pieceTable.chunkMap.has(chunkIndex)) {
        lruTouch(chunkIndex);
        continue;
      }
      const existing = inFlight.get(chunkIndex);
      if (existing !== undefined) pending.push(existing);
      else fresh.push(chunkIndex);
    }
    if (fresh.length === 0) return Promise.all(pending).then(() => {});

    const controllers = new Map<number, AbortController>();
    for (const chunkIndex of fresh) {
      const controller = new AbortController();
      controllers.set(chunkIndex, controller);
      abortControllers.set(chunkIndex, controller);
    }

    const fetchOne = (
      chunkIndex: number,
      controller: AbortController,
    ): Promise<Uint8Array | null> => {
      const fetch = async (): Promise<Uint8Array | null> => {
        if (disposed || controller.signal.aborted) return null;
        try {
          const data = await loader.loadChunk(chunkIndex, controller.signal);
          if (disposed || controller.signal.aborted) return null;
          if (data.length === 0) {
            throw new Error(`ChunkLoader returned empty data for chunk ${chunkIndex}`);
          }
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
          return data;
        } catch (error) {
          if (controller.signal.aborted) return null;
          throw error;
        }
      };

      if (fetchStrategy === "parallel") return fetch();
      const promise = fetchQueue.then(fetch, fetch);
      fetchQueue = promise.then(
        () => {},
        () => {},
      );
      return promise;
    };

    let batchPromise!: Promise<void>;
    batchPromise = (async () => {
      // Coalesce completions without waiting for a slow sibling. Workers bound
      // outstanding I/O and completed buffers waiting for dispatch.
      let ready: Array<{ chunkIndex: number; data: Uint8Array }> = [];
      let commit: Promise<void> | undefined;
      const protectedChunks = new Set(fresh);
      function enqueue(chunkIndex: number, data: Uint8Array): Promise<void> {
        ready.push({ chunkIndex, data });
        return (commit ??= Promise.resolve().then(() => {
          const chunks = ready.filter(
            (chunk) => !controllers.get(chunk.chunkIndex)!.signal.aborted,
          );
          ready = [];
          commit = undefined;
          if (disposed || chunks.length === 0) return;
          store.dispatch(DocumentActions.loadChunks(chunks));
          const after = store.getSnapshot();
          for (const chunk of chunks) {
            if (!after.pieceTable.chunkMap.has(chunk.chunkIndex)) {
              throw new Error(
                `Chunk ${chunk.chunkIndex} was fetched but the store did not retain it after LOAD_CHUNKS dispatch`,
              );
            }
            lruTouch(chunk.chunkIndex);
          }
          evictIfOverLimit(protectedChunks);
        }));
      }
      let cursor = 0;
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(maxConcurrentFetches, fresh.length) }, async () => {
          let failed = false;
          let failure: unknown;
          while (cursor < fresh.length) {
            const chunkIndex = fresh[cursor++]!;
            try {
              const data = await fetchOne(chunkIndex, controllers.get(chunkIndex)!);
              if (data !== null) await enqueue(chunkIndex, data);
            } catch (error) {
              if (!failed) failure = error;
              failed = true;
            }
          }
          if (failed) throw failure;
        }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })().finally(() => {
      for (const chunkIndex of fresh) {
        if (inFlight.get(chunkIndex) === batchPromise) inFlight.delete(chunkIndex);
        const controller = controllers.get(chunkIndex)!;
        if (abortControllers.get(chunkIndex) === controller) {
          abortControllers.delete(chunkIndex);
        }
      }
    });

    for (const chunkIndex of fresh) inFlight.set(chunkIndex, batchPromise);
    pending.push(batchPromise);
    return Promise.all(pending).then(() => {});
  }

  function prefetch(chunkIndex: number): void {
    if (disposed) return;
    if (getChunkedModeError() !== null) return;
    if (getChunkIndexError(chunkIndex) !== null) return;
    if (store.getSnapshot().pieceTable.chunkMap.has(chunkIndex)) return;
    if (inFlight.has(chunkIndex)) return;
    // Start prefetch without waiting and ignore its errors.
    ensureLoaded(chunkIndex).catch(() => {});
  }

  function setActiveChunks(chunkIndices: readonly number[]): void {
    activeChunks = new Set(chunkIndices);
    evictIfOverLimit();
  }

  function cancelPendingOutside(chunkIndices: readonly number[]): void {
    if (disposed) return;
    const retained = new Set(chunkIndices);
    const canceled: AbortController[] = [];
    for (const [chunkIndex, controller] of abortControllers) {
      if (!retained.has(chunkIndex)) {
        // Detach before abort callbacks run so a retry gets a fresh request.
        inFlight.delete(chunkIndex);
        abortControllers.delete(chunkIndex);
        canceled.push(controller);
      }
    }
    // Preserve replacement loads started by abort callbacks.
    for (const controller of canceled) controller.abort();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const controller of abortControllers.values()) {
      controller.abort();
    }
    abortControllers.clear();
    inFlight.clear();
    lruOrder.clear();
    activeChunks.clear();
  }

  return {
    ensureLoaded,
    ensureLoadedMany,
    prefetch,
    setActiveChunks,
    cancelPendingOutside,
    dispose,
  };
}
