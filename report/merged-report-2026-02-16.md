# Reed Text Editor Library — Consolidated Report

**Date:** 2026-02-16
**Merged from:** 7 reports (2026-01-31 through 2026-02-16)
**Test Status:** 447/447 tests passing (11 test files)
**Total Source Lines:** ~12,900 (implementation + types) + ~3,700 (tests)
**Codebase Version:** `main` branch

---

## 1. Project Overview

Reed is a high-performance text editor library built with Vanilla TypeScript, designed as an embeddable NPM package for browser and desktop (Electron/Tauri) environments. It targets smooth editing of files up to 100MB.

### Architecture

- **Redux-like unidirectional data flow:** Action → Reducer → New State → Listeners
- **Immutable state** with structural sharing via `Object.freeze()` and `readonly` properties
- **Pure reducer** (`documentReducer`) with no side effects
- **Factory functions** (closure-based encapsulation, no classes for store)
- **Zero runtime dependencies** (TypeScript, Vite, Vitest are dev-only)

### Directory Structure

```
src/
  index.ts                  Public API barrel export
  types/
    index.ts                Type barrel export
    branded.ts              Branded numeric types (ByteOffset, CharOffset, etc.)
    state.ts                Core immutable state interfaces
    actions.ts              Action type definitions, type guards, validation
    store.ts                Store and strategy interfaces
  store/
    index.ts                Store barrel export
    core/
      encoding.ts           Shared TextEncoder/TextDecoder singletons
      growable-buffer.ts    Encapsulated append-only buffer
      rb-tree.ts            Generic Red-Black tree utilities
      state.ts              State factory functions (createInitialState, withState, etc.)
      piece-table.ts        Piece table with immutable Red-Black tree
      line-index.ts         Line index with eager/lazy maintenance + reconciliation
    features/
      actions.ts            Action creator factory (DocumentActions)
      history.ts            Undo/redo helper queries
      transaction.ts        Nested transaction manager
      events.ts             Typed event emitter system
      reducer.ts            Pure reducer with unified applyEdit pipeline
      rendering.ts          Virtualized rendering utilities
      diff.ts               Myers diff algorithm + setValue
      store.ts              Store factory (createDocumentStore, createDocumentStoreWithEvents)
```

### Build & Tooling

- **Package Manager:** pnpm
- **Bundler:** Vite 7.x
- **Language:** TypeScript 5.9 (strict mode, `erasableSyntaxOnly`)
- **Testing:** Vitest 4.x
- **Module System:** ESM (`"type": "module"`)

---

## 2. Type System

### Core Type Hierarchy

```
DocumentState (root immutable snapshot)
├── PieceTableState
│     ├── PieceNode (extends RBNode<PieceNode>)
│     │     └── subtreeLength, subtreeAddLength, bufferType, start (ByteOffset), length (ByteLength)
│     ├── originalBuffer: Uint8Array
│     └── addBuffer: GrowableBuffer
├── LineIndexState
│     ├── LineIndexNode (extends RBNode<LineIndexNode>)
│     │     └── subtreeLineCount, subtreeByteLength, documentOffset (number | null), lineLength
│     └── DirtyLineRange[]
├── SelectionState
│     └── SelectionRange (anchor: ByteOffset, head: ByteOffset)
├── HistoryState
│     ├── undoStack/redoStack: HistoryEntry[]
│     │     └── HistoryChange (HistoryInsertChange | HistoryDeleteChange | HistoryReplaceChange)
│     └── limit, coalesceTimeout
└── DocumentMetadata

DocumentAction (discriminated union of 13 action types)
  - INSERT, DELETE, REPLACE (with optional timestamp for deterministic replay)
  - SET_SELECTION, UNDO, REDO, HISTORY_CLEAR
  - TRANSACTION_START, TRANSACTION_COMMIT, TRANSACTION_ROLLBACK
  - APPLY_REMOTE, LOAD_CHUNK, EVICT_CHUNK

DocumentStore (core: subscribe, getSnapshot, dispatch, batch)
└── ReconcilableDocumentStore (adds scheduleReconciliation, reconcileNow, setViewport)
    └── DocumentStoreWithEvents (adds addEventListener, removeEventListener)

LineIndexStrategy (interface for eager/lazy duality)
├── eagerLineIndex (immediate offset recalculation, used for undo/redo)
└── lazyLineIndex (deferred reconciliation, used for normal editing)

Branded Types: ByteOffset, ByteLength, CharOffset, LineNumber, ColumnNumber
```

### Design Patterns

