# Code Analysis: Transaction and Batch Implementations

**Date:** 2026-03-01
**Scope:** Transaction management, batch dispatch, and their integration with the store and event system

---

## 1. Code Organization and Structure

The transaction and batch systems are composed across four distinct layers:

| Layer | Files | Responsibility |
|---|---|---|
| **Action types** | `src/types/actions.ts` | `TransactionStartAction`, `TransactionCommitAction`, `TransactionRollbackAction`; type guard `isTransactionAction`; `validateAction` for all action types |
| **Action creators** | `src/store/features/actions.ts` | `DocumentActions.transactionStart/Commit/Rollback()`, `serializeAction`, `deserializeAction` |
| **Transaction manager** | `src/store/features/transaction.ts` | `TransactionManager` interface, `createTransactionManager` factory — depth tracking, snapshot stack, pending actions, `emergencyReset` |
| **Store integration** | `src/store/features/store.ts` | `dispatch` (intercepts transaction actions), `batch` in both `createDocumentStore` and `createDocumentStoreWithEvents` |

The reducer (`src/store/features/reducer.ts`) treats all three transaction action types as no-ops — they return `state` unchanged. All transaction coordination is entirely in the store layer, not in the reducer.

---

## 2. Relations of Implementations — Types & Interfaces

```
DocumentAction (union)
  ├─ TransactionStartAction    { type: 'TRANSACTION_START' }
  ├─ TransactionCommitAction   { type: 'TRANSACTION_COMMIT' }
  └─ TransactionRollbackAction { type: 'TRANSACTION_ROLLBACK' }

TransactionResult {
  isOutermost: boolean          // true when outermost transaction completes
  snapshot: DocumentState | null  // non-null only on rollback, holds pre-begin state
  pendingActions: readonly DocumentAction[]  // non-empty only on outermost commit
}

TransactionManager {
  begin(currentState): void
  commit(): TransactionResult
  rollback(): TransactionResult
  trackAction(action): void
  readonly depth: number
  readonly isActive: boolean
  readonly pendingActions: readonly DocumentAction[]
  emergencyReset(): DocumentState | null
}
```

`TransactionResult` is used differently by commit vs. rollback:
- **commit**: `snapshot` is always `null`; `pendingActions` is populated only at outermost level
- **rollback**: `snapshot` holds the pre-transaction state; `pendingActions` is always `[]`

`DocumentStore.batch` is defined on the base interface. `ReconcilableDocumentStore` inherits it unchanged. `DocumentStoreWithEvents` overrides `batch` to emit per-action events with intermediate states.

---

## 3. Relations of Implementations — Functions

**`batch` (base store) call graph:**
```
createDocumentStore.batch(actions)
  → dispatch({ type: 'TRANSACTION_START' })
      → transaction.begin(state)
  → for each action:
      dispatch(action)
        → documentReducer(state, action)     // mutates state
        → transaction.trackAction(action)
        // listeners NOT notified (transaction.isActive)
  → dispatch({ type: 'TRANSACTION_COMMIT' })
      → transaction.commit()
        → returns { isOutermost: true, pendingActions: [...] }
      → notifyListeners()                    // single notification
      → if rebuildPending: scheduleReconciliation()
  // on exception:
  → dispatch({ type: 'TRANSACTION_ROLLBACK' })
      → transaction.rollback()
        → returns { snapshot, isOutermost: true }
      → setState(snapshot)
      → notifyListeners()
  // if rollback itself throws:
  → transaction.emergencyReset()
      → setState(earliest snapshot)
      → notifyListeners()
```

**`batch` (events store) call graph:**
```
createDocumentStoreWithEvents.batch(actions)
  → baseStore.dispatch({ type: 'TRANSACTION_START' })
  → for each action:
      dispatch(action)                       // ENHANCED dispatch
        → baseStore.dispatch(action)         // mutates state
        → emitEventsForAction(prevState, nextState)  // events fire per-action
  → baseStore.dispatch({ type: 'TRANSACTION_COMMIT' })
      → notifyListeners()  (single)
      → if rebuildPending: scheduleReconciliation()
  // on exception:
  → baseStore.dispatch({ type: 'TRANSACTION_ROLLBACK' })
      // NO emergencyReset fallback
```

