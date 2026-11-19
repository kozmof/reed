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

import type { DocumentState, ReedLogger } from "../../types/state.js";
import type { DocumentStore } from "../../types/store.js";
import { isChunkByteLengthValid } from "../core/piece-table.js";
import { DocumentActions } from "./actions.js";
import { getRedoCount, getUndoCount } from "./history.js";
import { documentReducer } from "./reducer.js";
import { chunkHoldReason, hasAttentionAnchoredToChunk } from "./chunk-actions.js";

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
// Refused candidates
// =============================================================================

/**
 * Why a chunk stays resident while the cache is over the limit after an
 * eviction pass:
 * - `"pinned"`: in the active set (`setActiveChunks`).
 * - `"requested"`: just loaded for the call that ran the pass.
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
  requested: "just loaded for the current request",
  anchored: "hold an attention anchor",
  held: "hold user edits or undo history",
  untracked: "loaded outside this ChunkManager",
};

/** Every `PressureCause`, in the order the pressure warning lists them. */
const PRESSURE_CAUSES = Object.keys(PRESSURE_CAUSE_TEXT) as readonly PressureCause[];

type ChunkMap = DocumentState["pieceTable"]["chunkMap"];

/** Chunks an eviction pass could not evict, and the state it measured them in. */
interface Stuck {
  readonly history: DocumentState["history"];
  readonly attention: DocumentState["attention"];
  readonly chunkMap: ChunkMap;
  readonly chunks: ReadonlySet<number>;
}

/**
 * The resident chunks of `chunkMap` whose standing against edits may differ
 * from when `previous` was the chunk map, history and attention unchanged.
 *
 * What keeps a chunk resident is history pointing inside it, an attention
 * anchored to it, or edits splitting or touching it (see
 * `evictionCandidate`). Every edit, undo, redo, and history clear replaces
 * the history object, and every attention change the attention object. So
 * while both are unchanged, the text has changed only by chunks loaded or
 * evicted, which leave what history points inside a chunk, and the
 * attentions anchored to it, as they were. Evicting a chunk only brings text
 * together, and a chunk no edit touches has no add piece beside it to bring
 * to its neighbours. Loading one puts its text between the loaded chunks on
 * either side, which can part one of them from an add piece that touched it.
 * So the chunks returned are each chunk loaded since and the nearest resident
 * chunk below and above it.
 *
 * Every load and eviction replaces the chunk map, so when it is `previous`
 * this costs O(1). Otherwise finding the chunks loaded since costs O(L) for L
 * resident chunks, and finding their neighbours O(L log k) more for k of them.
 */
function chunksMovedByLoads(previous: ChunkMap, chunkMap: ChunkMap): ReadonlySet<number> {
  const moved = new Set<number>();
  if (chunkMap === previous) return moved;
  const loaded: number[] = [];
  for (const chunk of chunkMap.keys()) if (!previous.has(chunk)) loaded.push(chunk);
  if (loaded.length === 0) return moved;
  loaded.sort((a, b) => a - b);
  // The nearest resident chunk below and above each one loaded since. A chunk
  // with one loaded since between it and another is not the other's nearest.
  const below = loaded.map(() => -Infinity);
  const above = loaded.map(() => Infinity);
  for (const chunk of chunkMap.keys()) {
    // The first chunk loaded since that lies above `chunk`.
    let lo = 0;
    let hi = loaded.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (loaded[mid]! > chunk) hi = mid;
      else lo = mid + 1;
    }
    if (lo < loaded.length) below[lo] = Math.max(below[lo]!, chunk);
    const under = loaded[lo - 1] === chunk ? lo - 2 : lo - 1;
    if (under >= 0) above[under] = Math.min(above[under]!, chunk);
  }
  for (const chunk of loaded) moved.add(chunk);
  for (const chunk of below) if (chunk !== -Infinity) moved.add(chunk);
  for (const chunk of above) if (chunk !== Infinity) moved.add(chunk);
  return moved;
}

/**
 * The chunks of `stuck` that still cannot be evicted in `state`, or null when
 * that is unknown: they stay stuck while history and attention are the ones
 * measured, except those loads may have moved (see `chunksMovedByLoads`).
 */
