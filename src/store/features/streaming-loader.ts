/**
 * StreamingDocumentLoader — high-level wrapper for chunked document streaming.
 *
 * Encapsulates the full chunk lifecycle protocol so callers never have to
 * manually sequence DECLARE_CHUNK_METADATA → LOAD_CHUNK → EVICT_CHUNK:
 *
 *   1. Construction: declares all chunk metadata in one call.
 *   2. setViewport:  loads the visible range, pins a surrounding window,
 *                    prefetches nearby chunks, and lets LRU evict the rest.
 *
 * Compared to using ChunkManager directly, this removes ordering mistakes and
 * viewport-tracking boilerplate. Use ChunkManager when you need fine-grained
 * control; use StreamingDocumentLoader for the common streaming use case.
 */

import type { DocumentStore } from "../../types/store.js";
import type { ChunkMetadata } from "../../types/state.js";
import { isValidChunkMetadata } from "../../types/actions.js";
import { DocumentActions } from "./actions.js";
import { createChunkManager, type ChunkLoader, type ChunkManagerConfig } from "./chunk-manager.js";

// =============================================================================
// Public interfaces
// =============================================================================

/**
 * Configuration for StreamingDocumentLoader.
 */
export interface StreamingDocumentLoaderConfig {
  /**
   * Number of extra chunks to pin and prefetch on each side of the visible
   * viewport.  A value of 2 means the window covers
   * [startChunk - 2, endChunk + 2].  Default: 2.
   *
   * The internal ChunkManager's default `maxLoadedChunks` assumes a one-chunk
   * viewport: `1 + 2 * prefetchWindowSize + 4`. If your viewport can span more
   * than one chunk, pass `chunkManagerConfig.maxLoadedChunks` explicitly.
   */
  prefetchWindowSize?: number;

  /**
   * Pass-through configuration for the underlying ChunkManager.
   * `maxLoadedChunks` defaults to a value derived from `prefetchWindowSize`
   * when not provided.
   */
  chunkManagerConfig?: ChunkManagerConfig;
}

/**
 * High-level streaming interface for chunked document loading.
 */
export interface StreamingDocumentLoader {
  /**
   * Update the visible viewport to cover chunks [startChunkIndex, endChunkIndex]
   * (inclusive, 0-based).
   *
   * - All viewport chunks are loaded before the returned Promise resolves.
   * - The surrounding prefetch window is pinned against LRU eviction.
   * - Chunks just outside the window are prefetched in the background.
   * - Chunks further away are subject to LRU eviction by the ChunkManager.
   *
   * Calling setViewport multiple times is safe; each call supersedes the last.
   */
  setViewport(startChunkIndex: number, endChunkIndex: number): Promise<void>;

