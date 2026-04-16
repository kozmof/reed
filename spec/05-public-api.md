# Public API Status

## 1. Entry Points

Current public runtime surface is exported from `src/index.ts` as namespaces:

- `store`
- `query`
- `scan`
- `events`
- `rendering`
- `history`
- `diff`
- `position`
- `cost`

Types are exported flat from the same entry file.

Not present in current codebase:

- `reed/read` subpath
- `reed/write` subpath
- `reed/view` subpath
- framework adapter entry points (React/Vue/Svelte)

## 2. Store API (`store` namespace)

### 2.1 `store.createDocumentStore(config?)`

Returns `ReconcilableDocumentStore` with:

- `subscribe(listener)`
- `getSnapshot()`
- `getServerSnapshot()`
- `isCurrentSnapshot(snapshot)`
- `dispatch(action)`
- `batch(actions)`
- `scheduleReconciliation()`
- `reconcileNow()` / `reconcileNow(snapshot)`
- `setViewport(startLine, endLine)`
- `emergencyReset()`

Supported config fields (`DocumentStoreConfig`):

- `content`
- `historyLimit`
- `chunkSize` (reserved; chunk runtime is not implemented)
- `encoding`
- `lineEnding`
- `undoGroupTimeout`

### 2.2 `store.createDocumentStoreWithEvents(config?)`

Wraps the base store and adds:

- `addEventListener(type, handler)`
- `removeEventListener(type, handler)`
- `events` emitter handle

### 2.3 Additional store namespace exports

- `store.withTransaction(store, fn)`
- `store.isDocumentStore(value)`
- `store.DocumentActions`
- `store.serializeAction` / `store.deserializeAction`
- `store.documentReducer`
- immutable state factories/builders
- piece-table and line-index core mutation helpers
- reconciliation helpers (`reconcileRange`, `reconcileFull`, `reconcileViewport`)
- action validators/guards (`isDocumentAction`, `validateAction`, etc.)

## 3. Event Semantics

Supported event types:

- `content-change`
- `selection-change`
- `history-change`
- `save`
- `dirty-change`

Auto-emitted by `store.createDocumentStoreWithEvents`:

- `content-change` (`INSERT/DELETE/REPLACE/APPLY_REMOTE`)
- `selection-change` (`SET_SELECTION`)
- `history-change` (`UNDO/REDO`)
- `dirty-change` (when dirty flag changes)

Note:

- `save` exists as an event type/factory, but is not auto-emitted by reducer/store actions.

## 4. Read APIs

### 4.1 Query namespace (`query`)

Primary selector namespace for O(1)/O(log n)/bounded operations:

- `getText`, `getLength`, `getBufferStats`
- `findPieceAtPosition`
- `isReconciledState`
- line lookups and offsets:
  - `findLineAtPosition`, `findLineByNumber`, `getLineStartOffset`
  - `getLineRange` (requires eager state)
  - `getLineRangeChecked` (runtime eager assertion)
  - `getLineRangePrecise` (safe on eager/lazy states)
  - `getLineCount`, `getCharStartOffset`, `findLineAtCharPosition`
- low-level `query.lineIndex.*` selectors

### 4.2 Scan namespace (`scan`)

Traversal namespace for O(n) operations:

- `getValue`, `getValueStream`
- `collectPieces`, `collectLines`
- `rebuildLineIndex`

### 4.3 Rendering/history/diff namespaces

- `rendering.*`: viewport, visible lines, line/column and selection conversions
- `history.*`: `canUndo`, `canRedo`, `getUndoCount`, `getRedoCount`, `isHistoryEmpty`
- `diff.*`: diff and setValue action synthesis/application helpers

## 5. Write APIs

- `store.documentReducer(state, action)` is pure and immutable.
- `diff.setValue(state, newContent, options?)` returns a new `DocumentState`.
- `diff.computeSetValueActions*` helpers return action lists/diff metadata.

Important behavior:

- `setValue` operates on `DocumentState`, not directly on a store instance.
- For listener/event/transaction semantics, dispatch actions through store methods.

## 6. Not Yet Implemented on Public Surface

- Real chunk loading/eviction runtime behavior
- Collaboration transport/provider integration
- Framework adapters
