# Public API Status

## 1. Entry Points

Current public surface is exported from `src/index.ts`.

It re-exports:
- core state/action/store types
- branded position helpers (`byteOffset`, `charOffset`, etc.)
- store factories (`createDocumentStore`, `createDocumentStoreWithEvents`)
- action creators (`DocumentActions`)
- reducer/state factories
- piece-table and line-index operations
- diff and `setValue` helpers
- events and rendering selectors
- transaction/history helpers
- complexity namespaces: `query` and `scan`

Not present in current codebase:
- `reed/read` subpath
- `reed/write` subpath
- `reed/view` subpath
- framework adapter entry points (React/Vue/Svelte)

## 2. Store API

### 2.1 `createDocumentStore(config?)`

Returns `ReconcilableDocumentStore` with:
- `subscribe(listener)`
- `getSnapshot()`
- `getServerSnapshot()`
- `dispatch(action)`
- `batch(actions)`
- `scheduleReconciliation()`
- `reconcileNow()`
- `setViewport(startLine, endLine)`

Supported config fields (`DocumentStoreConfig`):
- `content`
- `historyLimit`
- `chunkSize` (reserved; chunk runtime is not implemented)
- `encoding`
- `lineEnding`
- `undoGroupTimeout`

### 2.2 `createDocumentStoreWithEvents(config?)`

Wraps the base store and adds:
- `addEventListener(type, handler)`
- `removeEventListener(type, handler)`
- `events` emitter handle

Supported event types in the emitter:
- `content-change`
- `selection-change`
- `history-change`
- `save`
- `dirty-change`

Auto-emitted by dispatch wrapper:
- `content-change` (local `INSERT/DELETE/REPLACE`)
- `selection-change` (`SET_SELECTION`)
- `history-change` (`UNDO/REDO`)
- `dirty-change` (when dirty flag changes)

Current caveat:
- `content-change` is emitted for local text-edit actions (`INSERT/DELETE/REPLACE`) but not for `APPLY_REMOTE`.

## 3. Action API

`DocumentActions` currently includes:
- text edits: `insert`, `delete`, `replace`
- selection: `setSelection`
- history: `undo`, `redo`, `historyClear`
- transaction control: `transactionStart`, `transactionCommit`, `transactionRollback`
- collaboration primitive: `applyRemote`
- chunk primitives: `loadChunk`, `evictChunk`

Notes:
- Transaction actions are interpreted in the store layer, not reducer state transitions.
- `LOAD_CHUNK` / `EVICT_CHUNK` are reducer stubs right now.

## 4. Read APIs

### 4.1 Query namespace (`query`)

Primary selector namespace for O(1)/O(log n)/bounded operations:
- `getLength`, `getText`, `getBufferStats`
- `findPieceAtPosition`, `findLineAtPosition`
- `getLineRange`, `getLineRangePrecise`, `getLineCount`
- `getLineContent`, `getVisibleLine`, `getVisibleLines`
- `positionToLineColumn`, `lineColumnToPosition`

### 4.2 Scan namespace (`scan`)

Traversal namespace for O(n) operations:
- `getValue`, `getValueStream`
- `collectPieces`, `collectLines`
- `rebuildLineIndex`

## 5. Write APIs

- `documentReducer(state, action)` is pure and immutable.
- `setValue(state, newContent, options?)` returns a new `DocumentState`.
- `computeSetValueActions(oldContent, newContent)` and optimized variants return action lists.

Important behavior:
- `setValue` operates on `DocumentState`, not directly on `DocumentStore`.
- For store semantics (listener batching, transaction flow), callers should dispatch actions through store methods.

## 6. Rendering Utilities

`src/store/features/rendering.ts` exports selector-style rendering helpers:
- viewport line range calculation
- visible line extraction
- line-height/total-height estimation
- byte<->line/column conversion
- selection byte/char conversions

This is utility-layer rendering only; there is no DOM `EditorView` implementation yet.
