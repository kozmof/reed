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
 * A store Reed builds reports each action it commits while an eviction is
 * awaited (see `recordCommit`), so the reducer stays pure. Only commits on the
 * awaiting store's own line of history count: the first starts from the
 * history the caller read, and each later one from the history the one before
 * left. Another store, such as a mirror a wrapper also dispatches to, starts
 * from history of its own, so its commits are ignored.
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
  /** The history the awaiting store's latest commit left. */
  head: HistoryState;
  /** Whether the awaiting store committed the eviction. */
  committed: boolean;
  /** What the eviction discarded, when it committed outside a transaction. */
  dropped: EvictionHistory | null;
}

// Dispatch is synchronous, so the evictions being awaited nest: a listener
// one notifies can await another, which is then last.
const awaiting: AwaitedEviction[] = [];

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
 * Note that a store reduced `action` from `from` to `to`. The store calls this
 * for every action it commits, before notifying anyone, and it costs nothing
 * unless an eviction is awaited. A matching eviction answers the innermost
 * caller whose store's history it continues.
 *
 * Inside a transaction a rollback can still undo the eviction, so a loss is
 * not reported yet. The function returned reports it, and the store calls it
 * once the outermost transaction commits, or drops it on a rollback.
 */
export function recordCommit(
  action: DocumentAction,
  from: DocumentState,
  to: DocumentState,
  inTransaction: boolean,
): (() => void) | null {
  let deferred: (() => void) | null = null;
  let answered = false;
  for (let i = awaiting.length - 1; i >= 0; i--) {
    const entry = awaiting[i]!;
    if (entry.committed || from.history !== entry.head) continue;
    entry.head = to.history;
    if (answered || action.type !== "EVICT_CHUNKS" || !sameEviction(entry.action, action)) {
      continue;
    }
    answered = true;
    entry.committed = true;
    if (to.history === from.history) continue;
    const dropped: EvictionHistory = { from: from.history, to: to.history };
    if (!inTransaction) entry.dropped = dropped;
    else deferred = () => entry.onDropped(dropped);
  }
  return deferred;
}

/**
 * Dispatch `action` to `store`, whose state is `before`, and call `onDropped`
 * with the history the action itself reduced from and left if it discarded
 * any, without counting whatever a listener it notified dispatched.
 *
 * A store Reed built reports the eviction it committed, even when a dispatch
 * wrapper copied the action or dispatched something first. Inside one of its
 * transactions, `onDropped` waits for the outermost commit, and a rollback
 * cancels it. For any other store, or when the store committed no matching
 * eviction, history the store still holds afterwards means nothing discarded
 * any: every change to history makes a new object. Otherwise the reducer,
 * being pure, reduces `action` on `before` again.
 */
export function dispatchEviction(
  store: DocumentStore,
  before: DocumentState,
  action: EvictChunksAction,
  onDropped: (history: EvictionHistory) => void,
): void {
  const entry: AwaitedEviction = {
    action,
    onDropped,
    head: before.history,
    committed: false,
    dropped: null,
  };
  awaiting.push(entry);
  try {
    store.dispatch(action);
  } finally {
    awaiting.splice(awaiting.lastIndexOf(entry), 1);
  }
  if (entry.committed) {
    if (entry.dropped !== null) onDropped(entry.dropped);
    return;
  }
  if (store.getSnapshot().history === before.history) return;
  const to = documentReducer(before, action).history;
  if (to !== before.history) onDropped({ from: before.history, to });
}
