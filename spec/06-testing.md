# Testing Status

## 1. Latest Verified Run

- Date: 2026-03-07
- Functional command: `pnpm test`
- Functional result: `13` test files, `556` tests passed
- Perf command: `pnpm test:perf`
- Perf result: `1` test file, `26` tests passed

## 2. Current Test Suites

Functional suites (`pnpm test`):

- `src/types/branded.test.ts`: branded position types and cost combinators
- `src/store/features/actions.test.ts`: action creators and (de)serialization
- `src/store/core/streaming.test.ts`: `getValueStream` behavior
- `src/store/features/transaction.test.ts`: transaction manager behavior
- `src/api/query.test.ts`: query namespace smoke/contract coverage
- `src/store/features/diff.test.ts`: diff and `setValue`
- `src/store/features/rendering.test.ts`: rendering selectors and conversions
- `src/store/features/history.test.ts`: undo/redo/history helpers and coalescing
- `src/store/features/events.test.ts`: event emitter and event-store behavior
- `src/store/core/piece-table.test.ts`: piece-table operations and buffer behavior
- `src/store/core/line-index.test.ts`: line-index operations and lookups
- `src/store/features/store.logic.test.ts`: reducer invariants, action validation, store logic
- `src/store/features/store.usecase.test.ts`: end-to-end workflows and randomized reconciliation checks

Performance suite (`pnpm test:perf`):

- `src/store/features/perf.test.ts`: large-document load/query/edit/reconcile benchmarks

## 3. Coverage Shape (What Is Actually Tested)

Implemented coverage is strongest in:

- immutable state transitions and structural sharing expectations
- reducer behavior for local edits, remote edits, history, selection, and transactions
- line-index and piece-table correctness across multiline/mixed-line-ending workloads
- store semantics (`batch`, nested transactions, rollback, snapshot gating)
- event semantics including `APPLY_REMOTE` `content-change` emission
- selector-level rendering and byte/char conversion logic

## 4. Testing Gaps

Current gaps relative to roadmap/spec ambitions:

- no real chunk loading/eviction runtime tests (`LOAD_CHUNK`/`EVICT_CHUNK` are stubs)
- no CRDT/provider/network collaboration integration tests
- performance tests report timings but do not enforce hard budget thresholds

## 5. Guidance for Spec-Driven Testing

When adding new capabilities, keep tests in three layers:

1. Pure function/reducer tests for determinism.
2. Store workflow tests for batching, rollback, snapshot gating, and event semantics.
3. Integration tests only after runtime layers (collab transport) exist.
