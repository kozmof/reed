# Loading and history status

## 1. Loading and large-document support

### 1.1 Implemented

- Streaming full text via generator:
  - `scan.getValueStream(state.pieceTable, options)`
  - supports `chunkSize`, `start`, `end`
- Add-buffer usage introspection:
  - `query.getBufferStats`
- Core piece-table compaction:
  - `compactAddBuffer` in `src/store/core/piece-table.ts`
  - store-level idle/sync maintenance can compact the add buffer automatically when waste is high

### 1.2 Chunk Loading Runtime

Fully implemented:

- Action types and creators: `LOAD_CHUNK`, `EVICT_CHUNK`, `DECLARE_CHUNK_METADATA`
- Reducer handles `LOAD_CHUNK` (byte decode, first-load vs re-load, piece-table insertion, line-index update) and `EVICT_CHUNK` (range finding, add-piece overlap detection, tree pruning, line-index cleanup)
- `createChunkManager(store, loader, config)` runtime sits above the store and coordinates:
  - Async chunk loading via user-supplied `ChunkLoader`
  - In-flight deduplication (concurrent `ensureLoaded` calls for the same chunk share one fetch)
  - LRU eviction (`maxLoadedChunks` cap)
  - Chunk pinning via `setActiveChunks` to prevent hot-chunk eviction
  - Cooperative cancellation via `cancelPendingOutside` and the loader abort signal
- `DECLARE_CHUNK_METADATA` pre-declares per-chunk byte lengths and line counts so `query.getLineCount` reports the expected count across unloaded ranges
- `query.getResidentLineCount` reports the lines represented by the current line tree
- `query.getLineCountInfo` returns resident, unloaded, expected, and completion fields together
- `createStreamingDocumentLoader(store, loader, metadata, config)` wraps the common lifecycle:
  - declares all chunk metadata on construction
  - loads visible viewport chunks
  - pins and prefetches a surrounding chunk window

## 2. History Model

History is immutable and stored in `DocumentState.history`.

`HistoryState`:

- `undoStack`
- `redoStack`
- `limit`
- `coalesceTimeout`
- `evictionPolicy` — `'pin'` (default) or `'drop'`, from the `historyEvictionPolicy` config

`HistoryEntry` stores:

- `changes`
- `selectionBefore`
- `selectionAfter`
- `timestamp`

`HistoryChange` variants:

- `insert`
- `delete`
- `replace`

### 2.1 Positions across chunk loads

Loading or evicting a chunk shifts the resident offset of everything after it. History
therefore stores each position as an anchor pair (`HistoryAnchor`).

- `afterChunk` — chunks with an index at or below this value lie wholly before the position
- `position` — the resident offset minus the original lengths of the loaded chunks at or below `afterChunk`

Loads and evictions leave both values valid. Undo and redo convert them back to resident
offsets. Without chunking, `afterChunk` is `-1` and `position` is the plain byte offset.
History selections use the same pairs.

A delete that spans a chunk which is not loaded is recorded as several changes in one entry.
Undo then puts each part back on the correct side of that chunk.

History records deleted text as decoded strings. Undo restores malformed UTF-8, such as half
of a character cut off by an unloaded chunk, as U+FFFD. The restored text can then be longer
than the bytes it replaces. History accounts for that, so later changes in the entry and the
restored selection still land on the right text.

The live selection moves the same way on loads and evictions. A cursor inside an evicted chunk
moves to where the chunk was, and it stays on that side of the chunk when the chunk loads
again.

### 2.2 Eviction and history

A position strictly inside an evicted chunk cannot be resolved after eviction. This happens
when an edit inside a chunk is undone, or when inserted text is deleted again, which leaves the
chunk unedited. `historyEvictionPolicy` decides what `EVICT_CHUNK` does then.

Each entry is checked against the document as it was when that entry applies, not the current
one. An edit before the chunk moves it, so an older entry inside the chunk can have a position
outside the chunk's current span, and one outside it can have a position inside that span.

- `'pin'` (default) — refuse the eviction. The chunk stays loaded until those entries leave history.
- `'drop'` — evict and discard those entries, along with every entry that can only be undone or redone after them.

Positions on a chunk boundary do not block eviction.

### 2.3 Text next to chunks that are not loaded

New text attaches to the content after it. Text typed just before visible content therefore
stays with that content when an earlier chunk loads. At the end of the document, text attaches
to the content before it, so it stays before chunks that stream in later.

## 3. Undo/Redo and Grouping

Implemented:

- `UNDO`, `REDO`, `HISTORY_CLEAR`
- timeout-based coalescing for consecutive edits
- selection restoration on undo and redo
- the optional edit selection records the pre-edit caret restored by undo
- redo derives its caret from the change kind, placing inserts and replacements after inserted text and deletes at the deletion point

Transaction behavior:

- store-level transaction manager tracks depth/snapshots
- `batch()` executes actions inside transaction and notifies listeners once
- rollback restores snapshot
- `withTransaction(store, fn)` wraps begin/commit/rollback for synchronous callbacks
- async callbacks are rejected before invocation, and Promise or thenable results trigger rollback
- complete asynchronous work before calling `withTransaction` because work already started by a callback cannot be cancelled
- event-store transactions buffer events by nesting depth and flush on outermost commit

History boundaries:

- `batch()` is a notification boundary, not a history-collapsing boundary.
- Each action still contributes history unless coalesced.
- Undo and redo use the same lazy line-index updates as local edits. Aggregate-based public queries remain accurate immediately. Use `getEagerSnapshot()`, `reconcileNow()`, or `whenReconciled()` when exact cached node offsets are needed.

## 4. Related Events

`store.createDocumentStoreWithEvents` emits:

- `content-change` for local text edits and `APPLY_REMOTE`
- `selection-change`, including when a chunk load or eviction moves the selection
- `history-change` for undo and redo
- `history-drop` when eviction discards entries under the `'drop'` policy
- `attention-change` when attention records are created, deleted, or migrated
- `dirty-change`

`MARK_SAVED` emits `save` after the caller reports a successful save. See [the save lifecycle](05-public-api.md#31-save-lifecycle) for ordering and transaction behavior.
