# Public API Status

## 1. Entry Points

The public runtime API is exported from `src/index.ts` through these namespaces.

- `store`
- `query`
- `scan`
- `events`
- `rendering`
- `history`
- `diff`
- `position`
- `attention`
- `checkpoint`

Types are exported flat from the same entry file.

Additional flat runtime exports:

- `createChunkManager`
- `createStreamingDocumentLoader`
- `createReconciliationScheduler`

Not present in current codebase:

- `reed/read` subpath
- `reed/write` subpath
- `reed/view` subpath

## 2. Store API (`store` namespace)

### 2.1 `store.createDocumentStore(config?)`

Returns `ReconcilableDocumentStore` with:

- `subscribe(listener)`
- `getSnapshot()`
- `getServerSnapshot()`
- `isCurrentSnapshot(snapshot)`
- `dispatch(action)`
- `batch(actions)`
- `beginTransaction()`
- `commitTransaction()`
- `rollbackTransaction()`
- `isInTransaction()` — whether a transaction is open
- `scheduleReconciliation()`
- `reconcileNow()` — reconcile and return `DocumentState<'eager'>`
- `reconcileIfCurrent(snapshot)` — reconcile only if `snapshot` is still current, returning `DocumentState<'eager'> | null`
- `getEagerSnapshot()` — return current state with eager line-index without incrementing revision
- `whenReconciled()` — resolve with eager state after background reconciliation completes
- `setViewport(startLine, endLine)`
- `emergencyReset()`
- `dispose()`

Supported config fields (`DocumentStoreConfig`):

- `content`
- `logger` — optional diagnostics sink. Without a store logger, callback failures are reported through `console.error`. The store warns through it when `EVICT_CHUNKS`, which ChunkManager sends, discards undo or redo history, after the eviction commits. Outside a transaction it warns immediately. Inside a transaction it waits for the outermost commit. Rollback discards the warning. Without it, the store gives the warning for an eviction a ChunkManager dispatched to that manager's `logger`, if it has one
- `historyLimit`
- `chunkSize`
- `encoding` — currently only `'utf-8'` is supported
- `lineEnding`
- `undoGroupTimeout`
- `historyEvictionPolicy` — `'pin'` refuses to evict a chunk that history points inside, `'drop'` evicts it and discards those entries, and `'pin-bounded'` (default) refuses unless `EVICT_CHUNK` has `overLimit: true`, or `EVICT_CHUNKS` (which ChunkManager sends) finds nothing else brings it within its limit
- `normalizeInsertedLineEndings` — coerce line endings on `INSERT`/`REPLACE` to match `lineEnding`
- `totalFileSize` — pre-declared file size used for chunk sizing, and must be a non-negative safe integer
- `maxDirtyRanges` — dirty-range count threshold before a full line-index rebuild is triggered
- `reconcileMode` — `'idle'` (default, uses `requestIdleCallback`) | `'sync'` (same-tick) | `'none'` (manual)
- `scheduler` — custom `ReconciliationSchedulerFactory` (preferred) or pre-built
  `ReconciliationScheduler` (backward compatibility), and mutually exclusive with `reconcileMode`

### 2.2 `store.createDocumentStoreWithEvents(config?)`

Wraps the base store and adds:

- `addEventListener(type, handler)`
- `removeEventListener(type, handler)`
- `events` emitter handle

### 2.3 `store.createDocumentStoreFromCheckpoint(checkpoint, config?, restoreOptions?)`

Returns a `ReconcilableDocumentStore` whose state comes from a checkpoint. Throws
`CheckpointError` before creating anything when the payload is not restorable.

`store.createDocumentStoreWithEventsFromCheckpoint(checkpoint, config?, restoreOptions?)` is the event-store
counterpart. Restoring emits no events.

Config is `DocumentStoreRestoreConfig`, which accepts `logger`, either `reconcileMode` or
`scheduler`, and `historyEvictionPolicy`. Set `historyEvictionPolicy` to override the checkpoint's policy. Version 1 checkpoints
default to `'pin-bounded'`. Restore reads other state settings from the checkpoint
and throws if you pass them in the config.

### 2.4 Flat `createChunkManager(store, loader, config?)`

Returns a `ChunkManager` with:

