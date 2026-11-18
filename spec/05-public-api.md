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
- `logger` — optional diagnostics sink. Omit it to keep the library silent
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
`scheduler`, and `historyEvictionPolicy`. The policy, when given, replaces the one in the
checkpoint; a version 1 checkpoint stores none and otherwise restores with `'pin-bounded'`. Other
state-bearing options come from the checkpoint, and passing one throws.

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

Config (`ChunkManagerConfig`): `maxLoadedChunks`, `fetchStrategy`, `logger`.

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
- `selection-change` (`SET_SELECTION`, and any other action that moves the selection: `INSERT`/`DELETE`/`REPLACE`/`APPLY_REMOTE` moving it past the edit, `UNDO`/`REDO`, `LOAD_CHUNK`/`LOAD_CHUNKS`/`EVICT_CHUNK`/`EVICT_CHUNKS`)
- `history-change` (`UNDO/REDO`)
- `history-drop` (`EVICT_CHUNK` or `EVICT_CHUNKS` when the `'drop'` policy, or `'pin-bounded'` with `overLimit` or through `EVICT_CHUNKS`, discards entries; `UNDO` or `REDO` when the next entry no longer resolves inside the document, which drops it and the rest of its stack)
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

## 4. Read APIs

### 4.1 Query namespace (`query`)

Primary selector namespace for O(1)/O(log n)/bounded operations:

- `getText`, which rejects ranges that split UTF-8 code points and reads the document as `getValue` does: a byte order mark at the start of the file is stripped, so `getText(state, 0, length)` equals `getValue(state)`, and a U+FEFF anywhere else is kept. In chunk mode, while chunk 0 is not loaded, a U+FEFF that starts the resident text belongs to a later chunk and is kept
- `getContentText`, which takes the same ranges as `getText` but reads the text as the line index counts it: a leading byte order mark is kept as a character. Use it when mapping char positions from `getCharStartOffset`, `findLineAtCharPosition` or `rendering` onto text, since line 0 columns include the byte order mark
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

Anchored history positions (chunk-safe undo and redo) change the meaning of exported types:

- `HistoryChange.position` is an anchored position (`HistoryAnchor`), not a `ByteOffset`. In a chunked document it is the resident offset minus the lengths of loaded chunks at or below `afterChunk`, and it can be negative. Resolve it against the current document rather than using it as an offset.
- `HistoryEntry.selectionBefore` and `selectionAfter` are `HistorySelectionState` (anchored positions with placement keys), not `SelectionState`.
- `HistoryChange` gains `afterChunk`, and may carry `bytes` (and `oldBytes` on a replace) when its decoded text does not encode back to the bytes it stands for.
- `AddPieceNode` gains `afterChunk`.
- `SelectionRange` gains optional `anchorAfterChunk` and `headAfterChunk`, present on a range next to a chunk that is not loaded. A test that compares a selection range with `toEqual({ anchor, head })` sees them there.
- `HistoryState` gains `evictionPolicy`.
- `EVICT_CHUNK` can be refused because of history. Under the default `historyEvictionPolicy` (`"pin-bounded"`), it leaves a chunk loaded while undo or redo history points inside it, including after the edit there has been undone. In 4.x it evicted such a chunk regardless of history. Code that evicts chunks itself, without a ChunkManager, should check `store.didEvict` and either pass `overLimit: true` (`DocumentActions.evictChunk(index, true)`) to evict anyway and discard that history, or set `historyEvictionPolicy: "drop"`. Code that evicts to stay within a limit of loaded chunks can send `EVICT_CHUNKS` (`DocumentActions.evictChunks(candidates, maxLoaded)`), which ChunkManager uses: it evicts candidates that cost no history first and applies the policy to the rest.
- `INSERT`, `DELETE`, and `REPLACE` move `state.selection` past the edit. An endpoint before the edit stays, and one after the removed range shifts by the change in length. A caret, or the start of a range, at the edit's start or inside the removed range goes after the inserted text. The end of a non-empty range at the edit's start or inside the removed range stays at the start, before the inserted text, so a range never grows to take in text inserted at its edge: with `{ anchor: 2, head: 5 }`, inserting 2 bytes at 5 leaves the head at 5. A range wholly inside the removed range collapses to a caret after the inserted text. The inline `selection` of an edit is the selection the edit comes from, not the one stored: it is moved the same way. In 4.x an edit stored the inline selection as given and otherwise left `state.selection` alone, so a caret at 20 now becomes 23 after inserting 3 bytes at 10. Callers that set the selection after each edit can keep doing so. Callers that relied on it staying put must save and restore it themselves.
- `APPLY_REMOTE` moves `state.selection` past each remote change the same way, except that a caret where a change inserts text stays before that text. In 4.x it left `state.selection` alone.
- `REDO` restores the selection the edit left, not a caret at the end of the redone change. `UNDO` still restores the selection the edit came from.
- `selection-change` fires whenever an action replaces the selection, including `INSERT`, `DELETE`, `REPLACE`, `APPLY_REMOTE`, `UNDO`, and `REDO`.
- `rendering` (`getLineContent`, `getVisibleLines`, `getVisibleLine`) keeps a byte order mark at the start of the file as a U+FEFF at line 0, column 0, so line content agrees with the columns the line index counts. In 4.x it was stripped from line 0. Code that copies rendered line text or measures its width and does not want the mark should drop a leading U+FEFF from line 0 itself.
- `UNDO` and `REDO` never apply an entry that no longer resolves inside the document. They drop it, together with the entries behind it on the same stack, leave the document unchanged, and emit `history-drop` instead of `history-change`. In 4.x such an entry was clamped to the document and applied.
- Checkpoints are written as version 2. Restore still reads version 1. `isCheckpoint` still accepts only the version the library writes, so a stored version 1 checkpoint now fails it; use `isRestorableCheckpoint` to accept every version `restore` can read.
