/**
 * The history an EVICT_CHUNKS action itself changed, for the caller that
 * dispatched it.
 *
 * A store listener that an action notifies can dispatch again, so the store's
 * state after `dispatch` returns need not be the action's. ChunkManager, which
 * reports the history an eviction discarded, still sends the eviction through
 * `store.dispatch`, so whatever wraps it sees the action. The store Reed
 * builds reports each eviction it commits while one is awaited (see
 * `recordCommit`), so the reducer stays pure.
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
  readonly action: EvictChunksAction;
  report: EvictionHistory | null;
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
 * unless an eviction is awaited. The first matching eviction committed answers
 * the innermost caller still waiting on one like it.
 */
export function recordCommit(action: DocumentAction, from: DocumentState, to: DocumentState): void {
  if (awaiting.length === 0 || action.type !== "EVICT_CHUNKS") return;
  for (let i = awaiting.length - 1; i >= 0; i--) {
    const entry = awaiting[i]!;
    if (entry.report === null && sameEviction(entry.action, action)) {
      entry.report = { from: from.history, to: to.history };
      return;
    }
  }
}

/**
 * Dispatch `action` to `store`, whose state is `before`, and return the
 * history the action itself reduced from and left, without whatever a
 * listener it notified dispatched.
 *
 * A store Reed built reports the eviction it committed, even when a dispatch
 * wrapper copied the action or dispatched something first. For any other
 * store this is the net change from `before` to the store's history after
 * `dispatch`, which is the eviction's own unless a listener changed history
 * too: every change to history makes a new object.
 */
export function dispatchEviction(
  store: DocumentStore,
  before: DocumentState,
  action: EvictChunksAction,
): EvictionHistory {
  const entry: AwaitedEviction = { action, report: null };
  awaiting.push(entry);
  try {
    store.dispatch(action);
  } finally {
    awaiting.splice(awaiting.lastIndexOf(entry), 1);
  }
  return entry.report ?? { from: before.history, to: store.getSnapshot().history };
}
