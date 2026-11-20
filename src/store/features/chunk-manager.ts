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

import type { ReadonlyUint8Array } from "../../types/branded.js";
import type { DocumentState, ReedLogger } from "../../types/state.js";
import type { DocumentStore } from "../../types/store.js";
import { isChunkByteLengthValid } from "../core/piece-table.js";
import { DocumentActions } from "./actions.js";
import { chunkHoldReason, hasAttentionAnchoredToChunk } from "./chunk-actions.js";
import { reportCaughtError, warnSafely, withEvictionWarnSink } from "./diagnostics.js";

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
  /**
   * Optional diagnostics sink. Omit to keep the manager silent.
   *
   * The manager warns when chunks stay resident over `maxLoadedChunks`. When
   * an eviction the manager dispatches discards undo history, the store that
   * commits it warns through the store's own `logger`, or through this one
   * when the store has none, also through a wrapper that forwards the action
   * to `dispatch` synchronously, rebuilt or not, as long as it changes nothing
   * before it. A store with events also fires `history-drop`. A store logger
   * without `warn` keeps the warning silent. When `warn` throws here, the
   * error goes to `error` if this logger has one.
   */
  logger?: Pick<ReedLogger, "warn" | "error">;
}

/**
 * Manages async chunk loading, LRU eviction, and fetch deduplication for a
 * DocumentStore operating in chunked mode.
 */
export interface ChunkManager {
  /**
   * Ensure chunk `chunkIndex` is loaded into the store.
   * Resolves when LOAD_CHUNK has been dispatched and the chunk is in memory.
   * If the chunk is already loaded, resolves immediately without fetching or
   * evicting.
   * Concurrent calls for the same index share a single in-flight fetch.
   * Rejects if the store is not configured for chunked mode.
   */
  ensureLoaded(chunkIndex: number): Promise<void>;

