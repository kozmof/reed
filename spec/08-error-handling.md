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
- If rollback itself fails, store uses transaction manager `emergencyReset()` and notifies listeners to avoid silent corruption.

### 1.4 Action parsing/validation helpers

- `deserializeAction()` throws on invalid payloads.
- `validateAction()` provides structured validation errors.

## 2. Current Non-Goals / Not Implemented

The following error domains are not implemented because the related runtime layers do not yet exist:
- file I/O errors (open/save/permissions)
- network/provider/collaboration transport errors
- plugin sandboxing/fault isolation
- chunk-cache eviction policies under memory pressure

## 3. Known Behavior Gaps

- `createDocumentStoreWithEvents` documents `APPLY_REMOTE` as a content-change source, but current emission logic only treats local text-edit actions as content-change events.
- After a successful `batch()` commit, line-index reconciliation is not auto-scheduled even if `rebuildPending` remains true.

## 4. Recommendation for Next Iteration

As runtime layers are added, keep the same strategy:
- fail-soft at boundary points,
- keep reducer/store deterministic,
- isolate observer/plugin/transport faults from core state transitions.