**Manual transaction protocol (via `dispatch`):**
```
dispatch(TRANSACTION_START)  → transaction.begin(state)
dispatch(any action)         → reducer runs; trackAction; no listener notify
dispatch(TRANSACTION_COMMIT) → transaction.commit(); notifyListeners once
dispatch(TRANSACTION_ROLLBACK) → transaction.rollback(); setState(snapshot); notifyListeners
```

---

## 4. Specific Contexts and Usages

**Notification batching:** The primary purpose of `batch` / transactions is collapsing N dispatch-notifications into one. Each action still runs through the reducer independently and produces its own history entry.

**History behavior:** `batch` does NOT create a single compound history entry. Three inserts batched together create three separate undo entries (as confirmed by the test at `store.usecase.test.ts:285`). This is intentional and documented, but may surprise callers expecting Redux-style batching.

**Nested transactions:** `TRANSACTION_START` is nestable. Inner commits are silent (no notification). Inner rollbacks restore only the inner snapshot. Only the outermost commit/rollback notifies listeners. This allows library code to wrap operations in a transaction without worrying about nesting with caller-provided transactions.

**Reconciliation scheduling:** `scheduleReconciliation` is called on outermost commit (both in `batch` and in `TRANSACTION_COMMIT` dispatch) when `rebuildPending` is true. Inside an active transaction, `scheduleReconciliation` is intentionally skipped — dirty line ranges accumulate and are scheduled only once at the boundary.

**`emergencyReset`:** Called only in `createDocumentStore.batch` when a `TRANSACTION_ROLLBACK` dispatch itself throws (extremely rare). It returns the earliest (outermost) snapshot from the stack, clearing all internal transaction state. The events-store `batch` does not implement this fallback.

**`pendingActions` accumulation:** `trackAction` accumulates all actions dispatched inside any transaction level into a single flat array. The array is exposed on `TransactionResult.pendingActions` at outermost commit but is **not currently used** by any caller — neither `batch` nor the store reads the returned `pendingActions`. It is available for external consumers who construct transactions manually and want to replay or audit the action log.

---

## 5. Pitfalls

**P1 — `pendingActions` on `TransactionResult` are accumulated and returned but never consumed internally.**

`batch` ignores `result.pendingActions` entirely. `dispatch(TRANSACTION_COMMIT)` returns `state`, not `result`. This data is silently discarded in all code paths. Any external caller relying on `result.pendingActions` must obtain it by manually calling `transaction.commit()` — but the `TransactionManager` is not public API.
(`src/store/features/transaction.ts:84–86`, `src/store/features/store.ts:127–135`)

**P2 — `createDocumentStoreWithEvents.batch` has no `emergencyReset` fallback when rollback fails.**

The base `batch` catches rollback exceptions and calls `transaction.emergencyReset()`. The events-aware `batch` has a simpler `finally` block that only calls `baseStore.dispatch(TRANSACTION_ROLLBACK)` with no fallback:

```ts
// events store batch (store.ts:451-454):
finally {
  if (!success) {
    baseStore.dispatch({ type: 'TRANSACTION_ROLLBACK' });
  }
}
```

If this `TRANSACTION_ROLLBACK` dispatch throws, the transaction depth counter in `TransactionManager` will be left non-zero, permanently locking all future dispatches in "transaction active" mode (listeners never notified again).
(`src/store/features/store.ts:451–455`)

**P3 — Inner rollback only restores the snapshot passed to the matching `begin`, not the outermost state.**

```ts
// Outer begin with stateA
dispatch(TRANSACTION_START)   // begin(stateA), depth=1
dispatch(INSERT 'X')          // state now stateA+X
// Inner begin with stateA+X
dispatch(TRANSACTION_START)   // begin(stateA+X), depth=2
dispatch(INSERT 'Y')          // state now stateA+X+Y
dispatch(TRANSACTION_ROLLBACK) // rollback → restores stateA+X, depth=1
// stateA+X remains — inner rollback does NOT undo outer changes
dispatch(TRANSACTION_COMMIT)   // commits stateA+X, notifies
```

This is correct semantically but is a common source of confusion: inner rollback does not provide full abort semantics unless the outer transaction also rolls back.

**P4 — `begin` only clears `pending` when `depth === 0`, meaning re-entrant use after a completed transaction leaks no state — but trackAction outside a transaction appends to an empty `pending` array silently.**