- `ensureLoaded(chunkIndex)` — load a chunk if not already in memory
- `prefetch(chunkIndex)` — speculatively load one chunk
- `setActiveChunks(chunkIndices)` — pin chunks to prevent LRU eviction
- `cancelPendingOutside(chunkIndices)` — abort pending loads outside the current working set
- `dispose()` — cancel in-flight loads and release resources

Requires a user-supplied `ChunkLoader` with
`loadChunk(chunkIndex, signal?): Promise<Uint8Array>`. The optional abort signal is canceled when
the manager drops a pending load or is disposed.

The manager can evict chunks it loads and any resident chunks it adopts at
creation. It adopts chunks with no live owner, including chunks from a
checkpoint restore, an earlier manager, or the app. If the app dispatches
`LOAD_CHUNK` after creating the manager, the app retains control of that chunk's
eviction. Use `setActiveChunks` to keep a chunk loaded during a manager eviction pass.

`ChunkManagerConfig` accepts `maxLoadedChunks`, `fetchStrategy`, and `logger`. The manager’s `logger` warns when the resident chunk count stays above `maxLoadedChunks`. The store reports history discarded by eviction through its `logger` and the `history-drop` event. If the store has no logger, the manager supplies its own for evictions it dispatches, including through wrappers that forward `dispatch` synchronously. If the manager’s `warn` throws, its `error` receives the failure when available.

### 2.5 Flat `createStreamingDocumentLoader(store, loader, metadata, config?)`

Returns a `StreamingDocumentLoader` with:

- `setViewport(startChunkIndex, endChunkIndex)` — load viewport chunks, pin/prefetch the configured surrounding window
- `dispose()` — release loader resources

Config (`StreamingDocumentLoaderConfig`): `prefetchWindowSize`, `chunkManagerConfig`.

### 2.6 Flat `createReconciliationScheduler(mode, options)`

Creates a scheduler for background line-index reconciliation and add-buffer compaction.

Modes: `'idle'`, `'sync'`, `'none'`.

### 2.7 Additional store namespace exports

- `store.withTransaction(store, fn)`
- `store.isDocumentStore(value)`
- `store.dispatchValidated(store, value)`
- `store.setValue(store, newContent, options?)`
- `store.DocumentActions`
- `store.serializeAction` / `store.deserializeAction`
- `store.unsafe.documentReducer`
- `store.didEvict(prevState, nextState, chunkIndex)`
- `store.unsafe.*` state factories, builders, and core mutation helpers
- `store.unsafe.*` reconciliation helpers (`reconcileRange`, `reconcileFull`, `reconcileViewport`)
- action validators/guards (`isDocumentAction`, `validateAction`, etc.)

Import `createChunkManager`, `createStreamingDocumentLoader`, and `createReconciliationScheduler` directly from the package. These functions are flat runtime exports.

## 3. Event Semantics

Supported event types:

- `content-change`
- `selection-change`
- `history-change`
- `history-drop`
- `attention-change`
- `save`
- `dirty-change`

Auto-emitted by `store.createDocumentStoreWithEvents`:

- `content-change` (`INSERT/DELETE/REPLACE/APPLY_REMOTE`)
- `selection-change` fires when an action replaces the selection. This includes
  explicit selection changes and changes caused by edits, undo or redo, chunk
  loads, and chunk evictions.
- `history-change` (`UNDO/REDO`)
- `history-drop` reports discarded entries in `undoDropped` and `redoDropped`.
  - Eviction emits it when the history policy discards entries.
  - `UNDO` and `REDO` emit it when the next entry fails to resolve. They discard that entry and the rest of its stack.
  - `APPLY_REMOTE` and `HISTORY_CLEAR` emit it when they clear a non-empty history.
- `attention-change` (create, delete, or content edits that rewrite stored points)
- `save` (`MARK_SAVED`)
- `dirty-change` (when dirty flag changes)

### 3.1 Save lifecycle

Persist the document, then dispatch `MARK_SAVED` to report success. Reed performs no I/O.

```ts
import { store, scan } from "@kozmof/reed";

await writeFile(path, scan.getValue(doc.getSnapshot().pieceTable));
doc.dispatch(store.DocumentActions.markSaved());
```

