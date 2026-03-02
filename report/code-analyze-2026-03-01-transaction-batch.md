# Code Analysis: Transaction and Batch Implementations

**Date:** 2026-03-01
**Updated:** 2026-03-02 — 14 issues resolved (P1, P2/D2, P4, P5\*, T1, T3, Impl1, D1, D3, D4, Impl3, Impl5, Impl2, Impl4)
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

CommitResult {                         // returned by commit()
  kind: 'commit'
  isOutermost: boolean
  pendingActions: readonly DocumentAction[]
}

RollbackResult {                       // returned by rollback()
  kind: 'rollback'
  isOutermost: boolean
  snapshot: DocumentState | null
}

TransactionResult = CommitResult | RollbackResult   // discriminated union

TransactionManager {
  begin(currentState): void
  commit(): CommitResult
  rollback(): RollbackResult
  trackAction(action): void       // no-op when depth === 0
  readonly depth: number
  readonly isActive: boolean
  readonly pendingActions: readonly DocumentAction[]
  emergencyReset(): DocumentState | null
}
```

`DocumentStore.batch` is defined on the base interface accepting `readonly DocumentAction[]`. `ReconcilableDocumentStore` inherits it unchanged and additionally exposes `emergencyReset()`. `DocumentStoreWithEvents` overrides `batch` to emit per-action events with intermediate states.

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
        → returns { kind: 'commit', isOutermost: true, pendingActions: [...] }
      → notifyListeners()                    // single notification
      → if rebuildPending: scheduleReconciliation()
  // on exception:
  → dispatch({ type: 'TRANSACTION_ROLLBACK' })
      → transaction.rollback()
        → returns { kind: 'rollback', snapshot, isOutermost: true }
      → setState(snapshot)
      → notifyListeners()                    // only on isOutermost
  // if rollback itself throws:
  → emergencyReset()
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
  → try: baseStore.dispatch({ type: 'TRANSACTION_ROLLBACK' })
  // if rollback dispatch throws:
  → baseStore.emergencyReset()              // parity with base store
```

**Manual transaction protocol (via `dispatch`):**
```
dispatch(TRANSACTION_START)    → transaction.begin(state)
dispatch(any action)           → reducer runs; trackAction; no listener notify
dispatch(TRANSACTION_COMMIT)   → transaction.commit(); notifyListeners once (outermost)
dispatch(TRANSACTION_ROLLBACK) → transaction.rollback(); setState(snapshot);
                                  notifyListeners only when isOutermost
```

---

## 4. Specific Contexts and Usages

**Notification batching:** The primary purpose of `batch` / transactions is collapsing N dispatch-notifications into one. Each action still runs through the reducer independently and produces its own history entry.

**History behavior:** `batch` does NOT create a single compound history entry. Three inserts batched together create three separate undo entries (as confirmed by the test at `store.usecase.test.ts:285`). This is intentional and documented, but may surprise callers expecting Redux-style batching.

**Nested transactions:** `TRANSACTION_START` is nestable. Inner commits and inner rollbacks are silent (no notification). Only the outermost commit/rollback notifies listeners. This allows library code to wrap operations in a transaction without worrying about nesting with caller-provided transactions.

**Reconciliation scheduling:** `scheduleReconciliation` is called on outermost commit (inside `TRANSACTION_COMMIT` dispatch) when `rebuildPending` is true. Inside an active transaction, `scheduleReconciliation` is intentionally skipped — dirty line ranges accumulate and are scheduled only once at the boundary.

**`emergencyReset`:** Exposed on `ReconcilableDocumentStore` and `DocumentStoreWithEvents`. Called when a `TRANSACTION_ROLLBACK` dispatch itself throws (extremely rare). Invokes `transaction.emergencyReset()` to clear all transaction state, restores the earliest (outermost) snapshot, and notifies listeners. Both `batch` implementations now call this fallback with equal resilience.

**`pendingActions` accumulation:** `trackAction` accumulates all actions dispatched inside an active transaction into a single flat array (calls at depth 0 are now silently ignored). The array is exposed on `CommitResult.pendingActions` at outermost commit but is **not currently used** by any caller — it is available for external consumers who construct transactions manually and want to replay or audit the action log.

---

## 5. Pitfalls

**~~P1~~ — ~~`pendingActions` on `CommitResult` are accumulated and returned but never consumed internally.~~**
**Fixed (2026-03-02)** as part of D3. See D3 below.

**~~P2~~ — ~~`createDocumentStoreWithEvents.batch` has no `emergencyReset` fallback when rollback fails.~~**
**Fixed (2026-03-02).** Events store `batch` now wraps the rollback dispatch in a nested try/catch and calls `baseStore.emergencyReset()` on failure, matching the resilience of the base store. `emergencyReset` is exposed on `ReconcilableDocumentStore` and passed through on the events store return object.

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

