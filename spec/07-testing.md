# Testing Status

## 1. Latest Verified Run

- Date: 2026-02-21
- Command: `pnpm test`
- Result: `11` test files, `465` tests passed

Observed stderr during run is expected and covered by tests:
- event handler exception logging in `events.test.ts`
- store listener exception logging in `store.usecase.test.ts`

## 2. Current Test Suites

- `src/types/branded.test.ts`: branded position types and helpers
- `src/store/core/piece-table.test.ts`: piece-table operations and buffer behavior
- `src/store/core/line-index.test.ts`: line-index operations and lookups
- `src/store/core/streaming.test.ts`: `getValueStream` behavior
- `src/store/features/diff.test.ts`: diff and `setValue`
- `src/store/features/events.test.ts`: event emitter and event-store behavior
- `src/store/features/history.test.ts`: undo/redo/history helpers and coalescing
- `src/store/features/rendering.test.ts`: rendering selectors and conversions
- `src/store/features/store.logic.test.ts`: state factories, reducer invariants, store API
- `src/store/features/store.usecase.test.ts`: end-to-end editing workflows
- `src/store/features/transaction.test.ts`: standalone transaction manager

## 3. Coverage Shape (What Is Actually Tested)

Implemented coverage is strongest in:
- immutable state transitions and structural sharing expectations
- reducer behavior for local edits, history, selection, and transactions
- line-index and piece-table functional correctness
- event emission semantics for local edit actions
- selector-level rendering logic

## 4. Testing Gaps

Current gaps relative to roadmap/spec ambitions:
- no real chunk loading/eviction tests (`LOAD_CHUNK`/`EVICT_CHUNK` are stubs)
- no CRDT/provider/network collaboration tests
- no plugin runtime tests (plugin runtime not implemented)
- no DOM/editor-component integration tests
- no explicit test asserting reconciliation scheduling after `batch()` commit when lazy line index stays dirty
- no event-store test asserting `APPLY_REMOTE` emits `content-change` (it currently does not)

## 5. Guidance for Spec-Driven Testing

When adding new capabilities, keep tests in three layers:
1. Pure function/reducer tests for determinism.
2. Store workflow tests for batching, rollback, and event semantics.
3. Integration tests only after runtime layers (view/plugin/collab transport) exist.