`trackAction` does not check `depth > 0` before pushing:
```ts
function trackAction(action: DocumentAction): void {
  pending.push(action);  // no guard
}
```
Calling `trackAction` outside a transaction silently accumulates actions in `pending`, which gets cleared on the next `begin`. This is harmless in the current store (the store only calls `trackAction` inside `transaction.isActive`), but the `TransactionManager` interface provides no protection.
(`src/store/features/transaction.ts:112–114`)

**P5 — `batch` in the base store calls `dispatch(TRANSACTION_ROLLBACK)` on error, which also calls `notifyListeners()`.**

On rollback, listeners are notified with the restored (pre-transaction) state. If the document content was unchanged, this is a spurious notification — listeners cannot distinguish "state changed" from "state was rolled back to what it already was." There is no `stateChanged` flag or diffing before `notifyListeners` in the rollback path.
(`src/store/features/store.ts:138–144`)

**P6 — `snapshotStack` in `TransactionManager` stores full `DocumentState` references per nesting level.**

For deeply nested transactions with large documents, the snapshot stack can hold many references to immutable-but-still-referenced state trees. Structural sharing in the piece table limits memory impact, but the line index and history stacks are duplicated across snapshots per nesting level.

---

## 6. Improvement Points — Design Overview

**D1: `batch` and manual `TRANSACTION_START/COMMIT/ROLLBACK` dispatch provide two separate APIs for the same mechanism, with different guarantees.**

`batch` is safe (event emission, reconciliation scheduling, emergency reset). Manual dispatch is lower-level and requires callers to remember to commit/rollback, handle errors, and track reconciliation. There is no API contract preventing misuse of the manual transaction API from external code. A higher-level `withTransaction(fn)` helper would consolidate these paths.

**D2: The events-aware `batch` deviates from the base `batch` in resilience.**

The two `batch` implementations have different error-handling strategies. The base store recovers from rollback failure via `emergencyReset`; the events store does not. This asymmetry is not documented and can be surprising when upgrading from base store to events store.

**D3: `pendingActions` is a `TransactionManager` feature with no current consumer.**

The field is accumulated, exposed on the interface, and returned in `TransactionResult`, but discarded by all callers. It adds complexity and memory overhead without providing value. Either it should be consumed (e.g., for audit logging or replay) or removed from the public interface.

**D4: Notification suppression during transactions is implicit, not explicit.**

The `notifyListeners` guard (`if (transaction.isActive) return`) is buried inside `dispatch` without a named concept. The contract "notifications are deferred during transactions" is enforced by control flow, not by a documented invariant on `DocumentStore`. This makes it harder to reason about listener call counts in complex workflows.

---

## 7. Improvement Points — Types & Interfaces

**T1: `TransactionResult` carries three fields, but commit and rollback never use all three simultaneously.**

- Commit: `isOutermost` + `pendingActions` (snapshot always `null`)
- Rollback: `isOutermost` + `snapshot` (pendingActions always `[]`)

A discriminated union would be more precise:
```ts
type CommitResult   = { isOutermost: boolean; pendingActions: readonly DocumentAction[] };
type RollbackResult = { isOutermost: boolean; snapshot: DocumentState | null };
```
The current flat shape requires callers to know which fields are meaningful based on which method was called.

**T2: `TransactionManager.pendingActions` is a `readonly DocumentAction[]` getter, but its elements are mutable actions.**

Actions created by `DocumentActions.*` are `Object.freeze`d, so in practice they are immutable. However, the type does not express this — `readonly DocumentAction[]` only prevents reassignment of the array reference, not mutation of individual elements. Using `ReadonlyArray<Readonly<DocumentAction>>` would be more precise.

**T3: `DocumentStore.batch` is typed as accepting `DocumentAction[]` (mutable array) rather than `readonly DocumentAction[]`.**

Callers with a `readonly` array must cast. Widening the parameter to `readonly DocumentAction[]` would be a backwards-compatible improvement.
(`src/types/store.ts:75`)

---

## 8. Improvement Points — Implementations

**Impl1: `createDocumentStore.batch` has a subtle double-scheduling opportunity.**

After the `finally` block, `batch` checks `state.lineIndex.rebuildPending` and calls `scheduleReconciliation()` again:
```ts
// store.ts:213-215
if (!transaction.isActive && state.lineIndex.rebuildPending) {
  scheduleReconciliation();
}
```
This runs even when `TRANSACTION_COMMIT` already called `scheduleReconciliation()` inside `dispatch`. Since `scheduleReconciliation` is idempotent (early-return when `idleCallbackId !== null`), this is harmless, but it's redundant and adds noise.

