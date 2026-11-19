/**
 * The history an EVICT_CHUNKS action itself left, for the caller that
 * dispatched it.
 *
 * A store listener that an action notifies can dispatch again, so the store's
 * state after `dispatch` returns need not be the action's. ChunkManager, which
 * reports the history an eviction discarded, asks the reducer for the
 * eviction's own result here. The report is keyed by the action object the
 * caller built, which a dispatch wrapper passes on as it is, so the action
 * still goes through `store.dispatch` and whatever wraps it.
 */

import type { DocumentState, HistoryState } from "../../types/state.js";
import type { EvictChunksAction } from "../../types/actions.js";
import type { DocumentStore } from "../../types/store.js";
import { documentReducer } from "./reducer.js";

interface EvictionReport {
  readonly from: DocumentState;
  readonly history: HistoryState;
}

// Only the actions a caller is waiting on are recorded, so an action someone
// else keeps, such as an action log, holds no document state.
const awaited = new WeakMap<EvictChunksAction, EvictionReport | null>();

/**
 * Record that EVICT_CHUNKS reduced `action` from `from` and left `history`,
 * when a caller is waiting on that action. The reducer calls this.
 */
export function recordEviction(
  action: EvictChunksAction,
  from: DocumentState,
  history: HistoryState,
): void {
  if (awaited.has(action)) awaited.set(action, { from, history });
}

/**
 * Dispatch `action` to `store`, whose state is `before`, and return the
 * history the action itself left, without whatever a listener it notified
 * dispatched.
 *
 * Usually the reducer reports it, having reduced `action` from `before`. When
 * it did not, because a dispatch wrapper passed on a copy or dispatched
 * something first, history the store still holds afterwards is the one the
 * action left: every change to history makes a new object, so neither the
 * action nor a listener changed it. Otherwise the reducer, being pure,
 * reduces `action` on `before` again.
 */
export function dispatchEviction(
  store: DocumentStore,
  before: DocumentState,
  action: EvictChunksAction,
): HistoryState {
  awaited.set(action, null);
  let report: EvictionReport | null | undefined;
  try {
    store.dispatch(action);
    report = awaited.get(action);
  } finally {
    awaited.delete(action);
  }
  if (report?.from === before) return report.history;
  const { history } = store.getSnapshot();
  return history === before.history ? history : documentReducer(before, action).history;
}
