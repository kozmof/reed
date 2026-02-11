# Reed Code Analysis Report

**Date**: 2026-02-10
**Codebase version**: `7b5e3ed` (main)
**Test status**: 414/414 passing (10 test files)
**Total source lines**: ~11,900 (implementation) + ~3,700 (tests)

---

## 1. Code Organization and Structure

### Directory Layout

```
src/
  index.ts                 (273 lines)  Public re-export barrel
  types/
    index.ts               ( 98 lines)  Type re-export barrel
    branded.ts             (252 lines)  Branded numeric types + arithmetic
    state.ts               (294 lines)  Immutable state type definitions
    actions.ts             (476 lines)  Action types, guards, validation
    store.ts               (170 lines)  Store / strategy interfaces
  store/
    index.ts               (141 lines)  Store re-export barrel
    encoding.ts            (  7 lines)  Shared TextEncoder/TextDecoder singletons
    state.ts               (324 lines)  State factory functions + withNode helpers
    rb-tree.ts             (292 lines)  Generic immutable Red-Black tree utilities
    piece-table.ts        (1146 lines)  Piece table operations (insert/delete/read/stream)
    line-index.ts         (1545 lines)  Line index operations (eager + lazy + reconciliation)
    reducer.ts             (550 lines)  Document reducer (pure state transitions)
    actions.ts             (166 lines)  Action creator functions + serialization
    store.ts               (482 lines)  Store factory (createDocumentStore + events wrapper)
    events.ts              (306 lines)  Typed event emitter for document changes
    rendering.ts           (401 lines)  Virtualized rendering utilities
    history.ts             ( 56 lines)  History helper queries (canUndo, etc.)
    diff.ts                (608 lines)  Myers diff + setValue operations
```

### Observations

- **Clear separation of concerns**: Types live in `types/`, implementations in `store/`. The public API is exposed through two levels of barrel files (`src/index.ts` -> `src/types/index.ts` / `src/store/index.ts`).
- **Single-package library**: The entire codebase is a self-contained NPM library with no runtime dependencies (only dev dependencies: TypeScript, Vite, Vitest).
- **Test co-location**: Test files (`*.test.ts`) are placed alongside their implementation files in `store/`. This keeps tests discoverable, though `types/branded.test.ts` is the one exception (tests inside the types folder).
- **No rendering/DOM layer yet**: The codebase is purely a data-layer library. The `rendering.ts` file provides *computation* utilities for virtualized rendering but no actual DOM manipulation, matching the "embeddable library" goal from the spec.

---

## 2. Relations of Implementations (Types and Interfaces)

### Type Dependency Graph

```
branded.ts  ──────────────────────────────────┐
  ByteOffset, CharOffset, LineNumber,          │
  ColumnNumber                                 │
                                               ▼
state.ts ─────────────────────────────────────┐
  PieceNode, PieceTableState,                  │
  LineIndexNode, LineIndexState,               │
  SelectionRange, SelectionState,              │
  HistoryEntry, HistoryState,                  │
  DocumentState, DocumentStoreConfig           │
                                               ▼
actions.ts ────────────────────────────────── store.ts (interfaces)
  DocumentAction (union of 13 variants)        DocumentStore, DocumentStoreWithEvents,
  InsertAction, DeleteAction, ...              ReadonlyDocumentStore, DocumentReducer,
  ActionValidationResult                       LineIndexStrategy
                                               ▲
                                               │ imports events.ts types
                                               │ (DocumentEventEmitter, DocumentEventMap)
```

### Key Type Relationships

| Type | Role | Used By |
|------|------|---------|
| `ByteOffset` (branded) | Core positional currency for the piece table | actions, state, reducer, piece-table, line-index, rendering |
| `CharOffset` (branded) | User-facing (UTF-16) position | rendering (selectionToCharOffsets/charOffsetsToSelection) |
| `PieceNode` extends `RBNode<PieceNode>` | F-bounded polymorphic tree node | piece-table, rb-tree |
| `LineIndexNode` extends `RBNode<LineIndexNode>` | Same F-bounded pattern | line-index, rb-tree |
| `DocumentState` | Root immutable snapshot | reducer, store, rendering, events, diff, history |
| `DocumentAction` | Discriminated union (13 members) | reducer, store, events, actions |
| `LineIndexStrategy` | Strategy pattern for eager/lazy | reducer |
| `DocumentEventMap` | Type-safe event mapping | events, store (DocumentStoreWithEvents) |

