/**
 * The reducer's own transition for an action dispatched to a store.
 *
 * A store listener that an action notifies can dispatch again, so the store's
 * state after `dispatch` returns need not be the action's. Internal callers
 * that must know what the action alone did, such as ChunkManager reporting the
 * history an eviction discarded, read it here instead of working it out from
 * how often listeners were notified.
 */

import type { DocumentState, HistoryState } from "../../types/state.js";
import type { DocumentAction } from "../../types/actions.js";
import type { DocumentStore } from "../../types/store.js";
import type { DocumentTransition } from "./reducer.js";
import { documentReducer } from "./reducer.js";

type Commit = (action: DocumentAction) => DocumentTransition;

// Only the stores Reed builds are registered. The map is private, so `commit`
// stays off the public store interface.
const commits = new WeakMap<DocumentStore, Commit>();

/**
 * Record that `commit` applies an action to `store` as its `dispatch` does,
 * notifying listeners and emitting events alike, and returns the reducer's
 * transition for it.
 */
export function registerCommit(store: DocumentStore, commit: Commit): void {
  commits.set(store, commit);
}

/**
 * Dispatch `action` to `store`, whose state is `before`, and return the
 * history the action itself left, without whatever a listener it notified
 * dispatched.
 *
 * A store Reed built reports the action's transition directly. For any other
 * store, history the store still holds afterwards is the one the action left:
 * every change to history makes a new object, so neither the action nor a
 * listener changed it. Otherwise the reducer, being pure, reduces `action` on
 * `before` again.
 */
export function dispatchForOwnHistory(
  store: DocumentStore,
  before: DocumentState,
  action: DocumentAction,
): HistoryState {
  const commit = commits.get(store);
  if (commit !== undefined) return commit(action).state.history;
  store.dispatch(action);
  const { history } = store.getSnapshot();
  return history === before.history ? history : documentReducer(before, action).history;
}