1. **Branded types** (`Branded<T, B>`) — phantom `unique symbol` for compile-time safety between ByteOffset/CharOffset, zero runtime overhead
2. **F-bounded polymorphism** (`RBNode<T extends RBNode<T>>`) — generic RB-tree module works with both PieceNode and LineIndexNode
3. **Discriminated unions** — `DocumentAction` (on `type`), `BufferReference` (on `bufferType`), `HistoryChange` (on `type`)
4. **Narrowed update types** — `withPieceNode` accepts `PieceNodeUpdates` (only settable fields), not `Partial<PieceNode>`
5. **Strategy pattern** — `LineIndexStrategy` separates eager/lazy insert/delete

---

## 3. Core Data Flow

```
createDocumentStore(config)
  └── createInitialState(config)
        ├── createPieceTableState(content)  → textEncoder.encode() + GrowableBuffer
        ├── createLineIndexState(content)   → buildBalancedTree()
        ├── createInitialSelectionState()
        ├── createInitialHistoryState(limit)
        └── createInitialMetadata(config)

store.dispatch(action)
  └── documentReducer(state, action)
        ├── INSERT/DELETE/REPLACE → applyEdit() unified pipeline:
        │     1. Validate position/range
        │     2. Capture text for undo (DELETE/REPLACE)
        │     3. pieceTableDelete (if applicable) → deleteRange → mergeTrees (join-by-black-height)
        │     4. pieceTableInsert (if applicable) → rbInsertPiece → fixInsertWithPath (O(log n))
        │     5. lazyLineIndex.insert/delete → insertLinesStructural (shared logic)
        │     6. historyPush (with deterministic timestamps)
        │     7. Mark dirty + bump version
        ├── UNDO → historyUndo → applyChange(invertChange(change)) → eagerLineIndex
        ├── REDO → historyRedo → applyChange(change) → eagerLineIndex
        ├── APPLY_REMOTE → pieceTableInsert/Delete + lazyLineIndex (no history)
        └── SET_SELECTION, HISTORY_CLEAR, TRANSACTION_*, LOAD/EVICT_CHUNK

store.scheduleReconciliation()
  └── requestIdleCallback → reconcileFull(config)
        ├── Fast path (few dirty lines < threshold): reconcileRange per dirty range — O(k log n)
        └── Slow path (many dirty lines): reconcileInPlace tree walk — O(n) with structural sharing

getVisibleLines(state, viewport)
  └── getLineRangePrecise() → getText() → VisibleLine[]
```

---

## 4. Key Features

### Lazy Line Index Reconciliation
- **Edit time:** `lineIndexInsertLazy` / `lineIndexDeleteLazy` update line counts/lengths, mark downstream offsets dirty
- **Idle time:** `scheduleReconciliation()` → `requestIdleCallback` → `reconcileFull()`
- **Render time:** `reconcileViewport()` ensures visible lines are accurate
- **On-demand:** `getLineRangePrecise()` applies cumulative dirty deltas

### Transaction Support
- `createTransactionManager()` supports nested transactions (snapshot stack)
- `batch()` wraps actions for single-listener-notification and single-undo-unit semantics
- Rollback at any nesting level restores only that level's snapshot

### History Coalescing
- `undoGroupTimeout` config option groups rapid same-type edits into single undo entries
- Optional `timestamp` on actions enables deterministic replay

### Streaming for Large Files
- `getValueStream()` yields `DocumentChunk` objects (default 64KB)
- `compactAddBuffer()` reclaims wasted space

### Event System
- `createDocumentStoreWithEvents()` emits typed events: `content-change`, `selection-change`, `history-change`, `dirty-change`, `save`
- Batch operations emit per-action events in a single pass (no reducer replay)

### Collaboration Hooks
- `APPLY_REMOTE` action processes remote changes (bypasses history)
- `serializeAction` / `deserializeAction` (with validation via `isDocumentAction`)

---

## 5. Open Issues

### 5.1 Selection Not Auto-Updated on Edit
**Severity:** Medium | **First reported:** 2026-02-03

When INSERT or DELETE modifies the document, the reducer does not automatically adjust cursor/selection positions. Consumers must manually dispatch `SET_SELECTION` after every edit. Standard text editor behavior is that inserting text moves the cursor to the end of the inserted content.

**Recommendation:** Add selection transformation logic inside the reducer for INSERT, DELETE, and REPLACE actions that adjusts `anchor`/`head` positions based on the edit range and length delta.

### 5.2 LOAD_CHUNK and EVICT_CHUNK Are No-ops
**Severity:** Medium | **First reported:** 2026-02-03

