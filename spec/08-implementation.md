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
- `src/store/features/reconciliation-scheduler.ts`

Includes immutable reducer transitions, undo/redo, nested transactions, batching, snapshot-gated reconciliation, `whenReconciled`, background maintenance scheduling, and emergency reset paths.

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

## 2. Subsystem Notes

### 2.1 Collaboration primitives

Implemented:

- `RemoteChange` and `APPLY_REMOTE` reducer path
- event-store `content-change` emission for remote edits

### 2.2 Chunk management

Fully implemented:

- Action types and creators: `LOAD_CHUNK`, `EVICT_CHUNK`, `DECLARE_CHUNK_METADATA`
- Reducer handles both load and evict paths (byte decode, piece-table surgery, line-index update)
- `createChunkManager` runtime: async loading, in-flight deduplication, LRU eviction, chunk pinning
- `createStreamingDocumentLoader` runtime: metadata declaration, viewport loading, pinned/prefetched windows
- `chunkSize`, `totalFileSize` in config

### 2.3 Attention layer

Implemented in `src/store/core/attention.ts`, with full coverage in `src/store/core/attention.test.ts`: piece-anchored boundary references that survive RB-tree rebalancing and edit migration. Exposed publicly via the `attention` namespace (`src/api/attention.ts`).

See [10-attention.md](10-attention.md) for the full design, API, and migration semantics.

## 3. Current Known Gaps

No currently confirmed functional-suite core reducer/store correctness blockers from earlier spec revisions.

Primary remaining gap is broader high-scale streaming/integration coverage.

## 4. Near-Term Priorities

1. Add ChunkManager/StreamingDocumentLoader integration stress tests (large-file load/evict at scale).