**~~P4~~ — ~~`trackAction` outside a transaction silently accumulates actions in `pending`.~~**
**Fixed (2026-03-02).** `trackAction` now returns early when `depth === 0`. Calling it outside a transaction is a safe no-op.

**~~P5~~ — ~~`dispatch(TRANSACTION_ROLLBACK)` unconditionally calls `notifyListeners()`, including for inner rollbacks.~~**
**Fixed (2026-03-02).** `notifyListeners()` in the rollback path is now guarded by `result.isOutermost`. Inner rollbacks restore the snapshot but do not notify listeners, preserving the notification-suppression contract for the duration of the outer transaction.

*Note: the related concern — outermost rollback notifying when state is unchanged — is not addressed. Listeners still cannot distinguish "state changed" from "state was rolled back to what it already was."*

**P6 — `snapshotStack` in `TransactionManager` stores full `DocumentState` references per nesting level.**

For deeply nested transactions with large documents, the snapshot stack can hold many references to immutable-but-still-referenced state trees. Structural sharing in the piece table limits memory impact, but the line index and history stacks are duplicated across snapshots per nesting level.

---

## 6. Improvement Points — Design Overview

**~~D1~~ — ~~`batch` and manual `TRANSACTION_START/COMMIT/ROLLBACK` dispatch provide two separate APIs for the same mechanism, with different guarantees.~~**
**Fixed (2026-03-02).** `withTransaction<T>(store, fn)` is now exported from `src/store/features/store.ts` and `src/api/store.ts`. It wraps the callback in a transaction with the same error-handling resilience as `batch` (rollback → `emergencyReset` fallback) and returns the value produced by the callback. It nests correctly with existing transactions.

**~~D2~~ — ~~The events-aware `batch` deviates from the base `batch` in resilience.~~**
**Fixed (2026-03-02)** as part of P2. Both `batch` implementations now have equivalent error-handling with `emergencyReset` fallback.

**~~D3~~ — ~~`pendingActions` is a `TransactionManager` feature with no current consumer.~~**
**Fixed (2026-03-02).** `pending` array, `trackAction`, `pendingActions` getter, and `CommitResult.pendingActions` are all removed. The corresponding `transaction.trackAction(action)` call in `store.ts` `dispatch` is also removed. `CommitResult` now carries only `kind` and `isOutermost`. The `DocumentAction` import in `transaction.ts` is removed as it is no longer referenced.

**~~D4~~ — ~~Notification suppression during transactions is implicit, not explicit.~~**
**Fixed (2026-03-02).** The `dispatch` JSDoc now documents the notification contract explicitly: *"During an active transaction notifications are suppressed and delivered as a single call on outermost commit or outermost rollback."* The control-flow invariant is now expressed as a named guarantee rather than an implicit consequence of `transaction.isActive` checks.

---

## 7. Improvement Points — Types & Interfaces

**~~T1~~ — ~~`TransactionResult` carries three fields, but commit and rollback never use all three simultaneously.~~**
**Fixed (2026-03-02).** `TransactionResult` is now a discriminated union of `CommitResult` (`kind: 'commit'`, `isOutermost`, `pendingActions`) and `RollbackResult` (`kind: 'rollback'`, `isOutermost`, `snapshot`). `commit()` returns `CommitResult`; `rollback()` returns `RollbackResult`. The `kind` field enables exhaustive narrowing at call sites.

**T2: `TransactionManager.pendingActions` is a `readonly DocumentAction[]` getter, but its elements are mutable actions.**

Actions created by `DocumentActions.*` are `Object.freeze`d, so in practice they are immutable. However, the type does not express this — `readonly DocumentAction[]` only prevents reassignment of the array reference, not mutation of individual elements. Using `ReadonlyArray<Readonly<DocumentAction>>` would be more precise.

**~~T3~~ — ~~`DocumentStore.batch` is typed as accepting `DocumentAction[]` (mutable array) rather than `readonly DocumentAction[]`.~~**
**Fixed (2026-03-02).** `DocumentStore.batch` and both store implementations now accept `readonly DocumentAction[]`. Callers with a `readonly` array no longer need to cast.

---

## 8. Improvement Points — Implementations

**~~Impl1~~ — ~~`createDocumentStore.batch` has a subtle double-scheduling opportunity.~~**
**Fixed (2026-03-02).** The redundant `scheduleReconciliation` check after the `finally` block has been removed. Reconciliation is scheduled once inside `dispatch(TRANSACTION_COMMIT)` when `rebuildPending` is true; the post-batch repeat was dead code.

