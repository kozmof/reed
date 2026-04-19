# Error Handling Status

## 1. Implemented Error-Handling Behavior

### 1.1 Input validation in reducer

- Edit positions are validated/clamped to document bounds.
- Invalid ranges (`start > end`) become no-op edits.
- Non-finite positions are warned and treated as `0`.

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

### 1.5 Snapshot safety for reconciliation

- `isCurrentSnapshot()` lets callers detect stale snapshots.
- `reconcileIfCurrent(snapshot)` returns `null` for stale snapshots instead of mutating current state from an outdated reference.

## 2. Current Non-Goals / Not Implemented

The following error domains are not implemented because the related runtime layers do not yet exist:

- file I/O errors (open/save/permissions)
- network/provider/collaboration transport errors
- chunk-cache eviction policies under memory pressure

## 3. Current Caveats

- `save` event type exists, but there is no built-in save action/path that auto-emits it.

## 4. Recommendation for Next Iteration

As runtime layers are added, keep the same strategy:

- fail-soft at boundary points,
- keep reducer/store deterministic,
- isolate observer/transport faults from core state transitions.
