# Core Architecture

## 1. Current Document Model

Reed is an **immutable state + reducer + store** system with a namespaced API surface.

- Text storage: piece table (`src/store/core/piece-table.ts`)
- Line model: separate line-index tree (`src/store/core/line-index.ts`)
- State transition: pure reducer (`src/store/features/reducer.ts`)
- Runtime orchestration: store factory + transaction manager (`src/store/features/store.ts`)
- Background maintenance: reconciliation scheduler + add-buffer compaction (`src/store/features/reconciliation-scheduler.ts`)
- Public runtime access: `store/query/scan/events/rendering/history/diff/position/cost` namespaces (`src/api/*`)

The piece table and line index remain independent structures. Piece nodes do not store line metadata.

A third core layer — the **attention layer** (`src/store/core/attention.ts`) — provides piece-anchored boundary references that survive tree rebalancing. It is implemented, tested, and exposed via the public `attention` namespace; see [10-attention.md](10-attention.md).

## 2. Core Data Structures

### 2.1 Piece Table

`PieceTableState` contains:

- `root: PieceNode | null`
- `originalBuffer: Uint8Array` (immutable)
- `addBuffer: GrowableBuffer` (append-only, structural sharing)
- `totalLength: number`
- chunk-streaming fields (`chunkMap`, `chunkSize`, `loadedChunks`, `chunkMetadata`, `totalFileSize`)

`PieceNode` is immutable and stores:

- `bufferType`, `start`, `length`
- `left`, `right`, `color`
- cached subtree metadata (`subtreeLength`, `subtreeAddLength`)

Notes:

- Parent pointers are intentionally not used.
- Updates are path-copy operations with structural sharing.

### 2.2 Line Index

`LineIndexState<M extends 'eager' | 'lazy'>` contains:

- `root: LineIndexNode<M> | null`
- `lineCount`
- `dirtyRanges` (guaranteed empty in eager mode)
- `lastReconciledVersion`
- `rebuildPending`

`LineIndexNode` stores:

- `documentOffset` (`number` in eager mode, `number | null` in lazy mode)
- `lineLength`, `charLength`
- subtree metadata (`subtreeLineCount`, `subtreeByteLength`, `subtreeCharLength`)

## 3. Update Model

### 3.1 Local edits

`INSERT` / `DELETE` / `REPLACE` flow:

1. Validate/clamp positions in reducer.
2. Update piece table.
3. Update line index via lazy strategy for normal editing.
4. Force line-index rebuild for CRLF boundary-sensitive delete cases.
5. Push history entry (with coalescing).
6. Increment version and mark dirty.

### 3.2 Undo/redo

`UNDO` / `REDO` reconcile line index to eager before replay and then apply inverse/forward history changes.

### 3.3 Remote edits

`APPLY_REMOTE` applies insert/delete changes to piece table + lazy line index, marks dirty, increments version, and does not push history.

## 4. Store Runtime

`store.createDocumentStore()` provides:

- `subscribe`, `getSnapshot`, `getServerSnapshot`
- `isCurrentSnapshot`
- `dispatch`, `batch`
- explicit transaction controls: `beginTransaction`, `commitTransaction`, `rollbackTransaction`
- `scheduleReconciliation`, `reconcileNow`, `setViewport`
- `reconcileIfCurrent`, `getEagerSnapshot`, `whenReconciled`
- `emergencyReset`

`store.withTransaction(store, fn)` provides scoped transaction execution with rollback safety.

Transaction control actions (`TRANSACTION_START/COMMIT/ROLLBACK`) are handled at store level, not reducer level.

`store.createDocumentStoreWithEvents()` wraps the base store with typed event emission.

## 5. Implemented

Implemented:

- Immutable core state factories
- Piece table insert/delete/read operations
- Separate line-index tree with lazy/eager reconciliation
- Undo/redo/history and transactions
- Chunk loading/eviction runtime and high-level streaming loader
- Typed events and query/scan API namespaces
- Snapshot-gated reconciliation (`isCurrentSnapshot` + `reconcileIfCurrent(snapshot)`)

## 6. Current Gap Summary

Previously tracked core consistency gaps (`getLineRangePrecise` lazy offset issue, missing `batch()` reconciliation scheduling, missing remote content-change emission, incorrect `affectedRanges` for multi-change `APPLY_REMOTE` batches) are fixed in current code.

No core consistency gaps are currently tracked. Both the functional and perf suites pass (see [06-testing.md](06-testing.md) for the latest verified run).
