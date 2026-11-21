# Error Handling Status

Reed validates actions and isolates failures at store boundaries. This document records the implemented behavior and known gaps.

## 1. Implemented error handling

### 1.1 Input validation in reducer

- Edit positions are clamped to document bounds. Positions that split UTF-8 code points throw `RangeError`.
- Invalid ranges (`start > end`) become no-op edits.
- The trusted reducer treats non-finite positions as `0`. Unknown external input
  should go through `store.dispatchValidated()`, which rejects non-finite and
  non-integer positions.

### 1.2 Subscriber and event isolation

- Store listener exceptions are caught so one failing listener does not block others.
- Event handler exceptions are caught per handler in the emitter.
- Event payload preparation errors are caught after dispatch, so a committed edit still returns successfully.
- Nested store notifications and typed events drain iteratively instead of recursing.
- Callback cycles are bounded and reported through the configured logger:
  - Store listeners get at most 100 synchronous notification passes.
  - The emitter delivers at most 100 events that handlers queue while it emits.
  - Event handler dispatches nest at most 100 levels deep, and one synchronous
    delivery delivers the events of at most 10,000 actions dispatched in
    reaction to actions a handler dispatched, plus 100 for each action a
    handler or store listener dispatches directly, and never more than
    100,000. Those direct actions are
    not counted, so a handler can dispatch any number of them one at a time,
    and other handlers can react once to each. The total limit stops a
    handler that dispatches more than one action per event before the work
    grows exponentially.
  - Actions dispatched past a limit still commit. Only their notifications or
    events are dropped.
- Once a change commits, `dispatch()` and `commitTransaction()` do not throw.
  A reconciliation scheduler that throws after a commit is reported through
  the logger, so a throw from either call means the change did not take
  effect, and no events are emitted for it.

### 1.3 Transaction safety

- `batch()` uses transaction rollback on failure.
- If rollback itself fails, store calls `emergencyReset()` and notifies listeners.
- `withTransaction()` uses the same rollback/emergency-reset safety model.

### 1.4 Action parsing/validation helpers

- `deserializeAction()` throws on invalid payloads.
- `validateAction()` provides structured validation errors.
- `store.dispatchValidated(store, value)` validates unknown external input before dispatch.
- Direct `dispatch()` is the trusted typed boundary and does not repeat runtime validation.

### 1.5 Runtime configuration validation

- Store creation rejects unsupported reconciliation modes and malformed scheduler objects.
- Store creation rejects invalid runtime content and line-ending normalization values.
- `createChunkManager` rejects unsupported fetch strategies.
- `createReconciliationScheduler` rejects unsupported modes when called directly.

### 1.6 Snapshot safety for reconciliation

- `isCurrentSnapshot()` lets callers detect stale snapshots.
- `reconcileIfCurrent(snapshot)` returns `null` for stale snapshots instead of mutating current state from an outdated reference.
- `whenReconciled()` provides a promise-based path for consumers that need an eager state after background reconciliation.
- A custom scheduler factory can be injected through `DocumentStoreConfig.scheduler`
  when callers need explicit scheduling behavior. It receives the store's live
  maintenance callbacks, avoiding a circular store capture.

## 2. Current Non-Goals / Not Implemented

The following error domains are not implemented:

- host-level memory pressure handling beyond the implemented chunk LRU cap

## 3. Current Caveats

- `MARK_SAVED` reports that the caller completed a save. Reed performs no I/O
  and cannot confirm that bytes reached durable storage.

## 4. Recommendation for Next Iteration

Apply the same rules to new capabilities.

- Reject invalid external input before dispatch.
- Keep reducer transitions deterministic.
- Isolate observer failures from committed state changes.
