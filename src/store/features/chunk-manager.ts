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
import type { DocumentStore, ReconcilableDocumentStore, Unsubscribe } from "../../types/store.js";
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
   *
   * Under 'queue', a canceled fetch settles at once, but the next loader call
   * waits until the canceled one's loader call has settled, so loader calls
   * never overlap. A loader that ignores its signal and never settles stalls
   * the fetches queued behind it; canceling them settles them.
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
 *
 * The manager owns the chunks it loads and those already loaded when it is
 * created, such as by an earlier manager or a checkpoint, and evicts them
 * least recently used first. It never evicts a chunk loaded outside it after
 * it was created.
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
   * fetch it waits on has settled or been canceled, so its holds last exactly
   * as long as it is pending: it resolves when every fetch succeeded, and
   * otherwise rejects with the first failure; successful chunks remain
   * loaded. A canceled fetch settles at once, even when the loader ignores
   * its signal, so `cancelPendingOutside` or `dispose` ends a call waiting on
   * a loader that never settles. An eviction pass then runs in a later task,
   * once no transaction is open, so when it asked for more than
   * maxLoadedChunks, the chunks stay loaded as the call resolves, and the
   * cache returns toward the limit after.
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
 * - `"untracked"`: loaded without this manager after it was created, so it
 *   never offers it.
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
  untracked: "loaded outside this ChunkManager after it was created",
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

  // The bytes of every chunk this manager owns, as the store holds them,
  // weakly: those it loaded, and those resident when it was created. A
  // resident chunk is the manager's to evict exactly when its bytes are in
  // here. Each LOAD_CHUNK action carries a fresh copy of the bytes, so a load
  // outside the manager brings bytes of its own, while a rollback restores
  // the very bytes a chunk held, however the chunk left memory.
  const owned = new WeakSet<ReadonlyUint8Array>();

  // Recency of the chunks this manager owns, least recently used first, each
  // with the bytes it last took ownership of, weakly. A chunk that left
  // memory keeps its place while a rollback could restore it: while the store
  // may have a transaction open and those bytes are alive. A restored chunk
  // is then offered as recently used as it was when it went. Passes drop
  // entries for chunks gone for good, and so does a sweep once the map grows
  // past `lruSweepAt`, so it stays within twice the chunks it must track.
  const lru = new Map<number, WeakRef<ReadonlyUint8Array>>();
  let lruSweepAt = Math.max(16, 2 * maxLoadedChunks);

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

  // The timer of an eviction pass scheduled for a later task, and while that
  // pass waits for a transaction to close, its store subscription (see
  // `scheduleEvictionPass`). At most one of them is set.
  let passTimer: ReturnType<typeof setTimeout> | null = null;
  let passAwaitingCommit: Unsubscribe | null = null;

  // When fetchStrategy is 'queue', serialise fetches through this promise chain.
  let fetchQueue: Promise<void> = Promise.resolve();

  // Disposed flag: prevents dispatches after dispose().
  let disposed = false;

  // Chunks already resident, such as those an earlier manager or a checkpoint
  // left, are this manager's, so it can evict them toward its limit. No other
  // manager evicts them any more, so without this they would stay for good.
  for (const [chunkIndex, bytes] of store.getSnapshot().pieceTable.chunkMap) {
    adopt(chunkIndex, bytes);
  }

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

  /** Whether `chunkIndex` is resident in `chunkMap` with bytes this manager loaded. */
  function isOwnedIn(
    chunkMap: ReadonlyMap<number, ReadonlyUint8Array>,
    chunkIndex: number,
  ): boolean {
    const bytes = chunkMap.get(chunkIndex);
    return bytes !== undefined && owned.has(bytes);
  }

  /** Take ownership of `chunkIndex`, resident with `bytes`, as the most recently used. */
  function adopt(chunkIndex: number, bytes: ReadonlyUint8Array): void {
    owned.add(bytes);
    lru.delete(chunkIndex);
    lru.set(chunkIndex, new WeakRef(bytes));
  }

  /** Mark a chunk this manager owns the most recently used. */
  function lruTouch(chunkIndex: number): void {
    const ref = lru.get(chunkIndex);
    if (ref === undefined) return;
    lru.delete(chunkIndex);
    lru.set(chunkIndex, ref);
  }

  /**
   * Take ownership of `chunkIndex` after a load this manager dispatched, when
   * that load brought it into memory: it was not resident in `before`, the
   * chunkMap the load was dispatched against. One already resident then was
   * loaded outside the manager, so the load changed nothing, and it stays
   * untracked. The reducer stores a fresh copy of every load's bytes, so no
   * other load can bring back the bytes recorded here.
   */
  function adoptLoaded(chunkIndex: number, before: ReadonlyMap<number, ReadonlyUint8Array>): void {
    if (before.has(chunkIndex)) return;
    const bytes = store.getSnapshot().pieceTable.chunkMap.get(chunkIndex);
    if (bytes !== undefined) adopt(chunkIndex, bytes);
  }

  /**
   * Whether the store may have a transaction open, so a rollback could still
   * restore chunks that have left memory. A store with transaction controls
   * but no `isInTransaction`, such as an older wrapper, may.
   */
  function mayBeInTransaction(): boolean {
    const { isInTransaction, beginTransaction } = store as Partial<ReconcilableDocumentStore>;
    if (typeof isInTransaction === "function") return isInTransaction.call(store);
    return typeof beginTransaction === "function";
  }

  /**
   * Whether the `lru` entry for `chunkIndex` is for a chunk gone for good: it
   * is not resident with bytes this manager owns, and no rollback can bring
   * back the bytes it took ownership of.
   */
  function isGone(
    chunkMap: ReadonlyMap<number, ReadonlyUint8Array>,
    chunkIndex: number,
    ref: WeakRef<ReadonlyUint8Array>,
    rollbackPossible: boolean,
  ): boolean {
    return !isOwnedIn(chunkMap, chunkIndex) && (!rollbackPossible || ref.deref() === undefined);
  }

  /** Drop `lru` entries for chunks gone for good. O(L), amortized O(1) per load. */
  function sweepLru(chunkMap: ReadonlyMap<number, ReadonlyUint8Array>): void {
    const rollbackPossible = mayBeInTransaction();
    for (const [chunkIndex, ref] of lru) {
      if (isGone(chunkMap, chunkIndex, ref, rollbackPossible)) lru.delete(chunkIndex);
    }
    lruSweepAt = Math.max(16, 2 * maxLoadedChunks, 2 * lru.size);
  }

  /** Mark `chunkIndex` most recently used when it is resident and owned. */
  function touchIfOwned(
    chunkMap: ReadonlyMap<number, ReadonlyUint8Array>,
    chunkIndex: number,
  ): void {
    if (isOwnedIn(chunkMap, chunkIndex)) lruTouch(chunkIndex);
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
      const mayGo = (chunkIndex: number) =>
        !activeChunks.has(chunkIndex) &&
        !isProtected(chunkIndex) &&
        refused?.chunks.has(chunkIndex) !== true;
      const candidates: number[] = [];
      // Chunks a rollback restored are still in `lru`, in the place they had
      // when they went. Forget chunks that left memory, or came back with
      // bytes loaded outside the manager, once no rollback can restore them.
      const rollbackPossible = mayBeInTransaction();
      for (const [chunkIndex, ref] of lru) {
        if (isOwnedIn(resident, chunkIndex)) {
          if (mayGo(chunkIndex)) candidates.push(chunkIndex);
        } else if (isGone(resident, chunkIndex, ref, rollbackPossible)) lru.delete(chunkIndex);
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
      // The chunks this pass evicted keep their place in `lru` while a
      // rollback could restore them; later passes forget them after that.
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
    // Forget chunks gone for good, which passes that stop early never visit.
    if (lru.size > lruSweepAt) sweepLru(chunkMap);

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
      else if (!isOwnedIn(chunkMap, chunkIndex)) count("untracked");
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

  /**
   * Call the loader for `chunkIndex`, settling as soon as `signal` aborts,
   * even when the loader ignores it, so a canceled fetch never keeps a call
   * or its holds pending. `idle` is called once the loader call itself has
   * settled, or at once when `signal` has already aborted and it makes none.
   */
  function loadAbortable(
    chunkIndex: number,
    signal: AbortSignal,
    idle: () => void,
  ): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      if (signal.aborted) {
        idle();
        reject(signal.reason);
        return;
      }
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      new Promise<Uint8Array>((load) => load(loader.loadChunk(chunkIndex, signal)))
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener("abort", onAbort);
          idle();
        });
    });
  }

  /**
   * Start `fetch` as the fetch strategy allows. Under 'queue', it starts once
   * the fetch queued before it is idle: its loader call has settled, which
   * can be after that fetch settled on cancellation, so loader calls never
   * overlap. `fetch` calls `idle` once its loader call has settled, or once
   * it knows it makes none. A fetch canceled while it waits settles at once
   * with `canceled`, and keeps its place until the one before it is idle.
   */
  function scheduleFetch<T>(
    signal: AbortSignal,
    canceled: T,
    fetch: (idle: () => void) => Promise<T>,
  ): Promise<T> {
    if (fetchStrategy === "parallel") return fetch(() => {});
    const previous = fetchQueue;
    let idle!: () => void;
    fetchQueue = new Promise<void>((resolve) => {
      idle = resolve;
    });
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => resolve(canceled);
      signal.addEventListener("abort", onAbort, { once: true });
      void previous.then(() => {
        signal.removeEventListener("abort", onAbort);
        fetch(idle).then(resolve, reject);
      });
    });
  }

  function doFetch(chunkIndex: number): Promise<void> {
    const abortController = new AbortController();
    abortControllers.set(chunkIndex, abortController);

    const fetch = async (idle: () => void): Promise<void> => {
      if (disposed || abortController.signal.aborted) {
        idle();
        return;
      }
      return loadAbortable(chunkIndex, abortController.signal, idle)
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
          adoptLoaded(chunkIndex, pieceTable.chunkMap);
          evictIfOverLimit(chunkIndex);
        })
        .catch((error: unknown) => {
          // Manager-owned cancellation settles pending calls without loading.
          if (abortController.signal.aborted) return;
          throw error;
        });
    };

    // Clean up even when cancellation prevents a queued fetch from starting.
    const promise = scheduleFetch(abortController.signal, undefined, fetch).finally(() => {
      if (inFlight.get(chunkIndex) === promise) inFlight.delete(chunkIndex);
      if (abortControllers.get(chunkIndex) === abortController) {
        abortControllers.delete(chunkIndex);
      }
    });
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
    // transaction the caller has open, and the call stays O(1). A chunk loaded
    // outside the manager stays untracked, so the manager never evicts it.
    const { chunkMap } = store.getSnapshot().pieceTable;
    if (chunkMap.has(chunkIndex)) {
      touchIfOwned(chunkMap, chunkIndex);
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
    const { chunkMap } = store.getSnapshot().pieceTable;
    for (const chunkIndex of unique) {
      if (chunkMap.has(chunkIndex)) {
        touchIfOwned(chunkMap, chunkIndex);
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
    // Hold every chunk until each fetch the call waits on has settled, so a
    // failure does not release chunks a fetch still loading would then
    // evict, and settle only then, with the first failure if any, so the
    // call is pending exactly while it holds chunks. A canceled fetch settles
    // at once (see `loadAbortable`), so a hung loader keeps the call pending
    // only until its chunk is canceled or the manager disposed. Once
    // released, the chunks are offered for eviction again: the passes their
    // loads ran could not evict them, and may have left the cache over the
    // limit. That pass runs in a later task, so the caller can read what it
    // asked for when the call resolves.
    const settle = (promises: readonly Promise<void>[]): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        let unsettled = promises.length;
        let failure: { readonly error: unknown } | null = null;
        const settled = () => {
          if (--unsettled > 0) return;
          if (release()) scheduleEvictionPass();
          if (failure === null) resolve();
          else reject(failure.error);
        };
        for (const promise of promises) {
          promise.then(settled, (error: unknown) => {
            failure ??= { error };
            settled();
          });
        }
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
      const fetch = async (idle: () => void): Promise<Uint8Array | null> => {
        if (disposed || controller.signal.aborted) {
          idle();
          return null;
        }
        try {
          const data = await loadAbortable(chunkIndex, controller.signal, idle);
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

      return scheduleFetch(controller.signal, null, fetch);
    };

    // Coalesce completions without waiting for a slow sibling. Workers bound
    // outstanding I/O and completed buffers waiting for dispatch.
    let ready: Array<{ chunkIndex: number; data: Uint8Array }> = [];
    let commit: Promise<void> | undefined;
    function enqueue(chunkIndex: number, data: Uint8Array): Promise<void> {
      ready.push({ chunkIndex, data });
      return (commit ??= Promise.resolve().then(() => {
        const chunks = ready.filter((chunk) => !controllers.get(chunk.chunkIndex)!.signal.aborted);
        ready = [];
        commit = undefined;
        if (disposed || chunks.length === 0) return;
        const before = store.getSnapshot().pieceTable.chunkMap;
        store.dispatch(DocumentActions.loadChunks(chunks));
        const after = store.getSnapshot();
        for (const chunk of chunks) {
          if (!after.pieceTable.chunkMap.has(chunk.chunkIndex)) {
            throw new Error(
              `Chunk ${chunk.chunkIndex} was fetched but the store did not retain it after LOAD_CHUNKS dispatch`,
            );
          }
          adoptLoaded(chunk.chunkIndex, before);
        }
        evictIfOverLimit();
      }));
    }

    // Each chunk settles on its own, so a caller waiting on one, and the
    // first failure, never wait on a slow sibling.
    const loads = new Map<
      number,
      { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void }
    >();
    for (const chunkIndex of fresh) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      loads.set(chunkIndex, { promise, resolve, reject });
      inFlight.set(chunkIndex, promise);
      pending.push(promise);
    }

    let cursor = 0;
    for (let worker = 0; worker < Math.min(maxConcurrentFetches, fresh.length); worker++) {
      void (async () => {
        while (cursor < fresh.length) {
          const chunkIndex = fresh[cursor++]!;
          const load = loads.get(chunkIndex)!;
          const controller = controllers.get(chunkIndex)!;
          try {
            const data = await fetchOne(chunkIndex, controller);
            if (data !== null) await enqueue(chunkIndex, data);
            load.resolve();
          } catch (error) {
            load.reject(error);
          } finally {
            if (inFlight.get(chunkIndex) === load.promise) inFlight.delete(chunkIndex);
            if (abortControllers.get(chunkIndex) === controller) {
              abortControllers.delete(chunkIndex);
            }
          }
        }
      })();
    }

    return settle(pending);
  }

  /**
   * Run an eviction pass in a later task, unless one is already scheduled,
   * and never inside a transaction a caller left open across an await. When
   * that task finds the store may have a transaction open, the pass runs at
   * the store's next notification instead, which a store sends only once its
   * outermost transaction has closed. A store that can say whether one is
   * open is asked again then. A wrapper with transaction controls but no
   * `isInTransaction` cannot say, so its pass runs at that notification, or
   * not at all while the store stays idle. Nothing waits on the pass, so an
   * error it throws goes to the logger's `error`.
   */
  function scheduleEvictionPass(): void {
    if (disposed || passTimer !== null || passAwaitingCommit !== null) return;
    const run = (pass: () => void) => {
      try {
        pass();
      } catch (error) {
        reportCaughtError(
          logger,
          "The ChunkManager eviction pass after a batch load failed",
          error,
        );
      }
    };
    passTimer = setTimeout(() => {
      passTimer = null;
      run(() => {
        if (disposed) return;
        if (!mayBeInTransaction()) {
          evictIfOverLimit();
          return;
        }
        const canTell =
          typeof (store as Partial<ReconcilableDocumentStore>).isInTransaction === "function";
        passAwaitingCommit = store.subscribe(() => {
          run(() => {
            if (canTell && mayBeInTransaction()) return;
            passAwaitingCommit?.();
            passAwaitingCommit = null;
            evictIfOverLimit();
          });
        });
      });
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
    lru.clear();
    if (passTimer !== null) clearTimeout(passTimer);
    passTimer = null;
    passAwaitingCommit?.();
    passAwaitingCommit = null;
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
