# Testing Status

## 1. Latest Verified Run

- Date: 2026-06-25
- Functional command: `pnpm test`
- Functional result: `21` test files, `890` tests passed
- Perf command: `pnpm test:perf`
- Perf result: `1` test file, `28` tests passed

## 2. Current Test Suites

Functional suites (`pnpm test`):

- `src/types/branded.test.ts`: branded position types and cost combinators
- `src/store/features/actions.test.ts`: action creators and (de)serialization
- `src/store/core/streaming.test.ts`: `getValueStream` behavior
- `src/store/core/rb-tree.test.ts`: shared Red-Black tree invariants
- `src/store/core/attention.test.ts`: attention layer (piece-anchored boundary references) operations
- `src/store/core/encoding.test.ts`: UTF-8 byte-length and surrogate-pair helpers
- `src/store/core/runtime-readonly.test.ts`: readonly wrapper helpers for buffers/maps
- `src/store/features/transaction.test.ts`: transaction manager behavior
- `src/api/query.test.ts`: query namespace smoke/contract coverage
- `src/store/features/diff.test.ts`: diff and `setValue`
- `src/store/features/rendering.test.ts`: rendering selectors and conversions
- `src/store/features/history.test.ts`: undo/redo/history helpers and coalescing
- `src/store/features/events.test.ts`: event emitter and event-store behavior
- `src/store/core/piece-table.test.ts`: piece-table operations and buffer behavior
- `src/store/core/line-index.test.ts`: line-index operations and lookups
- `src/store/features/reconciliation-scheduler.test.ts`: scheduler mode, cancel, and idle reschedule behavior
- `src/store/features/store.logic.test.ts`: reducer invariants, action validation, store logic
- `src/store/features/store.usecase.test.ts`: end-to-end workflows and randomized reconciliation checks
- `src/store/features/chunk-manager.test.ts`: ChunkManager load/evict/LRU/pin behavior
- `src/store/features/chunk-metadata.test.ts`: DECLARE_CHUNK_METADATA and pre-declared line-count queries
- `src/store/features/streaming-loader.test.ts`: `createStreamingDocumentLoader` viewport/prefetch lifecycle

Performance suite (`pnpm test:perf`):

- `src/store/features/perf.test.ts`: large-document load/query/edit/reconcile benchmarks

## 3. Coverage Shape (What Is Actually Tested)

Implemented coverage is strongest in:

- immutable state transitions and structural sharing expectations
- reducer behavior for local edits, remote edits, history, selection, and transactions
- line-index and piece-table correctness across multiline/mixed-line-ending workloads
- store semantics (`batch`, nested transactions, rollback, snapshot gating)
- event semantics including `APPLY_REMOTE` `content-change` emission and `affectedRanges` correctness for multi-change batches
- selector-level rendering and byte/char conversion logic

## 4. Testing Gaps

Current gaps relative to roadmap/spec ambitions:

- no large-scale or randomized LOAD_CHUNK/EVICT_CHUNK stress suite; deterministic viewport-boundary eviction and reload are covered
- `createStreamingDocumentLoader` direct coverage remains focused on viewport validation, stale requests, and boundary eviction/reload
- performance thresholds are intentionally generous and catch catastrophic regressions rather
  than enforcing product-level latency budgets on every supported runtime

## 5. Guidance for Spec-Driven Testing

When adding new capabilities, keep tests in three layers:

1. Pure function/reducer tests for determinism.
2. Store workflow tests for batching, rollback, snapshot gating, and event semantics.
