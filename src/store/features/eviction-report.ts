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
 * While a caller awaits an eviction, the first EVICT_CHUNKS that a store Reed
 * built commits into the caller's store claims it. The store calls
 * `claimEviction` as it commits, with the history the reducer read and the
 * state it produced, so the reducer stays pure. That commit belongs to the
 * caller's store when the caller's `getSnapshot()` returns the state it just
 * produced. That holds however the store is wrapped, as long as the wrapper
 * reads the state from the store it forwards to. A mirror that a wrapper also
 * dispatches to has a state of its own, so its commit claims nothing. A copy
 * or rewrite of the action is claimed too, since it is the eviction that ran.
 *
 * A store Reed did not build claims nothing, so nothing is reported for it.
 */

import type { DocumentState, HistoryState } from "../../types/state.js";
import type { DocumentAction, EvictChunksAction } from "../../types/actions.js";
import type { DocumentStore } from "../../types/store.js";

/** The history an eviction reduced from, and the history it left. */
export interface EvictionHistory {
  readonly from: HistoryState;
  readonly to: HistoryState;
}

interface AwaitedEviction {
  readonly store: Pick<DocumentStore, "getSnapshot">;
  readonly onDropped: (history: EvictionHistory) => void;
  claimed: boolean;
}

// Dispatch is synchronous, so awaited evictions nest, even across stores: a
// listener that one notifies can await another, which is then last.
const awaiting: AwaitedEviction[] = [];

/**
 * Note that a store committed `action`, reducing history `from` to the state
 * `next`, which the store already holds. The store calls this for every
 * action it commits, before it notifies anyone, and it costs nothing unless
 * an eviction is awaited.
 *
 * Returns the report for the caller that the commit answers when the eviction
 * discarded history, or null. The store runs it once the change is final: at
 * once outside a transaction, otherwise when the outermost transaction
 * commits. A rollback drops it.
 */
export function claimEviction(
  action: DocumentAction,
  from: HistoryState,
  next: DocumentState,
): (() => void) | null {
  if (awaiting.length === 0 || action.type !== "EVICT_CHUNKS") return null;
  for (let i = awaiting.length - 1; i >= 0; i--) {
    const entry = awaiting[i]!;
    if (entry.claimed || !holds(entry.store, next)) continue;
    entry.claimed = true;
    const to = next.history;
    if (to === from) return null;
    return () => entry.onDropped({ from, to });
  }
  return null;
}

/** True when `store` reads `state` as its current state. */
function holds(store: Pick<DocumentStore, "getSnapshot">, state: DocumentState): boolean {
  try {
    return store.getSnapshot() === state;
  } catch {
    // A wrapper's getSnapshot that throws mid-commit cannot claim the
    // eviction, and must not break the store's commit.
    return false;
  }
}

/**
 * Dispatch `action` to `store`, and call `onDropped` with the history the
 * eviction itself reduced from and left if it discarded any, without counting
 * whatever a dispatch wrapper or a notified listener dispatched besides.
 *
 * The store reports the loss in commit order, before it notifies listeners.
 * Inside one of its transactions the report waits for the outermost commit,
 * and a rollback cancels it.
 */
export function dispatchEviction(
  store: DocumentStore,
  action: EvictChunksAction,
  onDropped: (history: EvictionHistory) => void,
): void {
  const entry: AwaitedEviction = { store, onDropped, claimed: false };
  awaiting.push(entry);
  try {
    store.dispatch(action);
  } finally {
    awaiting.splice(awaiting.lastIndexOf(entry), 1);
  }
}