**~~Impl2~~ — ~~`TRANSACTION_COMMIT` is placed inside the `try` block, so a COMMIT-throw causes the `finally` block to attempt `TRANSACTION_ROLLBACK` on a half-committed transaction.~~**
**Fixed (2026-03-02).** In all three sites — `createDocumentStore.batch`, `createDocumentStoreWithEvents.batch`, and `withTransaction` — `success = true` is now set immediately before `dispatch({ type: 'TRANSACTION_COMMIT' })`. If `TRANSACTION_COMMIT` throws (e.g. `assertInvariant` detects a `depth`/`snapshotStack` drift), `success` is already `true` so the `finally` block skips the rollback attempt. The error propagates cleanly rather than triggering a no-op rollback on state with `depth` already decremented and the snapshot already popped.
(`src/store/features/store.ts`)

**~~Impl3~~ — ~~No assertion to detect `snapshotStack`/`depth` drift.~~**
**Fixed (2026-03-02).** `createTransactionManager` now has a private `assertInvariant(op)` helper that throws if `snapshotStack.length !== depth`. It is called at the end of `begin`, `commit`, and `rollback`. Any future bug that causes a begin/commit/rollback imbalance will surface immediately with a descriptive error rather than silently corrupting state.

**~~Impl4~~ — ~~`createDocumentStore.batch` duplicates the `emergencyReset()` logic inline rather than calling the store's own function.~~**
**Fixed (2026-03-02).** The three-line inline block in `createDocumentStore.batch`'s rollback-failure catch (`transaction.emergencyReset()` + `setState` + `notifyListeners()`) is replaced with a single `emergencyReset()` call. The base store's `batch` now mirrors the events store, which already called `baseStore.emergencyReset()`. Future changes to the emergency recovery path only need to be applied once.
(`src/store/features/store.ts`)

**~~Impl5~~ — ~~No round-trip test for transaction action serialization.~~**
**Fixed (2026-03-02).** A new dedicated test file `src/store/features/actions.test.ts` covers `serializeAction` / `deserializeAction` for all 12 action types, including all three transaction actions, plus `LOAD_CHUNK` Uint8Array preservation, unicode text, and error cases (unknown type, invalid JSON, missing fields). The tests confirm that transaction actions serialize to plain `{ type }` JSON objects and round-trip without data loss.

---

## 9. Learning Paths

**Path 1 — Core transaction state machine**
1. `src/types/actions.ts:96–119` — `TransactionStartAction`, `TransactionCommitAction`, `TransactionRollbackAction`
2. `src/store/features/transaction.ts` — `TransactionManager`, `CommitResult`, `RollbackResult`, `createTransactionManager`, depth/snapshot/pending mechanics
3. `src/store/features/transaction.test.ts` — full test suite covering lifecycle, nesting, pending actions, emergency reset, `kind` discriminant
4. **Goal:** understand depth tracking, snapshot stack, `isOutermost` flag semantics, and the discriminated result types

**Path 2 — Store integration and notification suppression**
1. `src/store/features/store.ts:120–175` — `dispatch` function (with notification contract JSDoc), transaction intercept branches
2. `src/store/features/store.ts:178–213` — `batch` in base store (transaction wrapping, rollback, emergency reset)
3. `src/store/features/store.ts` (`withTransaction`) — high-level transaction helper consolidating the manual dispatch protocol
4. `src/store/features/store.usecase.test.ts:273–467` — integration tests for transactions, batching, and `withTransaction`
5. **Goal:** understand how notifications are suppressed during transactions (including inner rollbacks), how `batch` and `withTransaction` differ from manual `dispatch` sequences, and the notification suppression contract

**Path 3 — Events-aware batch divergence**
1. `src/store/features/store.ts:367–463` — `createDocumentStoreWithEvents`, enhanced `dispatch`, events-aware `batch`
2. `src/store/features/events.test.ts:328–355` — batch intermediate-state event test
3. **Goal:** understand why the events-aware `batch` emits per-action events with intermediate states, and how error handling now matches the base store

**Path 4 — Reconciliation interaction with transactions**
1. `src/store/features/store.ts:131–133` — reconciliation scheduling on outermost commit
2. `src/store/features/store.usecase.test.ts:352–383` — test: reconciliation scheduled only after outermost commit
3. **Goal:** understand why dirty line ranges are not reconciled mid-transaction and where scheduling occurs

**Path 5 — Action serialization and type guards**
1. `src/types/actions.ts:199–236` — `isTextEditAction`, `isHistoryAction`, `isTransactionAction`
2. `src/types/actions.ts:242–287` — `isDocumentAction` runtime validator
3. `src/store/features/actions.ts:141–170` — `serializeAction`, `deserializeAction`
4. **Goal:** understand the full action type system and the validation/serialization boundary for external action sources
