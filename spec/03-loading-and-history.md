# Loading & History Status

## 1. Loading / Large-Document Capabilities

### 1.1 Implemented

- Streaming full text via generator:
  - `getValueStream(state.pieceTable, options)`
  - supports `chunkSize`, `start`, `end`
- Add-buffer waste introspection and compaction:
  - `getBufferStats`
  - `compactAddBuffer`

### 1.2 Partially Implemented / Stubbed

- Action types exist for chunk management:
  - `LOAD_CHUNK`
  - `EVICT_CHUNK`
- Reducer currently treats both as no-ops.

### 1.3 Not Implemented

- Real chunk fetch/load subsystem
- LRU cache manager
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
- coalescing logic for consecutive edits (timeout-based)
- selection restoration on undo/redo

Transaction behavior:
- store-level transaction manager tracks depth/snapshots
- `batch()` executes actions inside transaction and notifies listeners once
- rollback restores snapshot

Important current behavior:
- `batch()` does **not** currently collapse all actions into one history entry; each action still contributes history.

## 4. Related Events

`createDocumentStoreWithEvents` emits:
- `content-change` for local text edit actions
- `selection-change`
- `history-change`
- `dirty-change`

Remote action caveat:
- `APPLY_REMOTE` changes content in reducer but does not currently emit `content-change` in event wrapper.