Both chunk actions return `state` unchanged in the reducer. They are declared in the public API but do nothing. The spec targets 100MB files, but the current approach loads the entire original buffer into memory.

**Recommendation:** Implement Phase 3 chunk management with lazy chunk loading and LRU eviction policy.

### 5.3 History Entries Store Full Text Strings
**Severity:** Low | **First reported:** 2026-02-10

`HistoryChange` stores the full `text` (and `oldText` for replace) as strings. For large deletions/replacements, this can consume significant memory with the default 1000-entry undo stack. The piece table is already append-only, so a more memory-efficient approach could reference buffer ranges.

### 5.4 Serialization Uses `btoa`/`atob` for Binary Data
**Severity:** Low | **First reported:** 2026-02-10

`serializeAction` / `deserializeAction` use `btoa(String.fromCharCode(...))` for `Uint8Array` serialization. The spread operator on large arrays can hit stack size limits. A chunked base64 approach would be safer.

### 5.5 `getLine()` in piece-table.ts Is O(n)
**Severity:** Low | **First reported:** 2026-02-14

`getLine()` uses `findLineOffsets()` which scans all bytes sequentially. The rendering module correctly uses `getLineContent()` (via line index, O(log n)), but `getLine()` remains in the public API and could be misused. Consider deprecation or documentation.

### 5.6 No Dispose/Cleanup on Store
**Severity:** Medium | **First reported:** 2026-02-14

The store schedules background work via `requestIdleCallback`/`setTimeout` but provides no `dispose()` method to cancel pending callbacks. In SPA environments where editor instances are created/destroyed, this can cause memory leaks.

### 5.7 No Error Recovery for Corrupted Tree State
**Severity:** Low | **First reported:** 2026-02-14

If an RB-tree invariant is violated through a bug, there's no validation or self-healing mechanism. A tree integrity check function would help detect corruption early.

### 5.8 Redundant `textEncoder.encode()` in Line Index Path
**Severity:** Low | **First reported:** 2026-02-14 (formalization 4.1)

`pieceTableInsert` encodes text to get bytes, then `lineIndexInsertLazy` → `findNewlineBytePositions` encodes the same text again for newline scanning. The piece table path is resolved (returns `insertedByteLength`), but the line index path remains redundant.

**Recommendation:** Thread encoded bytes from the insert call through the entire pipeline.

### 5.9 `collectPieces()` Materializes Entire Tree
**Severity:** Low | **First reported:** 2026-02-14

`getValue`, `getValueStream`, `compactAddBuffer` call `collectPieces()` which allocates an array of all nodes. An in-order iterator (generator function) would avoid the allocation for large documents.

### 5.10 `byteToCharOffset` Encodes Entire String
**Severity:** Low | **First reported:** 2026-02-14

`byteToCharOffset(text, byteOffset)` calls `textEncoder.encode(text)` on the entire string even when only a prefix is needed. Early termination once the target byte offset is reached would improve performance.

### 5.11 `Object.freeze()` on Every Node Creation
**Severity:** Low | **First reported:** 2026-02-14

Every `createPieceNode`, `withPieceNode`, `createLineIndexNode`, and `withLineIndexNode` call freezes the returned object. While this provides strong immutability guarantees, `Object.freeze()` has measurable overhead in hot paths. Consider making freeze opt-in or development-only.

### 5.12 History Stack Uses Array Spread
**Severity:** Low | **First reported:** 2026-02-14

History operations (`historyPush`, `historyUndo`, `historyRedo`) create new arrays via spread (`[...history.undoStack, entry]`). For large stacks (limit: 1000), this is O(n) per edit. A persistent/immutable data structure (e.g., linked list or functional deque) would reduce this to O(1).

### 5.13 `removeLinesToEnd` Falls Back to O(n) Rebuild
**Severity:** Low | **First reported:** 2026-02-14

`deleteLineRangeLazy` calls `rebuildWithDeletedRange` which uses incremental RB-tree deletion for most cases, but the `removeLinesToEnd` path collects all lines into an array and rebuilds from scratch.

### 5.14 `diff.ts` Has Unused Helper Functions
**Severity:** Low | **First reported:** 2026-02-10

`isLowSurrogate()` and `isHighSurrogate()` are defined in `diff.ts` and used by `computeSetValueActionsOptimized`, but `computeSetValueActions` does not guard against surrogate splitting. The non-optimized path could produce invalid splits on surrogate pairs.

### 5.15 Missing SAVE Action
**Severity:** Low | **First reported:** 2026-02-14

The event system defines `SaveEvent` and `createSaveEvent()`, but there is no corresponding `SAVE` action in the `DocumentAction` union. Save functionality (clearing `isDirty`, setting `lastSaved`) must be handled outside the reducer.

