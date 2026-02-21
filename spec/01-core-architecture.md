# Core Architecture

## 1. Current Document Model

Reed is currently an **immutable state + reducer + store** system.

- Text storage: piece table (`src/store/core/piece-table.ts`)
- Line model: separate line-index tree (`src/store/core/line-index.ts`)
- State transition: pure reducer (`src/store/features/reducer.ts`)
- Runtime orchestration: store factory (`src/store/features/store.ts`)

The piece table and line index are independent structures. Piece nodes do not store line metadata.

## 2. Core Data Structures

### 2.1 Piece Table

`PieceTableState` contains:
- `root: PieceNode | null`
- `originalBuffer: Uint8Array` (immutable)
- `addBuffer: GrowableBuffer` (append-only, structural sharing)
- `totalLength: number`

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
- `dirtyRanges` (empty in eager mode)
- `lastReconciledVersion`
- `rebuildPending`

`LineIndexNode` stores:
- `documentOffset` (nullable in lazy mode)
- `lineLength`, `charLength`
- subtree metadata (`subtreeLineCount`, `subtreeByteLength`, `subtreeCharLength`)

## 3. Update Model

### 3.1 Local edits

`INSERT` / `DELETE` / `REPLACE` flow:
1. Validate/clamp positions in reducer.
2. Update piece table.
3. Update line index via **lazy strategy** for normal editing.
4. Push history entry.
5. Increment version and mark dirty.

### 3.2 Undo/redo

`UNDO` / `REDO` reconcile line index to eager before replay and then apply inverse/forward history changes.

### 3.3 Remote edits

`APPLY_REMOTE` applies insert/delete changes to piece table + lazy line index and does not push history.

## 4. Store Runtime

`createDocumentStore()` provides:
- `subscribe`, `getSnapshot`, `getServerSnapshot`
- `dispatch`, `batch`
- `scheduleReconciliation`, `reconcileNow`, `setViewport`

Transaction control actions (`TRANSACTION_START/COMMIT/ROLLBACK`) are handled at store level, not reducer level.

`createDocumentStoreWithEvents()` wraps the base store with typed event emission.

## 5. Implemented vs Not Implemented

Implemented:
- Immutable core state factories
- Piece table insert/delete/read operations
- Separate line-index tree with lazy/eager reconciliation
- Undo/redo/history and transactions
- Typed events and query/scan API namespaces

Not implemented in current codebase:
- File I/O layer
- Real chunk loader/eviction runtime
- Plugin runtime
- Framework adapters (React/Vue/Svelte/Redux/Zustand)
- CRDT transport/provider bridge

## 6. Known Architecture Gaps

- `getLineRangePrecise` dirty-path offset computation can return incorrect ranges after some lazy multiline edits.
- `batch()` commit path currently does not auto-schedule reconciliation when `rebuildPending` remains true.
