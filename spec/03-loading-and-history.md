# Loading & History Status

## 1. Loading / Large-Document Capabilities

### 1.1 Implemented

- Streaming full text via generator:
  - `scan.getValueStream(state.pieceTable, options)`
  - supports `chunkSize`, `start`, `end`
- Add-buffer usage introspection:
  - `query.getBufferStats`
- Core piece-table compaction primitive exists internally:
  - `compactAddBuffer` in `src/store/core/piece-table.ts`

### 1.2 Chunk Loading Runtime

Fully implemented:

- Action types and creators: `LOAD_CHUNK`, `EVICT_CHUNK`, `DECLARE_CHUNK_METADATA`
- Reducer handles `LOAD_CHUNK` (byte decode, first-load vs re-load, piece-table insertion, line-index update) and `EVICT_CHUNK` (range finding, add-piece overlap detection, tree pruning, line-index cleanup)
- `createChunkManager(store, loader, config)` runtime sits above the store and coordinates:
  - Async chunk loading via user-supplied `ChunkLoader`
  - In-flight deduplication (concurrent `ensureLoaded` calls for the same chunk share one fetch)
  - LRU eviction (`maxLoadedChunks` cap)
  - Chunk pinning via `setActiveChunks` to prevent hot-chunk eviction
- `DECLARE_CHUNK_METADATA` pre-declares per-chunk byte lengths and line counts so `getLineCount` is accurate on unloaded ranges

### 1.3 Not Implemented

- Background file parsing workers
- Disk-backed paging

## 2. History Model

History is immutable and stored in `DocumentState.history`.

`HistoryState`:

- `undoStack`
- `redoStack`
- `limit`
- `coalesceTimeout`

`HistoryEntry` stores:

- `changes`
- `selectionBefore`
- `selectionAfter`
- `timestamp`

`HistoryChange` variants:

- `insert`
- `delete`
- `replace`

## 3. Undo/Redo and Grouping

Implemented:

- `UNDO`, `REDO`, `HISTORY_CLEAR`
- timeout-based coalescing for consecutive edits
- selection restoration on undo/redo

Transaction behavior:

- store-level transaction manager tracks depth/snapshots
- `batch()` executes actions inside transaction and notifies listeners once
- rollback restores snapshot
- `withTransaction(store, fn)` wraps begin/commit/rollback with the same safety behavior

Important current behavior:

- `batch()` is a notification boundary, not a history-collapsing boundary.
- Each action still contributes history unless coalesced.

## 4. Related Events

`store.createDocumentStoreWithEvents` emits:

- `content-change` for local text edits and `APPLY_REMOTE`
- `selection-change`
- `history-change`
- `dirty-change`

`save` event type exists in the event system but is not auto-triggered by reducer/store actions.