### Design Patterns in Types

1. **Branded types** (`Branded<T, B>`) use a phantom `unique symbol` for compile-time safety between `ByteOffset` and `CharOffset`, with zero runtime overhead.
2. **F-bounded polymorphism** (`RBNode<T extends RBNode<T>>`) enables the generic RB-tree module to operate on both `PieceNode` and `LineIndexNode` without type erasure.
3. **Discriminated unions** for `DocumentAction` (on `type` field) and `BufferReference` (on `bufferType` field) enable exhaustive `switch` handling.
4. **Readonly all the way down**: Every state type uses `readonly` properties and `Object.freeze()` at creation, enforcing immutability.

---

## 3. Relations of Implementations (Functions)

### Call Graph (Major Flows)

```
createDocumentStore()
  └─ createInitialState()
       ├─ createPieceTableState()  → textEncoder.encode()
       ├─ createLineIndexState()   → buildLineIndexTree()
       ├─ createInitialSelectionState()
       ├─ createInitialHistoryState()
       └─ createInitialMetadata()

store.dispatch(action)
  └─ documentReducer(state, action)
       ├─ [INSERT]
       │    ├─ validatePosition()
       │    ├─ pieceTableInsert()   → rbInsertPiece() → bstInsert() → fixInsertWithPath()
       │    ├─ lazyLineIndex.insert() → lineIndexInsertLazy()
       │    └─ historyPush()
       ├─ [DELETE]
       │    ├─ validateRange()
       │    ├─ getText()            (capture for undo)
       │    ├─ pieceTableDelete()   → deleteRange() → mergeTrees()
       │    ├─ lazyLineIndex.delete() → lineIndexDeleteLazy()
       │    └─ historyPush()
       ├─ [UNDO]
       │    └─ historyUndo()        → applyInverseChange() → eagerLineIndex.*()
       ├─ [REDO]
       │    └─ historyRedo()        → applyChange() → eagerLineIndex.*()
       └─ [APPLY_REMOTE] → pieceTableInsert/Delete + lazyLineIndex

store.scheduleReconciliation()
  └─ requestIdleCallback → reconcileFull() → buildBalancedTree()

getVisibleLines(state, viewport)
  └─ getLineRangePrecise() → getText() → VisibleLine[]
```

### Key Function Dependencies

| Function | Depends On | Depended On By |
|----------|-----------|----------------|
| `documentReducer` | pieceTableInsert/Delete, lazyLineIndex, eagerLineIndex, historyPush/Undo/Redo | store.dispatch, setValue |
| `pieceTableInsert` | textEncoder, findPieceAtPosition, rbInsertPiece, splitPiece | reducer (INSERT, REDO), applyChange |
| `pieceTableDelete` | deleteRange, mergeTrees, fixRedViolations | reducer (DELETE, UNDO), applyInverseChange |
| `rbInsertPiece` | bstInsert, fixInsertWithPath | pieceTableInsert |
| `fixInsertWithPath` | fixInsertViolation, ensureBlackRoot | rbInsertPiece (piece-table), rbInsertLine (line-index) |
| `lineIndexInsertLazy` | findNewlineBytePositions, findLineAtPosition, rbInsertLine, mergeDirtyRanges | reducer (INSERT) |
| `reconcileFull` | collectLines, buildBalancedTree | store.scheduleReconciliation, store.reconcileNow |
| `getVisibleLines` | getLineRangePrecise, getText | (rendering consumers) |
| `diff` (Myers) | myersDiff, simpleDiff, consolidateEdits | computeSetValueActions, setValue |

---

