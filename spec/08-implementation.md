# Implementation Status (Current)

## 1. Implemented Subsystems

### 1.1 Core state, types, and API namespaces

Implemented in:

- `src/types/*`
- `src/store/core/state.ts`
- `src/api/*`

Includes immutable state factories, branded offset types, action/store contracts, cost-typing utilities, and namespaced runtime API modules.

### 1.2 Text storage and indexing

Implemented in:

- `src/store/core/piece-table.ts`
- `src/store/core/line-index.ts`
- `src/store/core/rb-tree.ts`

Includes piece-table edits, line-index maintenance, lazy/eager reconciliation paths, streaming reads, and CR/LF/CRLF-aware boundary handling.

### 1.3 Reducer/store runtime

Implemented in:

- `src/store/features/reducer.ts`
- `src/store/features/store.ts`
- `src/store/features/transaction.ts`
- `src/store/features/history.ts`

Includes immutable reducer transitions, undo/redo, nested transactions, batching, snapshot-gated reconciliation, and emergency reset paths.

### 1.4 Diff, events, rendering selectors

Implemented in:

- `src/store/features/diff.ts`
- `src/store/features/events.ts`
- `src/store/features/rendering.ts`

Includes diff/setValue helpers, typed event emitter/store wrapper, and viewport/line selection utilities.

### 1.5 Public query/scan/history/diff layers

Implemented in:

- `src/api/query.ts`
- `src/api/scan.ts`
- `src/api/history.ts`
- `src/api/diff.ts`

Separates query-style lookups from scan-style traversals and exposes dedicated history/diff namespaces.

## 2. Partially Implemented Areas

### 2.1 Collaboration primitives

Implemented:

- `RemoteChange` and `APPLY_REMOTE` reducer path
- event-store `content-change` emission for remote edits

Missing:

- transport/provider bridge
- CRDT sync engine
- awareness/cursor presence
- conflict/recovery UX

### 2.2 Chunk management

Fully implemented:

- Action types and creators: `LOAD_CHUNK`, `EVICT_CHUNK`, `DECLARE_CHUNK_METADATA`
- Reducer handles both load and evict paths (byte decode, piece-table surgery, line-index update)
- `createChunkManager` runtime: async loading, in-flight deduplication, LRU eviction, chunk pinning
- `chunkSize`, `totalFileSize` in config

## 3. Not Implemented

- framework adapters (React/Vue/Svelte/Redux/Zustand)

## 4. Current Known Gaps

No currently confirmed core reducer/store correctness blockers from earlier spec revisions.

Primary remaining gaps are unimplemented runtime layers (chunk runtime, collaboration transport).

## 5. Near-Term Priorities

1. Add collaboration transport/provider + synchronization recovery tests.
2. Add ChunkManager integration stress tests (large-file load/evict at scale).
