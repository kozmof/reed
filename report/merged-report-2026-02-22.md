# Reed Text Editor Library — Consolidated Report

**Date:** 2026-02-22
**Merged from:** 6 reports (2026-02-16 through 2026-02-21)
**Test Status:** 465/465 tests passing (11 test files)
**Codebase Version:** `main` branch

---

<!-- ============================================================ -->
<!-- SOURCE: merged-report-2026-02-16.md                          -->
<!-- Period: 2026-01-31 through 2026-02-16 (7 prior reports)      -->
<!-- ============================================================ -->

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
  api/
    index.ts                API namespace barrel
    query.ts                O(log n) / O(1) operations
    scan.ts                 O(n) operations
  types/
    index.ts                Type barrel export
    branded.ts              Branded numeric types (ByteOffset, CharOffset, etc.)
    cost.ts                 Cost algebra, Ctx pipeline, CostFn, Costed<L,T>
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
DocumentState<M> (root immutable snapshot)
├── PieceTableState
│     ├── PieceNode (extends RBNode<PieceNode>)
│     │     └── subtreeLength, subtreeAddLength, bufferType, start (ByteOffset), length (ByteLength)
│     ├── originalBuffer: Uint8Array
│     └── addBuffer: GrowableBuffer
├── LineIndexState<M extends EvaluationMode>
│     ├── LineIndexNode<M>
│     │     └── subtreeLineCount, subtreeByteLength, subtreeCharLength,
│     │         documentOffset (M='eager': number, M='lazy': number | null),
│     │         lineLength, charLength
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

LineIndexStrategy<M> (interface for eager/lazy duality)
├── eagerLineIndex (immediate offset recalculation, used for undo/redo)
└── lazyLineIndex (deferred reconciliation, used for normal editing)