### 5.16 Add Buffer Growth Strategy
**Severity:** Low | **First reported:** 2026-01-31

The add buffer (now `GrowableBuffer`) doubles in size when full. The initial allocation is 1024 bytes (small for large file editing). The buffer is never shrunk automatically. Consider triggering `compactAddBuffer()` when waste ratio exceeds a threshold during idle time.

---

## 6. Design Recommendations (Not Yet Started)

### 6.1 Introduce a Cursor/Position Abstraction Layer
A dedicated `Position` module that encapsulates byte/char conversion and caches results would reduce error-prone manual conversions:
```
Position { byteOffset, charOffset, line, column }
  - fromByte(state, byte) -> Position
  - fromChar(state, char) -> Position
  - fromLineColumn(state, line, col) -> Position
```

### ~~6.2 Separate "Core" from "Features"~~ (Resolved 2026-02-17)
Implemented. `store/` is now split into:
- `store/core/` — encoding, growable-buffer, rb-tree, state, piece-table, line-index (pure data structures, zero feature dependencies)
- `store/features/` — actions, history, transaction, events, reducer, rendering, diff, store (higher-level functionality composing core primitives)

Public API unchanged. All 447 tests passing.

### 6.3 Add a Plugin System Foundation
The spec describes an extensive plugin system, but there are no hooks or extension points. A minimal "middleware" layer for the reducer:
```typescript
type Middleware = (state, action, next) => DocumentState;
```

### 6.4 Implement Chunk Management (Phase 3)
For the 100MB target:
- Lazy chunk loading from `FileSystemHandle` or `ReadableStream`
- LRU eviction policy with configurable memory budget
- Integration with the piece table's `originalBuffer` (make it chunk-aware)

---

## 7. Implementation Status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Core Data Store | Complete | DocumentStore, actions, reducers, applyEdit pipeline |
| Phase 2: Core Document Model | Complete | Piece table, line index, RB-tree operations |
| Phase 3: Large File Support | Not started | LOAD_CHUNK/EVICT_CHUNK are stubs |
| Phase 4: History & Undo | Complete | Undo/redo with coalescing, transaction support |
| Phase 5: Framework Adapters | Not started | React/Vue/Svelte |
| Phase 6: Plugin System | Not started | Spec exists |
| Phase 7: Collaboration (CRDT) | Partial | APPLY_REMOTE exists; no Yjs integration |
| Phase 8: Polish & Optimization | Partial | Many optimizations applied |

---

## 8. Resolved Issues Summary

The following issues have been identified and resolved across the report period (2026-01-31 to 2026-02-16):

### Performance
- `replacePieceInTree` optimized from O(n) to O(log n) using path-based approach
- `fixInsert` replaced with `fixInsertWithPath` for O(log n) RB-tree fix-up
- Line index rebuild optimized with threshold-based incremental approach
- `deleteRange` uses subtree-range pruning: O(n) → O(k + log n)
- `deleteLineRange` replaced O(k log n) loop with O(log n) offset computation
- `mergeTrees` uses proper join-by-black-height algorithm preserving RB invariants
- `reconcileFull` uses two-path strategy: incremental for few dirty lines, in-place walk for many
- `collectBytesInRange` rewritten with pre-allocated `Uint8Array`
- Myers diff uses `Int32Array` instead of `Array` for traces
- `simpleDiff` uses flat `Int32Array` instead of 2D array
- `compactAddBuffer` uses single-pass instead of two passes
- `selectionToCharOffsets` uses line index for O(k log n) instead of O(n)
- `getLineCount` removed (O(n) scan); use `getLineCountFromIndex` (O(1))
- `getBufferStats` uses `subtreeAddLength` aggregate field: O(n) → O(1)
- Module-level `TextEncoder`/`TextDecoder` singletons in shared `encoding.ts`
- `pieceTableInsert` returns `insertedByteLength` directly (no redundant encoding)
- Redundant `textEncoder.encode()` eliminated in reducer INSERT/REPLACE handlers
- `mergeDirtyRanges` adds safety cap (>32 ranges → collapse to single range)