  /**
   * Dispose all resources held by this loader.
   * The underlying DocumentStore is not affected.
   * After disposal, setViewport is a no-op.
   */
  dispose(): void;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a StreamingDocumentLoader that wraps `store` and uses `loader` to
 * fetch chunk bytes.
 *
 * @param store    - The document store to load chunks into.
 * @param loader   - User-supplied chunk fetch implementation.
 * @param metadata - Metadata for every chunk in the file.  The loader
 *                   declares all of it via DECLARE_CHUNK_METADATA on creation
 *                   so the store can answer line-count queries for unloaded
 *                   ranges immediately.
 * @param config   - Optional configuration.
 *
 * @example
 * ```typescript
 * const loader = createStreamingDocumentLoader(store, {
 *   loadChunk: async (i) => fetchBytes(`/file/chunk/${i}`),
 * }, chunkMetadata);
 *
 * // Render lines 0-49 (assume each chunk holds ~100 lines):
 * await loader.setViewport(0, 0);
 * const state = store.getSnapshot();
 * ```
 */
export function createStreamingDocumentLoader(
  store: DocumentStore,
  loader: ChunkLoader,
  metadata: readonly ChunkMetadata[],
  config: StreamingDocumentLoaderConfig = {},
): StreamingDocumentLoader {
  if (store.getSnapshot().pieceTable.chunkSize === 0) {
    throw new Error("StreamingDocumentLoader requires a store configured with chunkSize > 0");
  }

  const prefetchWindowSize = config.prefetchWindowSize ?? 2;
  if (!Number.isInteger(prefetchWindowSize) || prefetchWindowSize < 0) {
    throw new RangeError(
      `prefetchWindowSize must be a non-negative integer: ${String(prefetchWindowSize)}`,
    );
  }
  const totalChunks = metadata.length;
  let disposed = false;
  let latestViewportRequestId = 0;
  let latestWindowChunks: readonly number[] = [];

  // Validate that metadata describes the contiguous chunk set {0..totalChunks-1}
  // exactly once each and that every value is usable by the chunk runtime.
  const seenChunkIndexes = new Set<number>();
  for (const m of metadata) {
    if (!isValidChunkMetadata(m) || m.byteLength === 0) {
      throw new RangeError(
        "createStreamingDocumentLoader: chunk metadata requires non-negative integer " +
          "chunkIndex and lineCount, and a positive integer byteLength",
      );
    }
    if (m.chunkIndex >= totalChunks) {
      throw new RangeError(
        `createStreamingDocumentLoader: chunk metadata index ${m.chunkIndex} is out of range; ` +
          `metadata must cover indexes 0..${totalChunks - 1}`,
      );
    }
    if (seenChunkIndexes.has(m.chunkIndex)) {
      throw new RangeError(
        `createStreamingDocumentLoader: duplicate chunk metadata for index ${m.chunkIndex}`,
      );
    }
    seenChunkIndexes.add(m.chunkIndex);
  }

  const { chunkSize, totalFileSize } = store.getSnapshot().pieceTable;
  if (metadata.some((m) => m.byteLength > chunkSize)) {
    throw new RangeError(
      `createStreamingDocumentLoader: chunk byteLength cannot exceed chunkSize ${chunkSize}`,
    );
  }
  if (loader.totalChunkCount !== undefined && loader.totalChunkCount !== totalChunks) {
    throw new RangeError(
      `createStreamingDocumentLoader: metadata has ${totalChunks} chunks but loader declares ` +
        `${loader.totalChunkCount}`,
    );
  }
  if (totalFileSize > 0) {
    const expectedChunkCount = Math.ceil(totalFileSize / chunkSize);
    if (totalChunks !== expectedChunkCount) {
      throw new RangeError(
        `createStreamingDocumentLoader: metadata has ${totalChunks} chunks but file geometry ` +
          `requires ${expectedChunkCount}`,
      );
    }
    for (const m of metadata) {
      const expectedByteLength = Math.min(chunkSize, totalFileSize - m.chunkIndex * chunkSize);
      if (m.byteLength !== expectedByteLength) {
        throw new RangeError(
          `createStreamingDocumentLoader: chunk ${m.chunkIndex} declares ${m.byteLength} bytes; ` +
            `expected ${expectedByteLength}`,
        );
      }
    }
  }

  // Validate and construct the manager before mutating the store. A configuration
  // error must leave metadata and subscribers untouched.
  const derivedMax = 1 + 2 * prefetchWindowSize + 4;
  const cmConfig: ChunkManagerConfig = {
    maxLoadedChunks: derivedMax,
    ...config.chunkManagerConfig,
  };
  const manager = createChunkManager(store, loader, cmConfig);

  // Declare all chunk metadata upfront so the store can answer total line-count
  // queries even while most chunks are not yet loaded.
  if (metadata.length > 0) {
    store.dispatch(DocumentActions.declareChunkMetadata([...metadata]));
  }

  async function setViewport(startChunkIndex: number, endChunkIndex: number): Promise<void> {
    if (disposed) return;
    if (
      !Number.isInteger(startChunkIndex) ||
      !Number.isInteger(endChunkIndex) ||
      startChunkIndex > endChunkIndex
    ) {
      throw new RangeError(
        `setViewport: invalid chunk range [${startChunkIndex}, ${endChunkIndex}]`,
      );
    }
    // Reject ranges that do not intersect [0, totalChunks-1]. Clamping a fully
    // out-of-range request (e.g. start beyond the last chunk) would silently
    // resolve without loading anything, masking a caller bug.
    if (totalChunks === 0 || startChunkIndex >= totalChunks || endChunkIndex < 0) {
      throw new RangeError(
        `setViewport: chunk range [${startChunkIndex}, ${endChunkIndex}] is out of range ` +
          `for ${totalChunks} chunks`,
      );
    }
    const requestId = ++latestViewportRequestId;

    const start = Math.max(0, startChunkIndex);
    const end = Math.min(totalChunks - 1, endChunkIndex);

    // Compute the full window that should be pinned against eviction.
    const windowStart = Math.max(0, start - prefetchWindowSize);
    const windowEnd = Math.min(totalChunks - 1, end + prefetchWindowSize);

    // Pin the window so LRU does not evict chunks while they are loading.
    const windowChunks: number[] = [];
    for (let i = windowStart; i <= windowEnd; i++) windowChunks.push(i);
    latestWindowChunks = windowChunks;
    manager.setActiveChunks(windowChunks);

    // Load viewport chunks (awaited — caller needs them visible).
    const viewportLoads: Promise<void>[] = [];
    for (let i = start; i <= end; i++) viewportLoads.push(manager.ensureLoaded(i));
    await Promise.all(viewportLoads);
    if (disposed) return;
    if (requestId !== latestViewportRequestId) {
      // Each completed fetch temporarily protects its own chunk from eviction so
      // ensureLoaded callers can observe it. Once an entire stale viewport has
      // completed, trim again without that protection; otherwise its last chunk
      // can leave the cache above maxLoadedChunks indefinitely.
      manager.setActiveChunks(latestWindowChunks);
      return;
    }

    // Prefetch window chunks outside the viewport in the background.
    for (let i = windowStart; i < start; i++) manager.prefetch(i);
    for (let i = end + 1; i <= windowEnd; i++) manager.prefetch(i);
  }

  function dispose(): void {
    disposed = true;
    manager.dispose();
  }

  return { setViewport, dispose };
}