Branded Types: ByteOffset, ByteLength, CharOffset, LineNumber, ColumnNumber
Cost Types: ConstCost<T>, LogCost<T>, LinearCost<T>, NLogNCost<T>, QuadCost<T>
```

### Design Patterns

1. **Branded types** (`Branded<T, B>`) — phantom `unique symbol` for compile-time safety between ByteOffset/CharOffset, zero runtime overhead
2. **Cost contracts** (`Costed<Level, T>`) — phantom cost brands with natural widening via `LevelsUpTo<L>` union
3. **F-bounded polymorphism** (`RBNode<T extends RBNode<T>>`) — generic RB-tree module works with both PieceNode and LineIndexNode
4. **Discriminated unions** — `DocumentAction` (on `type`), `BufferReference` (on `bufferType`), `HistoryChange` (on `type`)
5. **Narrowed update types** — `withPieceNode` accepts `PieceNodeUpdates` (only settable fields), not `Partial<PieceNode>`
6. **Strategy pattern** — `LineIndexStrategy<M>` separates eager/lazy insert/delete; mode is a type parameter
7. **Parametric evaluation mode** — `LineIndexState<M>` and `DocumentState<M>` carry `'eager' | 'lazy'` at type level; `getLineRange` requires `<'eager'>`, `reconcileNow()` returns `<'eager'>`
8. **Namespace stratification** — `query.*` (O(log n)/O(1)) and `scan.*` (O(n)) as additive complexity-stratified API layers

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
- **On-demand:** `getLineRangePrecise()` uses `getLineStartOffset` (subtree aggregates, always accurate)

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

### Complexity-Transparent Public API
- `query.*` namespace: O(log n) and O(1) operations (`getText`, `getLineContent`, `getLength`, etc.)
- `scan.*` namespace: O(n) operations (`getValue`, `collectPieces`, `getValueStream`)
- Cost-branded return types: `ConstCost<T>`, `LogCost<T>`, `LinearCost<T>` on key functions
- `getLine` removed from public API; renamed `getLineLinearScan` (internal/test only)

---

## 5. Open Issues

### 5.1 Selection Not Auto-Updated on Edit
**Severity:** Medium | **First reported:** 2026-02-03

When INSERT or DELETE modifies the document, the reducer does not automatically adjust cursor/selection positions. Consumers must manually dispatch `SET_SELECTION` after every edit.

**Recommendation:** Add selection transformation logic inside the reducer for INSERT, DELETE, and REPLACE actions.

### 5.2 LOAD_CHUNK and EVICT_CHUNK Are No-ops
**Severity:** Medium | **First reported:** 2026-02-03

Both chunk actions return `state` unchanged. The spec targets 100MB files, but the current approach loads the entire original buffer into memory.

**Recommendation:** Implement Phase 3 chunk management with lazy chunk loading and LRU eviction policy.

### 5.3 History Entries Store Full Text Strings
**Severity:** Low | **First reported:** 2026-02-10

`HistoryChange` stores full `text` strings. For large deletions/replacements with the default 1000-entry undo stack, this can consume significant memory.

### 5.4 Serialization Uses `btoa`/`atob` for Binary Data
**Severity:** Low | **First reported:** 2026-02-10

`serializeAction` / `deserializeAction` use `btoa(String.fromCharCode(...))`. The spread operator on large arrays can hit stack size limits.

### ~~5.5 `getLine()` in piece-table.ts Is O(n)~~ (Resolved 2026-02-18)
Renamed to `getLineLinearScan`, removed from public API.

### 5.6 No Dispose/Cleanup on Store
**Severity:** Medium | **First reported:** 2026-02-14

The store schedules background work via `requestIdleCallback`/`setTimeout` but provides no `dispose()` method to cancel pending callbacks. In SPA environments, this can cause memory leaks.

### 5.7 No Error Recovery for Corrupted Tree State
**Severity:** Low | **First reported:** 2026-02-14

If an RB-tree invariant is violated through a bug, there's no validation or self-healing mechanism.

### 5.8 Redundant `textEncoder.encode()` in Line Index Path
**Severity:** Low | **First reported:** 2026-02-14

`lineIndexInsertLazy` → `findNewlineBytePositions` encodes the same text again for newline scanning (piece table path resolved; line index path remains).

**Recommendation:** Thread encoded bytes from the insert call through the entire pipeline.

### 5.9 `collectPieces()` Materializes Entire Tree
**Severity:** Low | **First reported:** 2026-02-14

An in-order iterator (generator function) would avoid the full-array allocation for large documents.

### 5.10 `byteToCharOffset` Encodes Entire String
**Severity:** Low | **First reported:** 2026-02-14

Early termination once the target byte offset is reached would improve performance.

### 5.11 `Object.freeze()` on Every Node Creation
**Severity:** Low | **First reported:** 2026-02-14

`Object.freeze()` has measurable overhead in hot paths. Consider making freeze opt-in or development-only.

### 5.12 History Stack Uses Array Spread
**Severity:** Low | **First reported:** 2026-02-14

O(n) per edit for large stacks. A persistent/immutable data structure would reduce this to O(1).

### 5.13 `removeLinesToEnd` Falls Back to O(n) Rebuild
**Severity:** Low | **First reported:** 2026-02-14

The `removeLinesToEnd` path in `deleteLineRangeLazy` collects all lines into an array and rebuilds from scratch.

### 5.14 `diff.ts` Has Unsafe Non-Optimized Path
**Severity:** Medium | **First reported:** 2026-02-10, confirmed 2026-02-21

`computeSetValueActions` (non-optimized path, used when `useReplace: false`) does not guard against surrogate splitting. `computeSetValueActionsOptimized` does include surrogate guards. The two paths have incompatible coordinate safety models.

**Recommendation:** Add surrogate boundary protection to the minimal diff path, or automatically fall back to the optimized path when unsafe code-unit boundaries are detected.

### 5.15 Missing SAVE Action
**Severity:** Low | **First reported:** 2026-02-14

`SaveEvent` and `createSaveEvent()` exist, but there is no corresponding `SAVE` action in the `DocumentAction` union.

### 5.16 Add Buffer Growth Strategy
**Severity:** Low | **First reported:** 2026-01-31

The add buffer doubles in size when full but is never shrunk automatically. Consider triggering `compactAddBuffer()` when waste ratio exceeds a threshold during idle time.

### 5.17 `batch()` Does Not Schedule Reconciliation at Outer Commit
**Severity:** Medium | **First reported:** 2026-02-21

Non-transaction dispatch schedules reconciliation when `rebuildPending` (`store.ts:139`). The `TRANSACTION_COMMIT` branch only notifies listeners and returns (`store.ts:109`). Since `batch()` is implemented using transaction start/commit, post-batch `rebuildPending` state is never serviced by the background scheduler.

**Recommendation:** In the `TRANSACTION_COMMIT` branch, schedule reconciliation when the outermost commit leaves `rebuildPending` true.

### 5.18 `APPLY_REMOTE` Does Not Emit `content-change` Event
**Severity:** Medium | **First reported:** 2026-02-21

Event emission for `content-change` is keyed only on `isTextEditAction` (INSERT/DELETE/REPLACE). `APPLY_REMOTE` changes content in the reducer but is excluded from that event path, so collaboration consumers receive no notification.

**Recommendation:** Extend `emitEventsForAction` to handle `APPLY_REMOTE` as a content change, or introduce a broader `isContentMutationAction` predicate.

### 5.19 Branded Type Erosion via `as number` Casts
**Severity:** Medium | **First reported:** 2026-02-18, confirmed 2026-02-21

16+ call sites strip brands with `as number` (rendering.ts, reducer.ts, piece-table.ts, line-index.ts). The branded type system becomes decorative rather than protective as new code proliferates this pattern.

**Recommendation:** Add `addByteOffset(offset, length: ByteLength)` overloads and a `byteEnd(start, length): ByteOffset` helper to eliminate the recurring cast pattern.

### 5.20 `deleteRange` Does Not Rebalance the Piece Table Tree
**Severity:** Medium | **First reported:** 2026-02-18

`deleteRange` trims or removes nodes without R-B rebalancing (no equivalent to `rbDeleteLineByNumber`'s `fixDeleteViolations`). After heavy edit-delete cycles, tree height may grow beyond O(log n).

### 5.21 `reconcileNow` Increments `version` for Non-Content Change
**Severity:** Low | **First reported:** 2026-02-18

Reconciliation corrects internal bookkeeping (line offsets) without changing document content, yet it increments `version`. Subscribers using `version` for content-change detection will see phantom changes.

### 5.22 `batch` Contract and Behavior Diverge
**Severity:** Low | **First reported:** 2026-02-21

The store interface says batched actions form a single undo unit (`store.ts:63`). Tests show per-action history entries in a batch (`store.usecase.test.ts:206`). API users can mis-assume undo behavior.

### 5.23 Build Script Mismatch for Repository Shape
**Severity:** Low | **First reported:** 2026-02-21

`pnpm build` fails because Vite expects `index.html` (app build) while the repo is library-first. Library-only typecheck/build targets should be separated from optional app preview targets.

---

## 6. Resolved Issues Summary

### Resolved Through 2026-02-16

**Performance**
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

**Type Safety**
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

**Architecture**
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
- `store/` split into `core/` (pure data structures) and `features/` (higher-level functionality)

### Resolved 2026-02-16 to 2026-02-18 (Transparent Complexity & Formalization)

- **Proposal A** — Cost-branded return types (`ConstCost<T>`, `LogCost<T>`, `LinearCost<T>`) with numeric `CostBrand<Level>` for automatic widening
- **Proposal B** — Namespace-stratified API: `query.*` (O(log n)/O(1)), `scan.*` (O(n)); flat exports preserved
- **Proposal C** — `EvaluationMode` type parameter on `LineIndexState<M>` and `DocumentState<M>`; `getLineRange` requires `<'eager'>`; `reconcileNow()` returns `<'eager'>`; `LineIndexNode<M>` parameterized; `LineIndexStrategy<M>` input mode-matched
- **Proposal D** — `getLine` renamed `getLineLinearScan`, removed from public API
- `byteOffsetToCharOffset` — now O(log n + line_length) via `subtreeCharLength` aggregate + `getCharStartOffset` tree descent
- `charOffsetsToSelection` — now O(log n + line_length) via `findLineAtCharPosition` tree descent
- `getLineContent` in rendering.ts migrated to `getLineRangePrecise` (safe on lazy state)
- Undo/redo path explicitly reconciles lazy → eager state before applying eager strategy
- `withLineIndexState` made generic to preserve mode parameter through updates

### Resolved 2026-02-21 (cost.ts Analysis)

- **P1** — `$binarySearch` replaced `indexOf` (O(n)) with proper binary search loop (O(log n))
- **P2** — `castCost` dead if-chain removed; `level` parameter renamed `_level`
- **P3** — `$mapN` combinator added alongside `$forEachN` for element-wise mapping with result collection
- **P4** — `$map` return type simplified from `Ctx<Seq<C, C_CONST>, U>` to `Ctx<C, U>`
- **P5** — Duplicate export paths: cost re-export block removed from `branded.ts`; import sites updated
- **D1** — Redundant Costed-value combinators (`$mapCost`, `$chainCost`, `$zipCost`, `$composeCostFn`) removed; Ctx pipeline is now the single composition model
- **D3** — `$pipe` overloads constrained to `Ctx`-typed steps; raw functions rejected at compile time

### Resolved 2026-02-22 (Code Analyze — P0)

- **P0** — `getLineRangePrecise` dirty-path double-correction removed. `withLineIndexNode` keeps `subtreeByteLength` current on every tree mutation, so `getLineStartOffset` (subtree aggregate) is authoritative in all states. Dirty delta overlay was incorrect and produced wrong visible lines after inserts.

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
| Phase 7: Collaboration (CRDT) | Partial | APPLY_REMOTE exists; no Yjs integration; content-change event missing for remote |
| Phase 8: Polish & Optimization | Partial | Many optimizations applied; see open issues |

---

## 8. Design Recommendations (Not Yet Started)

### 8.1 Introduce a Cursor/Position Abstraction Layer
A dedicated `Position` module that encapsulates byte/char conversion and caches results:
```
Position { byteOffset, charOffset, line, column }
  - fromByte(state, byte) -> Position
  - fromChar(state, char) -> Position
  - fromLineColumn(state, line, col) -> Position
