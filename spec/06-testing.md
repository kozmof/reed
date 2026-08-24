# Testing Status

## 1. Latest Verified Run

- Date: 2026-08-24
- Functional command: `pnpm test`
- Functional result: `28` test files, `1133` tests passed
- Perf command: `pnpm test:perf`
- Perf result: `1` test file, `34` tests passed

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
- `src/store/features/attention-store.test.ts`: attention-layer integration through the document store
- `src/store/core/piece-table.test.ts`: piece-table operations and buffer behavior
- `src/store/core/line-index.test.ts`: line-index operations and lookups
- `src/store/features/reconciliation-scheduler.test.ts`: scheduler mode, cancel, and idle reschedule behavior
- `src/store/features/store.logic.test.ts`: reducer invariants, action validation, store logic
- `src/store/features/store.usecase.test.ts`: end-to-end workflows and randomized reconciliation checks
- `src/store/features/chunk-manager.test.ts`: ChunkManager load/evict/LRU/pin behavior
- `src/store/features/chunk-metadata.test.ts`: DECLARE_CHUNK_METADATA and pre-declared line-count queries
- `src/store/features/streaming-loader.test.ts`: `createStreamingDocumentLoader` viewport/prefetch lifecycle
- `src/store/features/chunk-stress.test.ts`: seeded randomized high-scale streaming stress (load/evict/reload consistency)
- `src/store/features/checkpoint.test.ts`: checkpoint capture/restore round trips, store entry points, and the payload rejection matrix
- `src/store/features/model-based.test.ts`: seeded edit sequences checked against a string model, including mid-sequence checkpoint restore
- `src/index.test.ts`: public entry point namespace wiring

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
- checkpoint round trips for text, line offsets, history, attention, and chunked documents, with a rejection test per validation code
- line-index offset-cache maintenance, covering newline-free lazy edits, lines inserted with a null offset, and viewport repair after dirty ranges collapse to the full-rebuild sentinel

The checkpoint suite pairs example-based tests with a model-based one. The model test swaps a
restored store in mid-sequence every 40 steps and keeps editing, so drift in piece identities
or in an allocator cursor shows up in later steps rather than at the moment of restore. It also
asserts strict red-black balance on the bulk-loaded piece tree.

## 4. Coverage Boundaries

Current gaps relative to roadmap/spec ambitions:

- `createStreamingDocumentLoader` directly covers viewport validation, stale-request cache trimming, multi-chunk viewport transitions, and boundary eviction/reload
- the performance suite enforces a 500 ms local-processing budget for a 100-chunk viewport, while end-to-end I/O latency remains loader- and product-specific

The randomized high-scale streaming stress suite (`chunk-stress.test.ts`) closes the
previously-acknowledged gap. It drives long seeded sequences of viewport-driven
load/evict/reload through `createStreamingDocumentLoader` over ASCII LF and CRLF
content (chunk boundaries deliberately split `\r\n` pairs) and, after every step,
reads the actual resident chunk set and asserts the assembled text, total byte
length, line count, and per-line byte/char offsets all match a from-scratch rebuild
of exactly those chunks, plus subtree-aggregate exactness on the reconciled line
index. Building it surfaced and fixed two real correctness defects:

- `LOAD_CHUNK` did not pass `readText` to the lazy line-index insert, so per-line
  char offsets drifted for any line spanning a chunk boundary.
- `EVICT_CHUNK` did not supply delete-boundary context (and never rebuilt for the
  cases that require it), so evicting a chunk whose boundary split a `\r\n` pair left
  the line index reporting the wrong line count until reload.

The randomized streaming stress suite asserts ordering, subtree aggregates, and
strict red-black balance after every reconciled step. Dedicated deletion tests
cover both persistent deletion and the large-range rebuild path. Line-index
lookups remain O(log n).

## 5. Guidance for Spec-Driven Testing

When adding new capabilities, keep tests in three layers:

1. Pure function/reducer tests for determinism.
2. Store workflow tests for batching, rollback, snapshot gating, and event semantics.
