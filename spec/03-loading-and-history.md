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

A delete that spans text with different placement keys, such as text from two chunks, is
recorded as several changes in one entry, one for each key. Undo then puts each part back with
its own key, on the correct side of every chunk. For the same reason, consecutive edits merge
into one change only when they have the same key.

History records deleted text as decoded strings. When decoding changed the bytes, so the text
no longer encodes back to them (malformed UTF-8 such as half of a character cut off by an
unloaded chunk, or a byte order mark), the change also keeps the exact bytes. Undo re-inserts
those bytes, so the document comes back byte for byte and every position recorded in older
entries stays valid. Such changes are never merged with neighbouring edits.

The live selection moves the same way on loads and evictions. A cursor inside an evicted chunk
moves to where the chunk was, and it stays on that side of the chunk when the chunk loads
again. If the evicted chunk cut a character in two, the cursor moves past the bytes of that
character left in the next chunk, so it always sits on a UTF-8 code-point boundary. Undo and
redo place a restored selection the same way.

Next to a chunk that is not loaded, a byte offset cannot say which side of the chunk a
position is on. A selection range then stores the placement key of that endpoint
(`SelectionRange.anchorAfterChunk` and `headAfterChunk`). The key is present only when the
document cannot supply it, and it is kept by undo, redo, checkpoints, and a `SET_SELECTION`
or edit selection that repeats the range at the same index. Text inserted at that endpoint,
by a local edit or `APPLY_REMOTE`, takes the key, so it stays where the cursor was in the
file, even when every chunk has been evicted. A key that no longer fits its offset after
other edits is ignored.

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

New text attaches to the content before it: text typed right after a chunk stays next to that
chunk when a chunk that was missing after it loads, and text typed at the end of the document
stays before chunks that stream in later. At the start of the document there is no content
before, so text typed before visible content stays with that content when an earlier chunk
loads.

A cursor follows the same rule as text typed there. A selection's start stays with the content
after it and its end with the content before it, so a chunk that loads at either edge of a
selection lands outside it rather than being selected.

## 3. Undo/Redo and Grouping

Implemented:

- `UNDO`, `REDO`, `HISTORY_CLEAR`
- timeout-based coalescing for consecutive edits
- selection restoration on undo and redo
- the optional edit selection records the pre-edit caret restored by undo
- an edit moves the selection it comes from past the edit: offsets before it stay, an endpoint at or inside the edited range moves after the inserted text, and later offsets shift by the change in length
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
- `selection-change` whenever an action moves the selection, including an edit, undo, redo, and a chunk load or eviction
- `history-change` for undo and redo
- `history-drop` when eviction discards entries under the `'drop'` policy
- `attention-change` when attention records are created, deleted, or migrated
- `dirty-change`

`MARK_SAVED` emits `save` after the caller reports a successful save. See [the save lifecycle](05-public-api.md#31-save-lifecycle) for ordering and transaction behavior.