  /**
   * Ensure several chunks are loaded with bounded concurrency. Completions in
   * the same turn share a transition; slow fetches do not hold up others.
   * Until it settles, no eviction pass of this manager evicts one of
   * `chunkIndices`, including those already loaded. It settles once every
   * fetch it waits on has. An eviction pass then runs in a later task, so
   * when it asked for more than maxLoadedChunks, the chunks stay loaded as
   * the call resolves, and the cache returns toward the limit after.
   * Successful chunks remain loaded if another fetch in the batch fails; the
   * call then rejects with the first failure.
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
// Refused candidates
// =============================================================================

/**
 * Why a chunk stays resident while the cache is over the limit after an
 * eviction pass:
 * - `"pinned"`: in the active set (`setActiveChunks`).
 * - `"requested"`: asked for by the fetch that ran the pass, or by an
 *   `ensureLoadedMany` call that has not settled.
 * - `"anchored"`: offered for eviction and refused, since an attention is
 *   anchored inside it.
 * - `"held"`: offered for eviction and refused, since user edits or undo
 *   history point into it.
 * - `"untracked"`: loaded without this manager, so it never offers it.
 *
 * Each chunk counts under one cause. The warning also says how many
 * `"anchored"` chunks edits or history would keep without the attention.
 */
type PressureCause = "pinned" | "requested" | "anchored" | "held" | "untracked";

/** Each cause's text, in the order the pressure warning lists them. */
const PRESSURE_CAUSE_TEXT: Readonly<Record<PressureCause, string>> = {
  pinned: "pinned as active",
  requested: "requested by a pending call",
  anchored: "hold an attention anchor",
  held: "hold user edits or undo history",
  untracked: "loaded outside this ChunkManager",
};

/** Every `PressureCause`, in the order the pressure warning lists them. */
const PRESSURE_CAUSES = Object.keys(PRESSURE_CAUSE_TEXT) as readonly PressureCause[];

/** What EVICT_CHUNKS measures a candidate in. */
type EvictionInputs = Pick<DocumentState, "pieceTable" | "history" | "attention">;

/**
 * A test of whether a state shares `state`'s pieces, history, and attention,
 * so the reducer would refuse the same evictions in it. `state`'s are held
 * weakly, so they keep no evicted chunk or dropped history in memory; once
 * one is collected, no state matches.
 */
function sameEvictionInputsAs(state: EvictionInputs): (other: EvictionInputs) => boolean {
  const pieceTable = new WeakRef(state.pieceTable);
  const history = new WeakRef(state.history);
  const attention = new WeakRef(state.attention);
  return (other) =>
    pieceTable.deref() === other.pieceTable &&
    history.deref() === other.history &&
    attention.deref() === other.attention;
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

  // The chunks the manager tracks: those in lruFront, least recently used
  // first, then those in lruOrder, from least to most recently used. The two
  // never share a chunk. lruFront holds chunks a rollback restored (see
  // `departed`), so they go first without reordering lruOrder.
  const lruOrder = new Set<number>();
  const lruFront = new Set<number>();

  // Chunks this manager's eviction passes removed from memory, and the manager
  // has not loaded since, each with the bytes it held, weakly. A rollback of a
  // transaction open during the pass can restore one; a pass then tracks it
  // again instead of taking it for a chunk loaded outside this manager, which
  // it never evicts. A rollback restores the same bytes, while a load outside
  // the manager brings its own, so only a chunk that holds the bytes it left
  // with counts as restored. Once those bytes are collected, no state can
  // restore the chunk, and the entry is dropped (see `recordDeparture`).
  const departed = new Map<number, WeakRef<ReadonlyUint8Array>>();
  // How large `departed` may grow before its dead entries are swept.
  let departedSweepAt = Math.max(16, 2 * maxLoadedChunks);
  // The chunkMap the last restore scan walked, weakly. Departures change the
  // chunkMap, and that scan tracked what it found, so a scan of the same one
  // would find nothing.
  let restoreScannedIn: WeakRef<ReadonlyMap<number, ReadonlyUint8Array>> | null = null;

  // Pinned chunks: never evicted.
  let activeChunks = new Set<number>();

  // How many unsettled ensureLoadedMany calls asked for each chunk. No
  // eviction pass evicts one of them.
  const requested = new Map<number, number>();

  // While more chunks are loaded than maxLoadedChunks allows, as of the last
  // eviction attempt, the reasons chunks have stayed resident since the cache
  // went over (see `PressureCause`); null while within the limit. The pressure
  // warning is logged when a reason is new, so once per cause rather than on
  // every load while the cache stays over.
  let pressureCauses: Set<PressureCause> | null = null;
  // Whether, since the cache went over, an anchored chunk was found that edits
  // or history would keep too. Reset with `pressureCauses`.
  let anchoredHeldSeen = false;

  // The chunks eviction passes offered and the reducer refused, while the
  // store holds the state the last pass left (see `evictIfOverLimit`). The
  // reducer would refuse them again in that state, so a pass skips them.
  // Under "pin", history keeping chunks resident is a steady state, and
  // setActiveChunks runs a pass on every call; this keeps those passes from
  // measuring the same chunks again until the document changes. Any load,
  // eviction, edit, or attention change drops it.
  let refused: {
    readonly measuredIn: (state: EvictionInputs) => boolean;
    readonly chunks: Set<number>;
  } | null = null;

  // Whether an eviction pass is scheduled for a later task (see
  // `scheduleEvictionPass`).
  let passScheduled = false;

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

  function isTracked(chunkIndex: number): boolean {
    return lruOrder.has(chunkIndex) || lruFront.has(chunkIndex);
  }

  /** Mark a tracked chunk, or one the manager just loaded, most recently used. */
  function lruTouch(chunkIndex: number): void {
    lruFront.delete(chunkIndex);
    lruOrder.delete(chunkIndex);
    lruOrder.add(chunkIndex);
  }

  /** Track a chunk the manager just loaded as the most recently used. */
  function lruLoaded(chunkIndex: number): void {
    departed.delete(chunkIndex);
    lruTouch(chunkIndex);
  }

  /** Stop tracking a chunk that is no longer in memory. */
  function lruForget(chunkIndex: number): void {
    lruFront.delete(chunkIndex);
    lruOrder.delete(chunkIndex);
  }

  /**
   * Record that this manager's eviction removed `chunkIndex`, which held
   * `bytes`. Dead entries are swept once `departed` doubles, so it stays
   * within twice the entries a rollback could still restore, at O(1)
   * amortized cost.
   */
  function recordDeparture(chunkIndex: number, bytes: ReadonlyUint8Array): void {
    departed.set(chunkIndex, new WeakRef(bytes));
    if (departed.size < departedSweepAt) return;
    for (const [index, ref] of departed) {
      if (ref.deref() === undefined) departed.delete(index);
    }
    departedSweepAt = Math.max(16, 2 * maxLoadedChunks, 2 * departed.size);
  }

  /**
   * Track again, as the least recently used, the chunks in `resident` a
   * rollback restored: those in `departed` that hold the bytes they left with.
   * Entries for chunks loaded outside the manager since, or that no state can
   * restore, are dropped. It walks the smaller of `departed` and `resident`,
   * and only once the chunkMap has changed since the last walk.
   */
  function trackRestored(resident: ReadonlyMap<number, ReadonlyUint8Array>): void {
    if (departed.size === 0 || restoreScannedIn?.deref() === resident) return;
    const check = (chunkIndex: number, ref: WeakRef<ReadonlyUint8Array>) => {
      const bytes = resident.get(chunkIndex);
      if (bytes === undefined) {
        if (ref.deref() === undefined) departed.delete(chunkIndex);
        return;
      }
      departed.delete(chunkIndex);
      if (bytes === ref.deref() && !isTracked(chunkIndex)) lruFront.add(chunkIndex);
    };
    if (departed.size <= resident.size) {
      for (const [chunkIndex, ref] of departed) check(chunkIndex, ref);
    } else {
      for (const chunkIndex of resident.keys()) {
        const ref = departed.get(chunkIndex);
        if (ref !== undefined) check(chunkIndex, ref);
      }
    }
    restoreScannedIn = new WeakRef(resident);
  }

  /**
   * Hold `chunkIndices` against eviction until the returned function is
   * called. That function returns whether it released the last hold on any
   * of them, so an eviction pass may now evict it.
   */
  function holdRequested(chunkIndices: readonly number[]): () => boolean {
    for (const chunkIndex of chunkIndices) {
      requested.set(chunkIndex, (requested.get(chunkIndex) ?? 0) + 1);
    }
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      let freed = false;
      for (const chunkIndex of chunkIndices) {
        const holds = requested.get(chunkIndex) ?? 0;
        if (holds <= 1) {
          requested.delete(chunkIndex);
          freed = true;
        } else requested.set(chunkIndex, holds - 1);
      }
      return freed;
    };
  }

