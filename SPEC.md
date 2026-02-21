# Reed Specification (Current Codebase Status)

## Scope

This repository currently implements a core text engine and state runtime:
- immutable `DocumentState` snapshots
- piece table + line index data structures
- pure reducer transitions
- store factory with transactions and reconciliation helpers
- query/scan API namespaces and selector-level rendering helpers

This repository does **not** currently include:
- a DOM `EditorView` runtime
- framework adapters (React/Vue/Svelte/Redux/Zustand)
- a plugin host/runtime
- a full collaboration transport/CRDT bridge
- real chunk loader/eviction runtime

## Design Principles (Implemented)

1. Deterministic, pure reducer-based state transitions
2. Immutable state with structural sharing
3. Byte-accurate text model with explicit byte/char conversion utilities
4. Separate complexity layers: `query` (fast lookups) vs `scan` (full traversals)
5. Status-first specifications that distinguish implemented behavior from planned work

## Specification Documents

| Document | Domain | Current Focus |
|----------|--------|---------------|
| [spec/01-core-architecture.md](spec/01-core-architecture.md) | Core | Piece table + line index architecture, reducer/store model, known core gaps |
| [spec/02-rendering.md](spec/02-rendering.md) | Rendering | Selector-level viewport/line utilities (no DOM view runtime) |
| [spec/03-loading-and-history.md](spec/03-loading-and-history.md) | Data | Streaming read support, history model, chunk-action stub status |
| [spec/04-collaboration.md](spec/04-collaboration.md) | Collaboration | `APPLY_REMOTE` primitives and current non-implemented collaboration layers |
| [spec/05-plugin-system.md](spec/05-plugin-system.md) | Extensibility | Current absence of plugin host and constraints for future design |
| [spec/06-public-api.md](spec/06-public-api.md) | API | Actual exported API surface from `src/index.ts` |
| [spec/07-testing.md](spec/07-testing.md) | Quality | Current test suites, latest verified run, and coverage gaps |
| [spec/08-error-handling.md](spec/08-error-handling.md) | Reliability | Implemented fail-soft behavior and known semantic gaps |
| [spec/09-implementation.md](spec/09-implementation.md) | Status | Implemented, partial, and missing subsystems with near-term priorities |

## Current API Snapshot

- Entry point: `src/index.ts`
- Store factories: `createDocumentStore`, `createDocumentStoreWithEvents`
- Action creators: `DocumentActions`
- Read layers: `query.*`, `scan.*`
- Write helpers: `documentReducer`, `setValue`, diff-based action computation

## Known Cross-Cutting Gaps

- `APPLY_REMOTE` mutates content but does not auto-emit `content-change` in event-store wrapper.
- `batch()` commit path does not automatically schedule line-index reconciliation when `rebuildPending` remains true.
- Lazy line-index precision can be incorrect in some multiline edit paths before reconciliation.

## Verification Snapshot

- Latest verified test run: 2026-02-21
- Command: `pnpm test`
- Result: `11` test files, `465` tests passed

See domain files under `/spec` for implementation-level details and constraints.