## 4. Specific Contexts and Usages

### Dual Line Index Strategy (Eager vs. Lazy)

The reducer uses **lazy line index** for normal editing (INSERT, DELETE, REPLACE, APPLY_REMOTE) and **eager line index** for undo/redo. This is formalized through the `LineIndexStrategy` interface:

- **Lazy** (`lazyLineIndex`): Updates line *lengths* and *structure* (splits/merges) immediately, but marks downstream line *offsets* as dirty. Reconciliation is deferred to `requestIdleCallback`.
- **Eager** (`eagerLineIndex`): Recalculates all offsets synchronously. Used for undo/redo where the user needs immediate visual accuracy.

This dual strategy is a well-considered design tradeoff for balancing throughput during rapid typing vs. correctness during discrete undo operations.

### Transaction Support

The store supports nested transactions via a `depth` counter. `TRANSACTION_START` captures a snapshot, inner dispatches accumulate, and `TRANSACTION_COMMIT` flushes listeners. `TRANSACTION_ROLLBACK` restores the snapshot. The `batch()` method wraps multiple actions in a transaction for single-undo-unit semantics.

### Streaming for Large Files

`getValueStream()` is a generator that yields `DocumentChunk` objects, enabling memory-efficient processing of large documents without materializing the entire string. The chunk size defaults to 64KB.

### Event System

`createDocumentStoreWithEvents()` wraps a base store to emit typed events (`content-change`, `selection-change`, `history-change`, `dirty-change`) after dispatches. The event types carry full prev/next state references plus affected range metadata.

### Collaboration Hooks

`APPLY_REMOTE` action processes remote changes (designed for Yjs integration). Remote changes bypass history (no undo entry) but still update the line index via lazy strategy.

---

## 5. Pitfalls

### 5.1 UTF-8 Byte Offset as Primary Currency

The entire piece table operates on **UTF-8 byte offsets** (`ByteOffset`), while JavaScript strings use UTF-16 code units. This is architecturally sound for a high-performance editor targeting large files, but creates a pervasive conversion burden:

- Every user-facing position (cursor, selection) must go through `charToByteOffset`/`byteToCharOffset`.
- `charToByteOffset` calls `textEncoder.encode(text.slice(0, offset))` which allocates on every call.
- `byteToCharOffset` does a manual byte-scan which is more efficient but still O(n) in the text length.
- **Risk**: If a caller forgets to convert and passes a `CharOffset` where a `ByteOffset` is expected, the branded types will catch this at compile time, but only if the branded types are actually used (raw `number` would bypass the guard).

### 5.2 `deleteRange` May Violate Red-Black Tree Invariants

The `deleteRange` function in `piece-table.ts` rebuilds the tree by recursively modifying nodes, but it can produce red-red violations or subtree imbalances that are not always fully rebalanced:

- When a piece is split during delete (lines 539-563), the right piece is always created as `'red'`, potentially creating a red-red violation with a red parent.
- `mergeTrees` applies `fixRedViolations` along the merge path, but does not perform a full black-height rebalance.
- In practice, the tree remains functional because `subtreeLength` is always correctly maintained via `withPieceNode`, but the tree may degrade from O(log n) to worse in pathological cases.

### 5.3 History Entries Store Full Text Strings

`HistoryChange` stores the full `text` (and optionally `oldText`) as strings. For large deletions or replacements, this can consume significant memory, especially since the undo stack defaults to 1000 entries. The piece table itself is already append-only, so a more memory-efficient approach could reference piece table buffer ranges instead of duplicating text.

### 5.4 `reconcileFull` Is O(n) Full Rebuild

When reconciling dirty ranges, `reconcileFull` collects all lines and rebuilds the entire balanced tree from scratch. For documents with millions of lines, this is expensive even during idle time. The incremental `reconcileRange` is available but currently only used for viewport reconciliation.

### 5.5 `LOAD_CHUNK` and `EVICT_CHUNK` Are No-ops

These actions are declared in the type system and accepted by the reducer, but their handler bodies simply `return state`. Consumers may expect chunk management to work but it silently does nothing.