  // ── Eviction ──────────────────────────────────────────────────────────────

  /**
   * Evict least recently used chunks until at most maxLoadedChunks remain, or
   * none that may go is left, then warn when the cache stays over the limit.
   * Chunks the last pass saw refused are skipped while the document is as it
   * was (see `refused`).
   */
  function evictIfOverLimit(protectedChunkIndex?: number): void {
    if (disposed) return;
    const isProtected = (chunkIndex: number) =>
      chunkIndex === protectedChunkIndex || requested.has(chunkIndex);
    // Usually one pass, and at most two: see the retry below.
    for (let state = store.getSnapshot(), retried = false; ; ) {
      if (refused !== null && !refused.measuredIn(state)) refused = null;
      const resident = state.pieceTable.chunkMap;
      if (resident.size <= maxLoadedChunks) break;
      // Least recently used first: chunks the manager may evict that are still
      // in memory. Pinned and requested chunks stay. The reducer chooses
      // among them in one transition (see EVICT_CHUNKS): every chunk whose
      // eviction costs no history first, then as the policy allows. It stops
      // once the limit is met, so when the least recently used chunks cost no
      // history it measures only as many as must go.
      // Chunks a rollback restored go first, as the least recently used,
      // which they were when they went.
      trackRestored(resident);
      const candidates: number[] = [];
      for (const lru of [lruFront, lruOrder]) {
        for (const chunkIndex of lru) {
          // The manager can still track chunks another path evicted; forget them.
          if (!resident.has(chunkIndex)) lruForget(chunkIndex);
          else if (
            !activeChunks.has(chunkIndex) &&
            !isProtected(chunkIndex) &&
            refused?.chunks.has(chunkIndex) !== true
          ) {
            candidates.push(chunkIndex);
          }
        }
      }
      if (candidates.length === 0) break;
      // The eviction may discard history, as the policy allows. The store
      // that commits it warns of that through its logger, or without one
      // through this manager's (see `withEvictionWarnSink`), and a store
      // with events fires `history-drop`.
      withEvictionWarnSink(logger, state.pieceTable, () =>
        store.dispatch(DocumentActions.evictChunks(candidates, maxLoadedChunks)),
      );
      // A listener the eviction notified may have disposed the manager.
      if (disposed) return;
      const after = store.getSnapshot();
      const left = after.pieceTable.chunkMap;
      // Stop tracking the chunks this pass evicted, but remember them in case
      // a rollback restores them.
      for (const chunkIndex of candidates) {
        if (left.has(chunkIndex)) continue;
        lruForget(chunkIndex);
        recordDeparture(chunkIndex, resident.get(chunkIndex)!);
      }
      if (left.size <= maxLoadedChunks) break;
      if (after.history === state.history && after.attention === state.attention) {
        // Still over the limit, the reducer measured every candidate, and
        // with history unchanged it evicted only those that cost none: the
        // rest were refused. Evicting chunks adds no edits, attention, or
        // history, so it frees none of them, and the reducer would refuse
        // them again while the store holds `after`. A chunk loaded since
        // could part one from the text that kept it, so record them only
        // when none was.
        let loaded = false;
        if (left !== resident) {
          for (const chunkIndex of left.keys()) {
            if (!resident.has(chunkIndex)) {
              loaded = true;
              break;
            }
          }
        }
        if (!loaded) {
          const chunks = new Set<number>();
          for (const chunkIndex of refused?.chunks ?? []) {
            if (left.has(chunkIndex)) chunks.add(chunkIndex);
          }
          for (const chunkIndex of candidates) if (left.has(chunkIndex)) chunks.add(chunkIndex);
          refused = { measuredIn: sameEvictionInputsAs(after), chunks };
        }
        break;
      }
      // The eviction discarded history, or a listener it notified changed
      // history or attention, which may have freed the chunks it refused.
      // Offer them once more, against the state now.
      if (retried) break;
      retried = true;
      state = after;
    }

    const current = store.getSnapshot();
    const { chunkMap } = current.pieceTable;
    // Forget chunks that left memory through another path, or a listener the
    // eviction notified. The scan is O(L), so it runs only once the manager
    // must track some.
    if (lruOrder.size + lruFront.size > chunkMap.size) {
      for (const lru of [lruFront, lruOrder]) {
        for (const chunkIndex of lru) {
          if (!chunkMap.has(chunkIndex)) lruForget(chunkIndex);
        }
      }
    }

    const loadedCount = chunkMap.size;
    if (loadedCount <= maxLoadedChunks) {
      pressureCauses = null;
      anchoredHeldSeen = false;
      refused = null;
      return;
    }
    // Warn when the cache goes over the limit, and when a reason not seen
    // since then keeps chunks resident, not on every load while it stays
    // over: under "pin", history keeping chunks resident is a steady state.
    const counts = new Map<PressureCause, number>();
    const count = (cause: PressureCause) => counts.set(cause, (counts.get(cause) ?? 0) + 1);
    const anchoredChunks: number[] = [];
    for (const chunkIndex of chunkMap.keys()) {
      if (activeChunks.has(chunkIndex)) count("pinned");
      else if (isProtected(chunkIndex)) count("requested");
      else if (!isTracked(chunkIndex)) count("untracked");
      else if (hasAttentionAnchoredToChunk(current, chunkIndex)) {
        count("anchored");
        anchoredChunks.push(chunkIndex);
      } else count("held");
    }
    const seen = pressureCauses ?? new Set<PressureCause>();
    pressureCauses = seen;
    const isNew = (cause: PressureCause) => counts.has(cause) && !seen.has(cause);
    let newCause = PRESSURE_CAUSES.some(isNew);
    // An anchored chunk can be held by edits or history too, which matters
    // once the attention is gone. It is counted apart from "held", so the
    // counts still add up to the chunks loaded. Find out only when it could
    // add a reason or the warning needs the count.
    let anchoredHeld = 0;
    let anchoredHeldByHistory = false;
    if (anchoredChunks.length > 0 && (newCause || !anchoredHeldSeen)) {
      for (const chunkIndex of anchoredChunks) {
        const reason = chunkHoldReason(current, chunkIndex);
        if (reason === null) continue;
        anchoredHeld++;
        if (reason === "history") anchoredHeldByHistory = true;
      }
      if (anchoredHeld > 0) {
        newCause ||= !anchoredHeldSeen;
        anchoredHeldSeen = true;
      }
    }
    for (const cause of counts.keys()) seen.add(cause);
    if (newCause) {
      const reasons = PRESSURE_CAUSES.filter((cause) => counts.has(cause)).map(
        (cause) =>
          `${counts.get(cause)} ${PRESSURE_CAUSE_TEXT[cause]}` +
          (cause === "anchored" && anchoredHeld > 0
            ? `, ${anchoredHeld} of which also ${PRESSURE_CAUSE_TEXT.held}`
            : ""),
      );
      // The hint names history, so it needs a chunk history may be keeping:
      // one refused eviction, or an anchored one history would keep.
      // The chunk that brought the cache over the limit has loaded, so a
      // throwing logger is reported, not thrown to the caller.
      warnSafely(
        logger,
        `[ChunkManager] eviction pressure: ${loadedCount} chunks loaded, over the memory ` +
          `limit (${maxLoadedChunks}), and none can be evicted: ${reasons.join("; ")}.` +
          ((counts.has("held") || anchoredHeldByHistory) && current.history.evictionPolicy === "pin"
            ? ` The "pin" history eviction policy keeps chunks undo history points into; ` +
              `"pin-bounded" or "drop" lets eviction discard that history.`
            : ""),
        "The ChunkManager logger threw while warning of eviction pressure",
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
              lruLoaded(chunkIndex);
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

    // Already in memory. No eviction pass runs here: one could evict inside a
    // transaction the caller has open, and the call stays O(1).
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
    if (fresh.length === 0 && pending.length === 0) return Promise.resolve();
    // Until the call settles, no eviction pass evicts a chunk it asked for,
    // the ones already in memory too.
    const release = holdRequested(unique);
    // Hold every chunk until each fetch it waits on has settled, so a failure
    // does not release chunks a fetch still loading would then evict. Once
    // released, the chunks are offered for eviction again: the passes their
    // loads ran could not evict them, and may have left the cache over the
    // limit. That pass runs in a later task, so the caller can read what it
    // asked for when the call resolves.
    const settle = (promises: readonly Promise<void>[]): Promise<void> =>
      Promise.allSettled(promises).then((results) => {
        if (release()) scheduleEvictionPass();
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
    if (fresh.length === 0) return settle(pending);

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
            lruLoaded(chunk.chunkIndex);
          }
          evictIfOverLimit();
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
    return settle(pending);
  }

  /**
   * Run an eviction pass in a later task, unless one is already scheduled.
   * Nothing waits on it, so an error it throws goes to the logger's `error`.
   */
  function scheduleEvictionPass(): void {
    if (disposed || passScheduled) return;
    passScheduled = true;
    setTimeout(() => {
      passScheduled = false;
      try {
        evictIfOverLimit();
      } catch (error) {
        reportCaughtError(
          logger,
          "The ChunkManager eviction pass after a batch load failed",
          error,
        );
      }
    }, 0);
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
    lruFront.clear();
    departed.clear();
    restoreScannedIn = null;
    activeChunks.clear();
    requested.clear();
    refused = null;
    pressureCauses = null;
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
