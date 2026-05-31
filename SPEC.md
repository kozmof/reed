# Reed Specification (Current Codebase Status)

## Scope

This repository currently implements a core text engine and state runtime:

- immutable `DocumentState` snapshots
- piece table + line index data structures
- pure reducer transitions
- store factory with transactions and reconciliation helpers
- chunk loading/eviction runtime and high-level streaming loader
- query/scan API namespaces and selector-level rendering helpers

This repository does **not** currently include:

- framework adapters (React/Vue/Svelte/Redux/Zustand)
- a full collaboration transport/CRDT bridge

## Design Principles (Implemented)

1. Deterministic, pure reducer-based state transitions
2. Immutable state with structural sharing
3. Byte-accurate text model with explicit byte/char conversion utilities
4. Separate complexity layers: `query` (fast lookups) vs `scan` (full traversals)
5. Status-first specifications that distinguish implemented behavior from planned work

## Specification Documents

| Document                                                             | Domain        | Current Focus                                                               |
| -------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| [spec/01-core-architecture.md](spec/01-core-architecture.md)         | Core          | Piece table + line index architecture, reducer/store model, known core gaps |
| [spec/02-rendering.md](spec/02-rendering.md)                         | Rendering     | Selector-level viewport/line utilities                                      |
| [spec/03-loading-and-history.md](spec/03-loading-and-history.md)     | Data          | Streaming read support, history model, chunk-action stub status             |
| [spec/04-collaboration.md](spec/04-collaboration.md)                 | Collaboration | `APPLY_REMOTE` primitives and current non-implemented collaboration layers  |
| [spec/05-public-api.md](spec/05-public-api.md)                       | API           | Actual exported API surface from `src/index.ts`                             |
| [spec/06-testing.md](spec/06-testing.md)                             | Quality       | Current test suites, latest verified run, and coverage gaps                 |
| [spec/07-error-handling.md](spec/07-error-handling.md)               | Reliability   | Implemented fail-soft behavior and known semantic gaps                      |
| [spec/08-implementation.md](spec/08-implementation.md)               | Status        | Implemented, partial, and missing subsystems with near-term priorities      |
| [spec/09-piece-table-internals.md](spec/09-piece-table-internals.md) | Internals     | Add-buffer, chunk-buffer, and piece-table lifecycle details                 |

## Current API Snapshot

- Entry point: `src/index.ts`
- Store factories: `createDocumentStore`, `createDocumentStoreWithEvents`
- Chunk runtime: `createChunkManager`, `createStreamingDocumentLoader`
- Reconciliation runtime: `createReconciliationScheduler`
- Action creators: `DocumentActions`
- Read layers: `query.*`, `scan.*`
- Write helpers: `documentReducer`, `setValue`, diff-based action computation

## Verification Snapshot

- Latest verified functional test run: 2026-05-31
- Command: `pnpm test`
- Result: `16` test files, `619` tests passed
- Latest verified perf test run: 2026-05-31
- Command: `pnpm test:perf`
- Result: `1` test file, `27` tests passed, `1` test failed
- Current perf failure: `Undo / redo > 200 undos then 200 redos on 50k-line document` throws `Expected eager LineIndexState but found dirty ranges or pending rebuild`

See domain files under `/spec` for implementation-level details and constraints.