### 5.6 `selectionToCharOffsets`/`charOffsetsToSelection` Call `getValue()` Each Time

Both selection-conversion functions call `getValue(state.pieceTable)` which materializes the *entire document* as a string. For large documents, this is O(n) per call and should be avoided in hot paths (e.g., per-keystroke selection updates).

### 5.7 Serialization Uses `btoa`/`atob` for Binary Data

`serializeAction` and `deserializeAction` use `btoa(String.fromCharCode(...))` for `Uint8Array` serialization. The spread operator on large arrays can hit stack size limits. A chunked base64 approach would be safer.

---

## 6. Improvement Points 1 (Design Overview)

### 6.1 Introduce a Cursor/Position Abstraction Layer

Currently, the byte/char duality is spread across consumers. A dedicated `Position` module that encapsulates the conversion and caches results would reduce error-prone manual conversions and improve performance:

```
Position { byteOffset, charOffset, line, column }
  - fromByte(state, byte) -> Position
  - fromChar(state, char) -> Position
  - fromLineColumn(state, line, col) -> Position
```

### 6.2 Implement Chunk Management

The spec targets 100MB files, but `LOAD_CHUNK`/`EVICT_CHUNK` are not implemented. The current approach loads the entire original buffer into memory. For the 100MB goal, a chunk management layer with memory-mapped-like semantics is needed:

- Lazy chunk loading from a `FileSystemHandle` or `ReadableStream`
- LRU eviction policy with a configurable memory budget
- Integration with the piece table's `originalBuffer` (make it chunk-aware)

### 6.3 Extract Transaction Logic from Store to a Standalone Module

Transaction management (depth tracking, snapshot/rollback) is embedded in the store closure. Extracting it into a composable `TransactionManager` would:

- Make it testable in isolation
- Allow reuse in `setValue()` which currently calls the reducer directly (bypassing store transactions)
- Enable nested transaction semantics for plugin batching

### 6.4 Add a Plugin System Foundation

The spec describes an extensive plugin system, but there are currently no hooks or extension points. Before building full plugins, a minimal "middleware" layer for the reducer could be introduced:

```typescript
type Middleware = (state, action, next) => DocumentState;
```

This would allow interception without modifying the core reducer.

### 6.5 Consider Replacing Full-Tree Reconciliation with Incremental

Instead of `reconcileFull` rebuilding all line offsets, an incremental approach that walks dirty ranges and adjusts offsets in-place (via `updateLineOffsetByNumber`) would be O(k * log n) where k is the number of dirty lines, avoiding the O(n) collect-and-rebuild.

---

## 7. Improvement Points 2 (Types and Interfaces)

### 7.1 ~~`LineIndexNode.documentOffset` Is Unused in Lazy Mode~~ (Fixed 2026-02-11)

**Resolution**: Changed `documentOffset` type from `number` to `number | 'pending'` in `LineIndexNode`. Lazy-inserted lines now use `'pending'` instead of placeholder `0`. Read sites in `updateOffsetsAfterLine` and `updateLineOffsetByNumber` guard against `'pending'` values. Factory functions (`createLineIndexNode`, `rbInsertLine`) updated to accept `number | 'pending'`.

### 7.2 ~~`HistoryChange.byteLength` Is Redundant~~ (Fixed 2026-02-11)

**Resolution**: Removed the redundant `oldTextByteLength` field from `HistoryChange`. The `byteLength` field is retained as a cached computation for the primary text. The redo path for REPLACE now computes old text byte length on demand via `textEncoder.encode(change.oldText ?? '').length`, which is acceptable since redo is not a hot path.

### 7.3 ~~`BufferReference.length` Uses `ByteOffset` Type~~ (Fixed 2026-02-11)

**Resolution**: Added `ByteLength = Branded<number, 'ByteLength'>` branded type to `branded.ts` with constructor `byteLength()` and constant `ZERO_BYTE_LENGTH`. Updated `OriginalBufferRef.length`, `AddBufferRef.length`, and `PieceNode.length` from `ByteOffset` to `ByteLength`. Updated `createPieceNode`, `rbInsertPiece`, `insertWithSplit`, `splitPiece`, and `deleteRange` to use `byteLength()` for length values. Exported from both barrel files.