### Type Safety
- All position parameters use `ByteOffset` branded type throughout
- `SelectionRange` uses `ByteOffset` for anchor/head
- `PieceNode.start` branded as `ByteOffset`, `PieceNode.length` as `ByteLength`
- `RBNode<T>` uses proper F-bounded constraint (no `any` default)
- `HistoryChange` is a proper discriminated union (3 interfaces)
- `withPieceNode` / `withLineIndexNode` accept narrowed update types
- `getLineRange` returns branded `ByteOffset`/`ByteLength`
- `DirtyLineRange.endLine` uses `Number.MAX_SAFE_INTEGER` instead of string sentinel
- `DocumentEvent.type` narrowed to `keyof DocumentEventMap`
- `BufferReference.bufferType` consistent with `PieceNode.bufferType`
- `CharSelectionRange` type added with conversion helpers
- `collectPieces()`, `collectLines()`, `mergeDirtyRanges()` return `readonly` arrays
- Action creators return `Object.freeze()`-d objects
- `InsertAction` uses `start` consistently (not `position`)
- `ActionValidationResult` and `validateAction()` for runtime validation
- `deserializeAction` validates via `isDocumentAction` before returning
- `as const` assertions removed from action creators (redundant with explicit return types)

### Architecture
- `GrowableBuffer` class encapsulates append-only buffer invariant
- `createTransactionManager()` extracted as standalone module with snapshot stack
- `applyEdit()` unified pipeline for INSERT/DELETE/REPLACE in reducer
- `invertChange()` extracted; `applyInverseChange` = `applyChange(invertChange(change))`
- `insertLinesStructural` / `appendLinesStructural` shared between eager/lazy paths
- `LineIndexStrategy` operates on `LineIndexState` directly
- `DocumentStore` / `ReconcilableDocumentStore` interface separation
- `withLineIndexState()` centralized construction helper
- `ReconciliationConfig.thresholdFn` makes reconciliation strategy injectable
- Action `timestamp` field enables deterministic replay
- Empty-document sentinel uses real zero-length node instead of `root: null`
- `documentOffset: number | null` (idiomatic) instead of `number | 'pending'`
- Batch event emission uses single-pass dispatch (no reducer replay)
- Transaction rollback notifies listeners
- `.bind()` no-ops removed from event adapter
- `findNewlineBytePositions` operates on UTF-8 bytes (not string indices)
- Undo/redo uses eager line index for immediate accuracy
- `reconcileFull` updates `lastReconciledVersion`
- `getAffectedRange` for REPLACE returns actual new content range
- Undo grouping via `undoGroupTimeout` config option
- Nested transaction rollback uses snapshot stack (inner rollback preserves outer changes)
- `HistoryChange.byteLength` field for cached computation (removed redundant `oldTextByteLength`)

---

## 9. Learning Paths

### Recommended Reading Order

```
1. types/branded.ts          → Branded numeric type safety system
2. types/state.ts            → Immutable state model (DocumentState hierarchy)
3. types/actions.ts          → Action discriminated union (13 types)
4. types/store.ts            → Store/ReconcilableDocumentStore/LineIndexStrategy interfaces
5. store/encoding.ts         → Shared TextEncoder/TextDecoder
6. store/growable-buffer.ts  → Encapsulated append-only buffer
7. store/state.ts            → Factory functions, withState/withPieceNode helpers
8. store/rb-tree.ts          → Generic RB-tree (rotations, fixInsertWithPath)
9. store/piece-table.ts      → Core: insert, delete, getValue, streaming
10. store/line-index.ts      → Line tracking, eager vs lazy, reconciliation
11. store/reducer.ts         → Unified applyEdit pipeline, invertChange, history
12. store/transaction.ts     → Nested transaction state machine
13. store/store.ts           → Store factory, reconciliation scheduling
14. store/events.ts          → Event system for reactive consumers
15. store/rendering.ts       → Virtualization, viewport management
16. store/diff.ts            → Myers diff, setValue functionality
```

### Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| Two separate RB-trees | Piece table indexes by byte offset; line index indexes by line number. Independent update strategies (lazy vs eager). |
| UTF-8 byte offsets internally | Avoids UTF-16 surrogate pair complexity. Piece table stores raw bytes (`Uint8Array`). |
| Immutable state + structural sharing | O(1) snapshot creation, time-travel debugging, safe concurrent reads. Each edit creates O(log n) new nodes. |
| Factory functions, not classes | Closure-based encapsulation provides true privacy without `#private` fields. |
| Lazy/eager line index duality | Lazy for throughput during rapid typing; eager for correctness during undo/redo. |
| `applyEdit` unified pipeline | Single code path for INSERT/DELETE/REPLACE prevents symmetry drift. |

---

*Consolidated from reports: code-analysis-2026-01-31, code-analysis-2026-02-03, code-analysis-2026-02-06, code-analysis-2026-02-10, code-analysis-2026-02-14, formalization-2026-02-14, formalization-2026-02-15 (updated 2026-02-16)*
*Generated on 2026-02-16*