```

### 8.2 Add a Plugin System Foundation
A minimal "middleware" layer for the reducer:
```typescript
type Middleware = (state, action, next) => DocumentState;
```

### 8.3 Implement Chunk Management (Phase 3)
For the 100MB target:
- Lazy chunk loading from `FileSystemHandle` or `ReadableStream`
- LRU eviction policy with configurable memory budget
- Integration with the piece table's `originalBuffer` (make it chunk-aware)

### 8.4 Single Content-Mutation Predicate
Replace the narrow `isTextEditAction` guard with a single authoritative `isContentMutationAction` that includes `APPLY_REMOTE`, and reuse it across reducer, event emission, and store boundaries.

### 8.5 Single Transaction Primitive
Refactor `batch` execution so that one transaction primitive owns undo grouping, reconciliation scheduling, and event emission — eliminating the parallel implementation in `createDocumentStoreWithEvents.batch`.

---

## 9. Fragility Points (Current)

1. **Branded type erosion** — `as number` casts in rendering.ts, reducer.ts, piece-table.ts, and line-index.ts will proliferate as new code is added.
2. **Piece table delete rebalancing** — `deleteRange` produces structurally correct but potentially unbalanced trees for heavy edit-delete cycles.
3. **Event store batch duplication** — Parallel transaction implementation in `createDocumentStoreWithEvents.batch` diverges from the base store over time.
4. **Version semantics** — Single monotonic counter conflates content changes and internal bookkeeping (e.g., reconciliation increments version).
5. **`charLength` / `subtreeCharLength` aggregate** — Every code path creating or modifying `LineIndexNode` must correctly maintain this aggregate. The `withLineIndexNode` helper recomputes `subtreeCharLength` automatically, but per-node `charLength` must be set correctly at every insert/delete/split site.
6. **Unicode correctness in setValue** — The non-optimized diff path (`useReplace: false`) lacks surrogate-boundary guards, producing replacement characters on emoji/surrogate edits.
7. **`ReadTextFn` optional callback** — When absent, `charLength` falls back to `0`, silently corrupting `subtreeCharLength` aggregates and all downstream char-offset queries without any error signal.

---

## 10. Learning Paths

### Recommended Reading Order

```
1.  types/branded.ts          → Branded numeric type safety system
2.  types/cost.ts             → Cost algebra, Ctx pipeline, Costed<L,T> widening
3.  types/state.ts            → Immutable state model (DocumentState<M> hierarchy)
4.  types/actions.ts          → Action discriminated union (13 types)
5.  types/store.ts            → Store/ReconcilableDocumentStore/LineIndexStrategy interfaces
6.  store/core/encoding.ts    → Shared TextEncoder/TextDecoder
7.  store/core/growable-buffer.ts → Encapsulated append-only buffer
8.  store/core/state.ts       → Factory functions, withState/withPieceNode helpers
9.  store/core/rb-tree.ts     → Generic RB-tree (rotations, fixInsertWithPath)
10. store/core/piece-table.ts → Core: insert, delete, getValue, streaming
11. store/core/line-index.ts  → Line tracking, eager vs lazy, reconciliation
12. store/features/reducer.ts → Unified applyEdit pipeline, invertChange, history
13. store/features/transaction.ts → Nested transaction state machine
14. store/features/store.ts   → Store factory, reconciliation scheduling
15. store/features/events.ts  → Event system for reactive consumers
16. store/features/rendering.ts → Virtualization, viewport management
17. store/features/diff.ts    → Myers diff, setValue functionality
18. api/query.ts + api/scan.ts → Complexity-stratified public API
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
| Cost brands + namespace stratification | Algorithmic complexity is structurally visible at the type level and at the import site. |
| `EvaluationMode` type parameter | Lazy/eager distinction enforced by the type system; stale-data bugs become compile errors. |

---

*Consolidated from: merged-report-2026-02-16.md, formalize-transparent-complexity-2026-02-16.md, formalize-2026-02-18.md, 2026-02-21-cost-ts-analysis.md, formalize-2026-02-21.md, 2026-02-21-code-analyze.md*
*Generated on 2026-02-22*