### 7.4 ~~`DocumentEvent.type` Should Be a String Literal Union~~ (Fixed 2026-02-11)

**Resolution**: Changed `DocumentEvent.type` from `string` to `keyof DocumentEventMap`, narrowing it to `'content-change' | 'selection-change' | 'history-change' | 'save' | 'dirty-change'`.

### 7.5 ~~`DirtyLineRange.endLine` Dual Type~~ (Fixed 2026-02-11)

**Resolution**: Changed `endLine` from `number | 'end'` to `number`. All creation sites now use `Number.MAX_SAFE_INTEGER` instead of the `'end'` string sentinel. Removed all `=== 'end'` guard checks from `mergeDirtyRanges`, `isLineDirty`, `getOffsetDeltaForLine`, `reconcileRange`, and `reconcileViewport`, simplifying numeric comparisons throughout.

### 7.6 ~~Strengthen Action Creator Return Types~~ (Fixed 2026-02-11)

**Resolution**: Removed redundant `as const` assertions from all 13 action creator return statements and from the `DocumentActions` object itself. The explicit return type annotations (e.g., `InsertAction`) already constrain literal types, making `as const` unnecessary. `Object.freeze()` still provides runtime immutability.

---

## 8. Improvement Points 3 (Implementations)

### 8.1 `getValue()` Materializes Entire Document

`getValue()` collects all pieces, allocates a `Uint8Array` of `totalBytes`, copies all piece data, then decodes to string. This is O(n) and allocates 2x the document size (bytes + string). For large documents:

- Consider a lazy `toString()` with caching (invalidated on edit).
- For consumers that only need a range, always prefer `getText(start, end)`.

### 8.2 `getLineCount()` in `piece-table.ts` Scans All Bytes

This O(n) function scans every byte for `0x0A`. The line index already maintains `lineCount` in O(1). The piece-table-level `getLineCount` should only be used when no line index is available. Adding a deprecation note or redirecting to `getLineCountFromIndex` would prevent misuse.

### 8.3 `addBuffer` Growth Strategy

The add buffer doubles in size when full (`Math.max(buffer.length * 2, needed)`). This is standard amortized doubling, but:

- The initial allocation in `createPieceTableState` is 1024 bytes, which is small for editors expecting large files.
- The buffer is never shrunk. After large deletions, the add buffer retains its peak size.
- `compactAddBuffer` exists but is never called automatically. Consider triggering it when `wasteRatio > threshold` during idle time.

### 8.4 `deleteLineRange` Calls `findLineByNumber` in a Loop

In `line-index.ts`, `deleteLineRange` (lines 700-727) calls `findLineByNumber` for each middle line in a loop. Each call is O(log n), making the total O(k * log n). For large multi-line deletions, this could be improved by collecting all needed data in a single tree traversal.

### 8.5 `createDocumentStoreWithEvents.batch()` Replays Reducer

The event-emitting `batch()` method (lines 427-443) first calls `baseStore.batch()` to apply all actions, then *replays* the same actions through `documentReducer` to capture intermediate states for accurate events. This doubles the computation for every batched operation. An alternative would be to capture events during the first pass.

### 8.6 `diff.ts` Has Unused Helper Functions

`isLowSurrogate()` and `isHighSurrogate()` are defined in `diff.ts` and used by `computeSetValueActionsOptimized`, but `computeSetValueActions` does not guard against surrogate splitting. The non-optimized path could produce invalid splits on surrogate pairs.

### 8.7 Missing `Object.freeze()` Consistency

Most state factories apply `Object.freeze()`, but `withState()` uses `Object.freeze({ ...state, ...changes })` which only freezes the top level. Nested objects (e.g., a new `metadata` object passed in `changes`) may not be frozen. This is mostly safe because concrete factories freeze their outputs, but the pattern is fragile if callers construct nested objects inline.

