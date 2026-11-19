/**
 * The history an EVICT_CHUNKS action itself discarded, for the caller that
 * dispatched it.
 *
 * A store listener that an action notifies can dispatch again, so the store's
 * state after `dispatch` returns need not be the action's. ChunkManager, which
 * reports the history an eviction discarded, still sends the eviction through
 * `store.dispatch`, so whatever wraps the store sees the action, and learns
 * here what the eviction itself did.
 *
 * Each store Reed builds carries an eviction tap (`EVICTION_TAP`). The store
 * passes every action it commits to its own tap, with the history the reducer
 * read and the history it produced, so the reducer stays pure. While a caller
 * awaits an eviction on that tap, the first matching eviction the store
 * commits answers it. Nothing is inferred from other stores: a mirror that a
 * wrapper also dispatches to has a tap of its own, which nobody awaits.
 */

import type { DocumentState, HistoryState } from "../../types/state.js";
import type { DocumentAction, EvictChunksAction } from "../../types/actions.js";
import type { DocumentStore } from "../../types/store.js";
import { documentReducer } from "./reducer.js";

/** The history an eviction reduced from, and the history it left. */
export interface EvictionHistory {
  readonly from: HistoryState;
  readonly to: HistoryState;
}

interface AwaitedEviction {
  readonly action: EvictChunksAction;
  readonly onDropped: (history: EvictionHistory) => void;
  /** Whether the store committed the eviction. */
  committed: boolean;
  /** What the eviction discarded, when it committed outside a transaction. */
  dropped: EvictionHistory | null;
}

/**
 * The key a store Reed builds keeps its tap under. The property is
 * enumerable, so a wrapper made by spreading the store (`{ ...store }`) keeps
 * the tap of the store it forwards to.
 */
export const EVICTION_TAP: unique symbol = Symbol("reed.evictionTap");

/** One store's view of the evictions awaited on it. */
export interface EvictionTap {
  /**
   * Note that the store reduced `action` from `from` to `to`. The store calls
   * this for every action it commits, before notifying anyone, and it costs
   * nothing unless an eviction is awaited. A matching eviction answers the
   * innermost caller still waiting for one.
   *
   * Inside a transaction a rollback can still undo the eviction, so a loss is
   * not reported yet. The function returned reports it, and the store calls
   * it once the outermost transaction commits, or drops it on a rollback.
   */
  record(
    action: DocumentAction,
    from: HistoryState,
    to: HistoryState,
    inTransaction: boolean,
  ): (() => void) | null;
}

interface TapInternals extends EvictionTap {
  /** Wait for `entry`'s eviction; the function returned stops waiting. */
  await(entry: AwaitedEviction): () => void;
}

// Taps this module made, so a foreign value under the key is ignored.
const taps = new WeakSet<object>();

/** A tap for a new store. */
export function createEvictionTap(): EvictionTap {
  // Dispatch is synchronous, so the evictions awaited on one store nest: a
  // listener one notifies can await another, which is then last.
  const awaiting: AwaitedEviction[] = [];
  const tap: TapInternals = {
    record(action, from, to, inTransaction) {
      if (awaiting.length === 0 || action.type !== "EVICT_CHUNKS") return null;
      for (let i = awaiting.length - 1; i >= 0; i--) {
        const entry = awaiting[i]!;
        if (entry.committed || !sameEviction(entry.action, action)) continue;
        entry.committed = true;
        if (to === from) return null;
        const dropped: EvictionHistory = { from, to };
        if (!inTransaction) {
          entry.dropped = dropped;
          return null;
        }
        return () => entry.onDropped(dropped);
      }
      return null;
    },
    await(entry) {
      awaiting.push(entry);
      return () => {
        awaiting.splice(awaiting.lastIndexOf(entry), 1);
      };
    },
  };
  taps.add(tap);
  return tap;
}

/** Put `tap` on `store`, where `dispatchEviction` and spread copies find it. */
export function attachEvictionTap<S extends object>(store: S, tap: EvictionTap): S {
  Object.defineProperty(store, EVICTION_TAP, {
    value: tap,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return store;
}

/** The tap `store` carries, when a store Reed built put it there. */
export function evictionTapOf(store: object): EvictionTap | undefined {
  const tap = (store as { [EVICTION_TAP]?: unknown })[EVICTION_TAP];
  return typeof tap === "object" && tap !== null && taps.has(tap)
    ? (tap as EvictionTap)
    : undefined;
}

/**
 * True when `a` and `b` ask for the same eviction. A dispatch wrapper may pass
 * on a copy of the action, so they are compared by content.
 */
function sameEviction(a: EvictChunksAction, b: EvictChunksAction): boolean {
  if (a === b) return true;
  if (a.maxLoaded !== b.maxLoaded || (a.keepHistory === true) !== (b.keepHistory === true)) {
    return false;
  }
  const ai = a.chunkIndices;
  const bi = b.chunkIndices;
  if (ai.length !== bi.length) return false;
  for (let i = 0; i < ai.length; i++) if (ai[i] !== bi[i]) return false;
  return true;
}

/**
 * Dispatch `action` to `store`, whose state is `before`, and call `onDropped`
 * with the history the action itself reduced from and left if it discarded
 * any, without counting whatever a listener it notified dispatched.
 *
 * A store carrying a tap reports the eviction it committed, even when a
 * dispatch wrapper copied the action or dispatched something first. Inside
 * one of its transactions, `onDropped` waits for the outermost commit, and a
 * rollback cancels it.
 *
 * Without a tap, or when the store committed no matching eviction (a wrapper
 * rewrote it), history the store still holds afterwards means nothing
 * discarded any: every change to history makes a new object. Otherwise the
 * reducer, being pure, reduces `action` on `before` again to measure the
 * loss. That repeats the eviction's work, so a caller with nobody to tell
 * should dispatch the action directly instead.
 */
export function dispatchEviction(
  store: DocumentStore,
  before: DocumentState,
  action: EvictChunksAction,
  onDropped: (history: EvictionHistory) => void,
): void {
  const tap = evictionTapOf(store) as TapInternals | undefined;
  const entry: AwaitedEviction = { action, onDropped, committed: false, dropped: null };
  const stop = tap?.await(entry);
  try {
    store.dispatch(action);
  } finally {
    stop?.();
  }
  if (entry.committed) {
    if (entry.dropped !== null) onDropped(entry.dropped);
    return;
  }
  if (store.getSnapshot().history === before.history) return;
  const to = documentReducer(before, action).history;
  if (to !== before.history) onDropped({ from: before.history, to });
}