function stillStuck(stuck: Stuck, state: DocumentState): ReadonlySet<number> | null {
  if (state.history !== stuck.history || state.attention !== stuck.attention) return null;
  const moved = chunksMovedByLoads(stuck.chunkMap, state.pieceTable.chunkMap);
  if (moved.size === 0) return stuck.chunks;
  const chunks = new Set(stuck.chunks);
  for (const chunk of moved) chunks.delete(chunk);
  return chunks;
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

  // While more chunks are loaded than maxLoadedChunks allows, as of the last
  // eviction attempt, the reasons chunks have stayed resident since the cache
  // went over (see `PressureCause`); null while within the limit. The pressure
  // warning is logged when a reason is new, so once per cause rather than on
  // every load while the cache stays over.
  let pressureCauses: Set<PressureCause> | null = null;
  // Whether, since the cache went over, an anchored chunk was found that edits
  // or history would keep too. Reset with `pressureCauses`.
  let anchoredHeldSeen = false;

  // For each resident chunk, whether an attention is anchored inside it and
  // what else would keep it (see `chunkHoldReason`), as measured in a state
  // with this history and attention. Each entry holds until a load may have
  // moved its chunk against an add piece (see `chunksMovedByLoads`, the rule
  // `stillStuck` follows), so the pressure check walks each chunk once rather
  // than on every load while the cache stays over the limit.
  interface ChunkReasons {
    anchored?: boolean;
    hold?: ReturnType<typeof chunkHoldReason>;
  }
  let chunkMemo: {
    readonly history: DocumentState["history"];
    readonly attention: DocumentState["attention"];
    chunkMap: ChunkMap;
    readonly chunks: Map<number, ChunkReasons>;
  } | null = null;

  function reasonsFor(state: DocumentState, chunkIndex: number): ChunkReasons {
    const { chunkMap } = state.pieceTable;
    if (
      chunkMemo === null ||
      chunkMemo.history !== state.history ||
      chunkMemo.attention !== state.attention
    ) {
      chunkMemo = {
        history: state.history,
        attention: state.attention,
        chunkMap,
        chunks: new Map(),
      };
    } else if (chunkMemo.chunkMap !== chunkMap) {
      for (const chunk of chunksMovedByLoads(chunkMemo.chunkMap, chunkMap)) {
        chunkMemo.chunks.delete(chunk);
      }
      chunkMemo.chunkMap = chunkMap;
    }
    let reasons = chunkMemo.chunks.get(chunkIndex);
    if (reasons === undefined) {
      reasons = {};
      chunkMemo.chunks.set(chunkIndex, reasons);
    }
    return reasons;
  }

  function isAnchored(state: DocumentState, chunkIndex: number): boolean {
    if (state.attention.attentions.size === 0) return false;
    const reasons = reasonsFor(state, chunkIndex);
    reasons.anchored ??= hasAttentionAnchoredToChunk(state, chunkIndex);
    return reasons.anchored;
  }

  function holdReason(
    state: DocumentState,
    chunkIndex: number,
  ): ReturnType<typeof chunkHoldReason> {
    const reasons = reasonsFor(state, chunkIndex);
    // null is a measured reason, so test for undefined rather than use ??=.
    if (reasons.hold === undefined) reasons.hold = chunkHoldReason(state, chunkIndex);
    return reasons.hold;
  }

  // Candidates the last eviction pass measured and could not evict, though
  // over the limit, and the state it measured them in. Under "pin", history
  // keeping chunks resident is a steady state, and offering them again on
  // every load would cost O(L log n) to evict nothing. A pass skips the ones
  // that still cannot go (see `stillStuck`).
  let stuck: Stuck | null = null;

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

  /**
   * Evict least recently used chunks until at most maxLoadedChunks remain, or
   * none that may go is left. The chunks the last pass could not evict are
   * skipped while they still cannot go (see `stuck`).
   */
  function evictIfOverLimit(protectedChunkIndices?: number | ReadonlySet<number>): void {
    if (disposed) return;
    const isProtected = (chunkIndex: number) =>
      typeof protectedChunkIndices === "number"
        ? chunkIndex === protectedChunkIndices
        : protectedChunkIndices?.has(chunkIndex) === true;
    const previous = stuck;
    stuck = null;

    const start = store.getSnapshot();
    const resident = start.pieceTable.chunkMap;
    const excess = resident.size - maxLoadedChunks;
    if (excess > 0) {
      let known = previous === null ? null : stillStuck(previous, start);
      // Least recently used first: chunks the manager may evict that are still
      // in memory. Pinned chunks and the chunks just loaded for the caller
      // stay. The reducer chooses among them (see EVICT_CHUNKS): every chunk
      // whose eviction costs no history first, then as the policy allows.
      const evictable = (chunkIndex: number) =>
        !activeChunks.has(chunkIndex) &&
        !isProtected(chunkIndex) &&
        known?.has(chunkIndex) !== true;
      // Usually the least recently used chunks cost no history, so try just
      // as many as must go, evicting only those that cost none. That is what
      // the full pass would evict first, so offering every candidate only
      // when this falls short chooses the same chunks.
      const head: number[] = [];
      for (const candidate of lruOrder) {
        if (head.length === excess) break;
        // lruOrder can still list chunks another path evicted; skip them so
        // they do not take slots from chunks this pass could evict.
        if (evictable(candidate) && resident.has(candidate)) head.push(candidate);
      }
      if (head.length > 0) {
        store.dispatch(DocumentActions.evictChunks(head, maxLoadedChunks, true));
      }
      const before = store.getSnapshot();
      // A store listener can dispatch while the eviction notifies it, so check
      // the skipped chunks again against the state the full pass starts from.
      // The eviction itself keeps history and attention, and only evicts.
      if (known !== null && before !== start) {
        known = stillStuck(
          {
            history: start.history,
            attention: start.attention,
            chunkMap: resident,
            chunks: known,
          },
          before,
        );
      }
      const remaining = before.pieceTable.chunkMap;
      if (remaining.size > maxLoadedChunks) {
        const candidates: number[] = [];
        for (const candidate of lruOrder) {
          if (evictable(candidate) && remaining.has(candidate)) candidates.push(candidate);
        }
        if (candidates.length > 0) {
          // Without keepHistory this pass may discard history, as the policy
          // allows. Undo then stops short with no other sign, so say so.
          const evict = DocumentActions.evictChunks(candidates, maxLoadedChunks);
          store.dispatch(evict);
          // A store listener the eviction notifies can edit too, so the state
          // after the dispatch need not be the eviction's alone. History is
          // unchanged only when neither touched it; otherwise reduce the
          // eviction again on `before`, which the reducer, being pure, gives
          // as the dispatch did. That doubles only passes that change history.
          if (store.getSnapshot().history !== before.history) {
            const evicted = documentReducer(before, evict);
            if (evicted.history !== before.history) {
              const undoDropped = getUndoCount(before) - getUndoCount(evicted);
              const redoDropped = getRedoCount(before) - getRedoCount(evicted);
              logger?.warn?.(
                `[ChunkManager] evicting chunks to stay within the memory limit (${maxLoadedChunks}) ` +
                  `discarded ${undoDropped} undo and ${redoDropped} redo entries that pointed into them, ` +
                  `under the "${evicted.history.evictionPolicy}" history eviction policy. ` +
                  `Raise maxLoadedChunks, or use "pin" to keep history at the cost of memory.`,
              );
            }
          }
        }
        // Still over the limit, so every candidate was offered: those left,
        // and the known ones skipped, cannot go in the state they were
        // measured in, `before`. That holds only while history and attention
        // are the ones `before` had: when the pass discarded history, or a
        // listener changed either while the pass notified it, nothing is kept.
        const after = store.getSnapshot();
        const left = after.pieceTable.chunkMap;
        if (
          left.size > maxLoadedChunks &&
          after.history === before.history &&
          after.attention === before.attention
        ) {
          const chunks = new Set<number>();
          for (const chunk of known ?? []) if (left.has(chunk)) chunks.add(chunk);
          for (const chunk of candidates) if (left.has(chunk)) chunks.add(chunk);
          stuck = {
            history: before.history,
            attention: before.attention,
            chunkMap: remaining,
            chunks,
          };
        }
      }
    }

    // Forget chunks no longer in memory, evicted here or by another path. The
    // scan is O(L), so it runs only after an eviction pass, or once lruOrder
    // lists more chunks than are resident and must hold stale ones. A stale
    // entry left in between costs nothing: every pass above skips it.
    const { chunkMap } = store.getSnapshot().pieceTable;
    if (excess > 0 || lruOrder.size > chunkMap.size) {
      for (const chunkIndex of lruOrder) {
        if (!chunkMap.has(chunkIndex)) lruRemove(chunkIndex);
      }
    }

    const loadedCount = chunkMap.size;
    if (loadedCount <= maxLoadedChunks) {
      pressureCauses = null;
      anchoredHeldSeen = false;
      return;
    }
    // Warn when the cache goes over the limit, and when a reason not seen
    // since then keeps chunks resident, not on every load while it stays
    // over: under "pin", history keeping chunks resident is a steady state.
    const counts = new Map<PressureCause, number>();
    const count = (cause: PressureCause) => counts.set(cause, (counts.get(cause) ?? 0) + 1);
    const current = store.getSnapshot();
    const anchoredChunks: number[] = [];
    for (const chunkIndex of chunkMap.keys()) {
      if (activeChunks.has(chunkIndex)) count("pinned");
      else if (isProtected(chunkIndex)) count("requested");
      else if (!lruOrder.has(chunkIndex)) count("untracked");
      else if (isAnchored(current, chunkIndex)) {
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
    // counts still add up to the chunks loaded. Finding out walks the chunk
    // the first time, so do it only when it could add a reason or the warning
    // needs the count.
    let anchoredHeld = 0;
    let anchoredHeldByHistory = false;
    if (anchoredChunks.length > 0 && (newCause || !anchoredHeldSeen)) {
      for (const chunkIndex of anchoredChunks) {
        const reason = holdReason(current, chunkIndex);
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
      logger?.warn?.(
        `[ChunkManager] eviction pressure: ${loadedCount} chunks loaded, over the memory ` +
          `limit (${maxLoadedChunks}), and none can be evicted: ${reasons.join("; ")}.` +
          ((counts.has("held") || anchoredHeldByHistory) &&
          store.getSnapshot().history.evictionPolicy === "pin"
            ? ` The "pin" history eviction policy keeps chunks undo history points into; ` +
              `"pin-bounded" or "drop" lets eviction discard that history.`
            : ""),
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