**Impl2: `createDocumentStoreWithEvents.batch` does not pass `success = true` within a `try/finally` — it uses a try/finally with a separate flag, matching the base store, but the `TRANSACTION_COMMIT` is placed inside the `try` block.**

If `TRANSACTION_COMMIT` dispatch throws (e.g., a listener throws), `success` remains `false` and the `finally` block attempts `TRANSACTION_ROLLBACK`. But the commit may have already partially applied (state updated, depth decremented), making the rollback inconsistent. The base store has the same issue.

**Impl3: `transaction.rollback()` pops `snapshotStack` before decrementing `depth`.**

```ts
const snapshot = snapshotStack.pop() ?? null;
depth--;
```
This is correct for single-level rollback. But in a scenario where `snapshotStack` and `depth` drift out of sync (e.g., if `begin` is called without a paired `commit`/`rollback`), the `depth--` could reach zero while `snapshotStack` still has entries — leaving orphaned snapshots. The current code has no assertion to detect this.

**Impl4: `emergencyReset` returns `snapshotStack[0]` (the earliest/outermost snapshot) but the store uses it as the recovery state.**

The outermost snapshot represents the state at the moment the outermost `TRANSACTION_START` was processed. If multiple actions were applied before the outermost `begin`, this snapshot is accurate. However, any state changes that occurred *between* the outer `begin` and the failure are correctly discarded — this is the intended behavior. The naming `emergencyReset` adequately signals the exceptional nature of this path.

**Impl5: `serializeAction` / `deserializeAction` in `actions.ts` handle `LOAD_CHUNK` specially (base64 for `Uint8Array`) but do not handle transaction actions at all.**

Transaction actions (`TRANSACTION_START`, `TRANSACTION_COMMIT`, `TRANSACTION_ROLLBACK`) are no-payload actions and serialize/deserialize correctly via the default `JSON.stringify` path. However, there is no round-trip test that verifies this explicitly, and `deserializeAction` will throw on any unknown `type` — a risk if serialized action logs are replayed against a future version that renames an action type.

---

## 9. Learning Paths

**Path 1 — Core transaction state machine**
1. `src/types/actions.ts:96–119` — `TransactionStartAction`, `TransactionCommitAction`, `TransactionRollbackAction`
2. `src/store/features/transaction.ts` — `TransactionManager`, `createTransactionManager`, depth/snapshot/pending mechanics
3. `src/store/features/transaction.test.ts` — full test suite covering lifecycle, nesting, pending actions, emergency reset
4. **Goal:** understand depth tracking, snapshot stack, and the `isOutermost` flag semantics

**Path 2 — Store integration and notification suppression**
1. `src/store/features/store.ts:120–168` — `dispatch` function, transaction intercept branches
2. `src/store/features/store.ts:178–218` — `batch` in base store (transaction wrapping, rollback, emergency reset)
3. `src/store/features/store.usecase.test.ts:273–403` — integration tests for transactions and batching
4. **Goal:** understand how notifications are suppressed during transactions and how `batch` differs from manual `dispatch` sequences

**Path 3 — Events-aware batch divergence**
1. `src/store/features/store.ts:366–479` — `createDocumentStoreWithEvents`, enhanced `dispatch`, events-aware `batch`
2. `src/store/features/events.test.ts:328–355` — batch intermediate-state event test
3. **Goal:** understand why the events-aware `batch` emits per-action events with intermediate states, and how it differs from the base store's batch in error handling

**Path 4 — Reconciliation interaction with transactions**
1. `src/store/features/store.ts:131–133` — reconciliation scheduling on outermost commit
2. `src/store/features/store.ts:212–215` — post-batch reconciliation guard
3. `src/store/features/store.usecase.test.ts:352–383` — test: reconciliation scheduled only after outermost commit
4. **Goal:** understand why dirty line ranges are not reconciled mid-transaction and where scheduling occurs

**Path 5 — Action serialization and type guards**
1. `src/types/actions.ts:199–236` — `isTextEditAction`, `isHistoryAction`, `isTransactionAction`
2. `src/types/actions.ts:242–287` — `isDocumentAction` runtime validator
3. `src/store/features/actions.ts:141–170` — `serializeAction`, `deserializeAction`
4. **Goal:** understand the full action type system and the validation/serialization boundary for external action sources