### 8.8 `textEncoder.encode()` Called Multiple Times for Same Text

In the reducer's INSERT handler, `textEncoder.encode(action.text)` is called once inside `pieceTableInsert` (to copy bytes to the add buffer) and again in `historyPush` (to compute `byteLength`). Passing the pre-computed byte length would avoid the redundant encoding.

---

## 9. Learning Paths on Implementations

### Entry Points

| Goal | Start From | Key Files |
|------|-----------|-----------|
| Understand the public API | `src/index.ts` | Barrel exports → types, store factories |
| Understand state shape | `src/types/state.ts` | DocumentState → PieceTableState, LineIndexState, etc. |
| Understand how edits work | `src/store/reducer.ts` | documentReducer → INSERT/DELETE cases |
| Understand the piece table | `src/store/piece-table.ts` | pieceTableInsert → rbInsertPiece → splitPiece |
| Understand the RB-tree | `src/store/rb-tree.ts` | rotateLeft/Right → fixRedViolations → fixInsertWithPath |
| Understand line indexing | `src/store/line-index.ts` | lineIndexInsert → eager path; lineIndexInsertLazy → lazy path |
| Understand the store pattern | `src/store/store.ts` | createDocumentStore → dispatch/batch/subscribe |
| Understand rendering computation | `src/store/rendering.ts` | getVisibleLines → getLineRangePrecise → getText |
| Understand diff/setValue | `src/store/diff.ts` | diff() → myersDiff; setValue() → computeSetValueActionsOptimized |
| Understand branded types | `src/types/branded.ts` | Brand<B> → Branded<T,B> → ByteOffset, CharOffset |

### Recommended Learning Path

1. **Types first**: Read `branded.ts` → `state.ts` → `actions.ts` → `store.ts` to understand the data model.
2. **Core data structure**: Read `rb-tree.ts` → `piece-table.ts` to understand how text is stored and modified.
3. **State management**: Read `state.ts` (factories) → `reducer.ts` to understand how actions produce new state.
4. **Line tracking**: Read `line-index.ts` (both eager and lazy paths) to understand the dual-tree architecture.
5. **Store integration**: Read `store.ts` → `events.ts` to understand how the public API composes these primitives.
6. **Advanced features**: Read `diff.ts` (Myers algorithm), `rendering.ts` (virtualization), `history.ts` (undo queries).
7. **Tests**: Each `*.test.ts` file serves as executable documentation for its module's behavior and edge cases.

### Architecture Decisions Worth Understanding

- **Why two RB-trees?** The piece table tree indexes by byte offset for O(log n) position lookup. The line index tree indexes by line number. Keeping them separate allows independent update strategies (lazy vs. eager).
- **Why byte offsets, not string indices?** UTF-8 byte offsets avoid the complexity of JavaScript's UTF-16 surrogate pairs for internal operations. The piece table stores raw bytes (`Uint8Array`), making byte offsets the natural addressing unit.
- **Why immutable state?** Structural sharing via `Object.freeze()` + `withPieceNode`/`withLineIndexNode` enables O(1) snapshot creation, time-travel debugging, and safe concurrent reads. Each edit creates O(log n) new nodes, sharing the rest of the tree.
- **Why factory functions instead of classes?** The store uses closure-based encapsulation (`createDocumentStore()` returns an object literal) rather than ES classes. This provides true privacy for internal state (transaction depth, reconciliation timers) without relying on `#private` fields.

---

## 10. Carry-Forward Issues from Previous Reports

The following issues were identified in earlier analysis reports (2026-01-31, 2026-02-03, 2026-02-06) and remain unfixed in the current codebase.

### 10.1 Selection Not Auto-Updated on Edit (from 02-03: 5.5, 6.1)

When an INSERT or DELETE action modifies the document, the reducer does **not** automatically adjust the selection/cursor position. Consumers must manually dispatch `SET_SELECTION` after every edit to keep the cursor in the correct position. This is error-prone for integrators—a standard text editor expectation is that inserting text moves the cursor to the end of the inserted content, and deleting text moves the cursor to the start of the deleted range.