`MARK_SAVED` clears `metadata.isDirty` and stamps `metadata.lastSaved`.
`DocumentActions.markSaved()` captures the current time when it creates the
action.
An event store then emits `save`, followed by `dirty-change` when the document had
been dirty. It emits `save` first, so a `dirty-change` listener sees the save.

Semantics:

- `save` is emitted only for an explicit `MARK_SAVED`. It is never inferred
  from the document becoming clean by other means. It reports caller success but
  does not confirm that bytes reached durable storage.
- Saving an already-clean document still emits `save`. There is no dirty
  transition to report. Re-saving at the same timestamp is a no-op that does
  not advance the revision.
- Inside a transaction the event is buffered until commit. A rollback discards
  both the event and the clean state, so a failed write leaves the document
  dirty.
- Later edits, remote changes, and successful undo or redo re-dirty the document
  but preserve `lastSaved`. Undo and redo use conservative dirty tracking, so
  returning to saved content does not automatically mark the document clean.

Before v3.2.0 the `save` event type and `createSaveEvent` factory existed with
no transition that could emit them, and `isDirty` was only ever set to `true`.

### 3.2 Event origin

Every event an event store emits carries `origin`, an `EventOrigin`. All events
from one action share the same frozen origin object.

- `id` — identifies the action within its store. An action delivered later has
  a larger id. An action that emits no events still uses one, so ids skip
  values. Use them to correlate events, not to count actions.
- `action` — the action whose commit produced the event, payload included.
- `types` — every event type the action emits, in delivery order.
- `transactionId` — the id of the outermost transaction open when the action
  was dispatched, or `null` when none was open. Nested transactions share the
  outermost id. A later transaction has a larger id.

An action delivers its events in this order. Each fires only when the action
causes it.

1. `content-change`
2. `selection-change`
3. `history-change` or `history-drop`
4. `attention-change`
5. `save`
6. `dirty-change`

The store fixes `types` before it delivers the first event. A handler therefore
sees events that arrive after its own, such as the `history-change` that follows
a `selection-change` on undo.

Check `origin.action` to find out why the selection moved.

```ts
doc.addEventListener("selection-change", (e) => {
  switch (e.origin?.action.type) {
    case "SET_SELECTION":
      return showUserSelection(e);
    case "UNDO":
    case "REDO":
      return showRestoredSelection(e);
    case "INSERT":
    case "DELETE":
    case "REPLACE":
    case "APPLY_REMOTE":
      return followEdit(e);
    default:
      // LOAD_CHUNK, LOAD_CHUNKS, EVICT_CHUNK, or EVICT_CHUNKS shifted it.
      return shiftSelection(e);
  }
});
```

Check `origin.types` for what else the action did. Only `INSERT`, `DELETE`,
`REPLACE`, and `APPLY_REMOTE` list `content-change`. An `UNDO` or `REDO` that
applies an entry changes the text but lists `history-change` instead. One whose
entry no longer replays lists `history-drop`.

Semantics:

- Each action in a `batch` or transaction gets its own origin. They all share
  one `transactionId`.
- Rolling back the outermost transaction discards all of its events, so its
  `transactionId` never appears. Rolling back a nested transaction discards
  only that transaction's events. The outer transaction's events still carry
  the id when it commits.
- An action that an event handler or store listener dispatches gets a later
  `id`. Its `transactionId` is that of any transaction open at that moment.
  When a store listener dispatches during an outermost commit, the committing
  transaction is already closed, so the action gets `null`.
- `types` lists the events the store prepared. A handler that disposes the
  store stops the rest of the action's events, so those never arrive.
- An event keeps its action alive. An event from `LOAD_CHUNK` or `LOAD_CHUNKS`
  holds the caller's chunk bytes, and the document stores its own copy. An
  event from `APPLY_REMOTE` holds the change set. When you keep events for a
  long time, copy out what you need, such as `origin.action.type`.
- Events created by a factory such as `events.createSelectionChangeEvent` have
  no `origin` unless you pass one as the last argument.

## 4. Read APIs

### 4.1 Query namespace (`query`)

Primary selector namespace for O(1)/O(log n)/bounded operations:

