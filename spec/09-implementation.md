# Implementation Status (Current)

## 1. Implemented Subsystems

### 1.1 Core state and types

Implemented in:
- `src/types/*`
- `src/store/core/state.ts`

Includes immutable state factories, branded offset types, action/store contracts, and cost-typing utilities.

### 1.2 Text storage and indexing

Implemented in:
- `src/store/core/piece-table.ts`
- `src/store/core/line-index.ts`
- `src/store/core/rb-tree.ts`

Includes piece-table edits, line-index maintenance, lazy/eager reconciliation paths, and streaming reads.

### 1.3 Reducer/store runtime

Implemented in:
- `src/store/features/reducer.ts`
- `src/store/features/store.ts`
- `src/store/features/transaction.ts`
- `src/store/features/history.ts`

Includes immutable reducer transitions, undo/redo, nested transactions, batching, and reconciliation hooks.

### 1.4 Diff, events, rendering selectors

Implemented in:
- `src/store/features/diff.ts`
- `src/store/features/events.ts`
- `src/store/features/rendering.ts`

Includes Myers-style diff helpers, typed event emitter/store wrapper, and viewport/line selection utilities.

### 1.5 Public query layers

Implemented in:
- `src/api/query.ts`
- `src/api/scan.ts`

Separates query-style lookups from scan-style traversals.

## 2. Partially Implemented Areas

### 2.1 Collaboration primitives

Implemented:
- `RemoteChange` and `APPLY_REMOTE` action path in reducer.

Missing:
- transport/provider bridge
- CRDT sync engine
- awareness/cursor presence
- conflict/recovery UX

### 2.2 Chunk management primitives

Implemented:
- action types and action creators (`LOAD_CHUNK`, `EVICT_CHUNK`)
- `chunkSize` in config

Missing:
- actual chunk runtime behavior (reducer currently no-op)

## 3. Not Implemented

- framework adapters (React/Vue/Svelte/Redux/Zustand)
- DOM `EditorView` runtime
- plugin host/runtime
- markdown preview plugin implementation

## 4. Current Known Gaps

- `batch()` commit path does not schedule reconciliation for pending lazy line-index rebuilds.
- event wrapper does not emit `content-change` for `APPLY_REMOTE`.
- some lazy line-range precision cases remain sensitive before reconciliation.

## 5. Near-Term Priorities

1. Fix store/event semantic gaps (`batch()` reconciliation scheduling and `APPLY_REMOTE` content-change emission behavior).
2. Decide and implement real chunk loading strategy or remove chunk actions from current public contract.
3. Add collaboration/plugin/view layers only after these core consistency gaps are closed.
