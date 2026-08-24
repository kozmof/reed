# Error Handling Status

Reed validates actions and isolates failures at store boundaries. This document records the implemented behavior and known gaps.

## 1. Implemented error handling

### 1.1 Input validation in reducer

- Edit positions are validated/clamped to document bounds.
- Invalid ranges (`start > end`) become no-op edits.
- The trusted reducer treats non-finite positions as `0`. Unknown external input
  should go through `store.dispatchValidated()`, which rejects non-finite and
  non-integer positions.

### 1.2 Subscriber and event isolation

- Store listener exceptions are caught so one failing listener does not block others.
- Event handler exceptions are caught per handler in the emitter.

### 1.3 Transaction safety

- `batch()` uses transaction rollback on failure.
- If rollback itself fails, store calls `emergencyReset()` and notifies listeners.
- `withTransaction()` uses the same rollback/emergency-reset safety model.

### 1.4 Action parsing/validation helpers

- `deserializeAction()` throws on invalid payloads.
- `validateAction()` provides structured validation errors.
- `store.dispatchValidated(store, value)` validates unknown external input before dispatch.
- Direct `dispatch()` is the trusted typed boundary and does not repeat runtime validation.

### 1.5 Snapshot safety for reconciliation

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

- `save` event type exists, but there is no built-in save action/path that auto-emits it.

## 4. Recommendation for Next Iteration

As new capabilities are added, keep the same strategy:

- fail-soft at boundary points,
- keep reducer/store deterministic,
- isolate observer faults from core state transitions.