- `getText`, which rejects ranges that split UTF-8 code points and reads the document as `getValue` does: a byte order mark at the start of the file is stripped, so `getText(state, 0, length)` equals `getValue(state)`, and a U+FEFF anywhere else is kept. In chunk mode, a U+FEFF that starts the resident text is stripped only when it starts the file: when every chunk up to and including the one holding it is loaded and every byte before it was deleted. While any chunk before it is not loaded, it belongs to a later chunk and is kept
- `getContentText`, which accepts the same ranges as `getText` and keeps a leading byte order mark as a character. Use it when mapping char positions from `getCharStartOffset`, `findLineAtCharPosition` or `rendering` onto text, since line 0 columns include the byte order mark
- `getLength`, `isUtf8Boundary`, `getBufferStats`
- `findPieceAtPosition`
- `isReconciledState`
- line lookups and offsets:
  - `findLineAtPosition`, `findLineByNumber`, `getLineStartOffset`
  - `getLineRange` (requires eager state)
  - `getLineRangeChecked` (runtime eager assertion)
  - `getLineRangePrecise` (safe on eager/lazy states)
  - `getResidentLineCount`, `getLineCountInfo`, `getLineCount`, `getCharStartOffset`, `findLineAtCharPosition`
- low-level `query.lineIndex.*` selectors

### 4.2 Scan namespace (`scan`)

Traversal namespace for O(n) operations:

- `getValue`, `getValueStream`. Both decode U+FEFF as `query.getText` does: a byte order mark is stripped only when the text starts at offset 0 and that offset is the start of the file. A stream that starts past offset 0 keeps a U+FEFF at its start, so its joined content equals `getText` over the same range
- `collectPieces`, `collectLines`
- `rebuildLineIndex`

### 4.3 Rendering/history/diff namespaces

- `rendering.*`: viewport, visible lines, line/column and selection conversions
  - public results use plain values rather than internal cost brands
  - byte-bearing positions remain `ByteOffset` values
  - viewport line numbers use resident coordinates and expose expected and resident counts separately
- `history.*`: `canUndo`, `canRedo`, `getUndoCount`, `getRedoCount`, `isHistoryEmpty`
- `diff.*`: diff and setValue action synthesis/application helpers

### 4.4 Attention namespace (`attention`)

The `attention` namespace manages piece-anchored references with immutable, caller-owned state. Store actions also maintain `DocumentState.attention` automatically.

- `attention.emptyState`: initial `AttentionLayerState`
- points: `createPoint`, `resolvePoint`
- attentions: `createAttention`, `getAttention`, `deleteAttention`
- resolution/text: `resolveAttention`, `getTextForAttention`
- queries: `findAttentionsAt`, `findAttentionsOverlapping`
- edit support: `insertWithAttention`, `deleteWithAttention`, `migrateSplits`, `migrateDelete`

See [10-attention.md](10-attention.md) for the full design and migration semantics.

### 4.5 Checkpoint namespace (`checkpoint`)

Capture a `DocumentState<'eager'>` as JSON-safe data and load it back:

- `checkpoint.create(state, options?)`: state to `DocumentCheckpoint`
- `checkpoint.restore(checkpoint, restoreOptions?)`: `DocumentCheckpoint` to `DocumentState<'eager'>`
- `checkpoint.encode(state, options?)` / `checkpoint.decode(json, restoreOptions?)`: the same round trip through a string
- `checkpoint.isCheckpoint(value)`: envelope guard for the current version, not full validation
- `checkpoint.isRestorableCheckpoint(value)`: the same guard, also accepting older versions `restore` migrates

Options (`CheckpointOptions`): `mode` (`'exact'` default, `'normalized'`), `compact` (default true).

Restore is fail-closed and raises `CheckpointError` with a stable `code`.

See [11-checkpoint.md](11-checkpoint.md) for the wire format and validation contract.

## 5. Write APIs

- `store.unsafe.documentReducer(state, action)` is pure and immutable.
- `diff.setValue(state, newContent, options?)` returns a new `DocumentState`.
- `diff.computeSetValueActions*` helpers return action lists/diff metadata.

Choose the helper for the state you own.

- `store.setValue(doc, newContent, options?)` updates a live store with notifications, events, and transaction rollback.
- `diff.setValue(state, newContent, options?)` returns a detached state.
- Both helpers default to one changed range. Pass `{ strategy: "diff" }` for finer edit ranges.

## 6. Breaking Changes in 5.0.0

See the [5.0.0 upgrade guide](../docs/breaking-changes/5.0.0.md).
