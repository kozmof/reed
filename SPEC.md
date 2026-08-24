# Reed specification

## Scope

Reed provides a text engine and state runtime for building editors.

- immutable `DocumentState` snapshots
- piece table + line index data structures
- pure reducer transitions
- store factory with transactions and reconciliation helpers
- chunk loading/eviction runtime and high-level streaming loader
- query/scan API namespaces and selector-level rendering helpers
- checkpoint capture and restore for saving state and loading it back

## Design Principles (Implemented)

1. Deterministic, pure reducer-based state transitions
2. Immutable state with structural sharing
3. Byte-accurate text model with explicit byte/char conversion utilities
4. Separate complexity layers for fast `query` lookups and full `scan` traversals
5. Status-first specifications that distinguish implemented behavior from planned work

## Specification Documents

| Document                                                             | Domain        | Current Focus                                                               |
| -------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| [spec/01-core-architecture.md](spec/01-core-architecture.md)         | Core          | Piece table + line index architecture, reducer/store model, known core gaps |
| [spec/02-rendering.md](spec/02-rendering.md)                         | Rendering     | Selector-level viewport/line utilities                                      |
| [spec/03-loading-and-history.md](spec/03-loading-and-history.md)     | Data          | Streaming read support, history model, chunk loading runtime                |
| [spec/04-collaboration.md](spec/04-collaboration.md)                 | Collaboration | `APPLY_REMOTE` remote-change primitives and their event semantics           |
| [spec/05-public-api.md](spec/05-public-api.md)                       | API           | Actual exported API surface from `src/index.ts`                             |
| [spec/06-testing.md](spec/06-testing.md)                             | Quality       | Current test suites, latest verified run, and coverage gaps                 |
| [spec/07-error-handling.md](spec/07-error-handling.md)               | Reliability   | Implemented fail-soft behavior and known semantic gaps                      |
| [spec/08-implementation.md](spec/08-implementation.md)               | Status        | Implemented subsystems, subsystem notes, and near-term priorities           |
| [spec/09-piece-table-internals.md](spec/09-piece-table-internals.md) | Internals     | Add-buffer, chunk-buffer, and piece-table lifecycle details                 |
| [spec/10-attention.md](spec/10-attention.md)                         | References    | Piece-anchored attention layer: points, spans, and edit migration           |
| [spec/11-checkpoint.md](spec/11-checkpoint.md)                       | Persistence   | Checkpoint wire format, capture modes, and restore validation               |

## Current API Snapshot

- Entry point: `src/index.ts`
- Store factories: `createDocumentStore`, `createDocumentStoreWithEvents`
- Chunk runtime: `createChunkManager`, `createStreamingDocumentLoader`
- Reconciliation runtime: `createReconciliationScheduler`
- Action creators: `DocumentActions`
- Read layers: `query.*`, `scan.*`
- Reference layer: `attention.*` (piece-anchored references)
- Persistence layer: `checkpoint.*` plus `createDocumentStoreFromCheckpoint`
- Write helpers: `documentReducer`, `setValue`, diff-based action computation

## Verification Snapshot

[spec/06-testing.md](spec/06-testing.md) records the latest verified commands,
results, and per-suite coverage. Verification counts live there so they cannot
drift between status documents.

See domain files under `/spec` for implementation-level details and constraints.