**Recommendation**: Add a selection transformation step inside the reducer for INSERT, DELETE, and REPLACE actions that automatically adjusts `anchor`/`active` positions based on the edit range and length delta.

### 10.2 No Undo Grouping Timeout (from 02-03: 6.2)

Each dispatched action creates a separate `HistoryEntry`. In typical editors, rapid keystrokes (e.g., typing a word) are coalesced into a single undo entry using a timeout (e.g., 300ms). Currently, pressing undo after typing "hello" would undo one character at a time rather than the whole word.

**Recommendation**: Add a `coalesceTimeout` option to `DocumentStoreConfig` that merges consecutive same-type actions (e.g., sequential `INSERT` at adjacent positions) into a single history entry when they occur within the timeout window.

### 10.3 Nested Transaction Rollback Shares Outermost Snapshot (from 02-03: 5.3)

The transaction system uses a single `snapshot` captured at `TRANSACTION_START` with a `depth` counter for nesting. Rolling back an inner transaction restores the snapshot from the *outermost* transaction, discarding all changes—including those from successfully committed intermediate transactions.

**Example**: `begin() → edit A → begin() → edit B → rollback()` discards both A and B, even though only the inner transaction was rolled back.

**Recommendation**: Maintain a snapshot stack (`snapshot[]`) so each nested `TRANSACTION_START` captures its own restore point. Rollback pops only the most recent snapshot.

### 10.4 `getBufferStats` Iterates All Pieces (from 02-03: 8.6)

`getBufferStats()` in `piece-table.ts` performs an in-order traversal of the entire piece tree to count the number of pieces and compute total text size. This is O(n) in the number of pieces.

**Recommendation**: Track `pieceCount` and aggregate sizes incrementally in `PieceTableState`, updated on insert/delete. This would make `getBufferStats` O(1).

### 10.5 Separate "Core" from "Features" (from 02-06: D1)

All implementation code resides in a flat `store/` directory. As the codebase grows (plugin system, chunk management, CRDT), this structure will make it harder to identify what is core vs. optional. Separating into `core/` (rb-tree, piece-table, state, reducer) and `features/` (events, rendering, diff, history helpers) would:

- Enable tree-shaking for consumers who only need the core
- Clarify the dependency hierarchy (features depend on core, not vice versa)
- Make it easier to enforce layering rules

### 10.6 Extract Buffer Management (from 02-06: D2)

The add buffer growth logic is embedded inside `pieceTableInsert` in `piece-table.ts`. Extracting it into a dedicated `GrowableBuffer` abstraction would:

- Make the growth strategy configurable (e.g., different strategies for small vs. large documents)
- Enable unit testing of buffer management independently of the piece table
- Prepare for chunk management integration where buffer lifecycle becomes more complex

---

## Summary

Reed's core data layer is well-architected with clean type safety, immutable state management, and a sound piece table + RB-tree foundation. The codebase demonstrates strong TypeScript practices (branded types, discriminated unions, F-bounded polymorphism) and thoughtful performance tradeoffs (lazy/eager line indexing, streaming, virtualization support).

The main areas needing attention for production readiness are:

1. **Chunk management** (LOAD_CHUNK/EVICT_CHUNK) to achieve the 100MB file target
2. **Memory efficiency** in history storage and selection conversion for large documents
3. **RB-tree invariant maintenance** during delete operations
4. **Performance hot spots** (redundant encoding, full-document materialization in getValue/selectionToCharOffsets)
5. **Plugin/middleware extensibility** foundation for the spec's plugin system goals
6. **Selection auto-adjustment** on edit actions (carry-forward from 02-03)
7. **Undo grouping** with coalesce timeout for natural undo behavior (carry-forward from 02-03)
8. **Nested transaction rollback** should use a snapshot stack (carry-forward from 02-03)
9. **Module separation** into core/features for tree-shaking and clarity (carry-forward from 02-06)
