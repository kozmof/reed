# Reed Code Analysis Report

**Date:** 2026-02-14
**Scope:** Full codebase analysis (`src/` directory)
**Test Status:** 447/447 tests passing across 11 test files

---

## 1. Code Organization and Structure

### Project Overview

Reed is a high-performance text editor library built with Vanilla TypeScript, targeting files up to 100MB. It is distributed as an embeddable NPM library for browser and desktop (Electron/Tauri) environments.

### Directory Layout

```
src/
  index.ts              # Public API barrel export
  types/
    index.ts            # Type barrel export
    branded.ts          # Branded numeric types (ByteOffset, CharOffset, etc.)
    actions.ts          # Action type definitions and type guards
    state.ts            # Core immutable state interfaces
    store.ts            # Store and strategy interfaces
  store/
    index.ts            # Store barrel export
    store.ts            # Store factory (createDocumentStore, createDocumentStoreWithEvents)
    state.ts            # State factory functions (createInitialState, withState, etc.)
    reducer.ts          # Pure reducer with lazy/eager line index strategies
    piece-table.ts      # Piece table with immutable Red-Black tree
    rb-tree.ts          # Generic Red-Black tree utilities
    line-index.ts       # Line index with eager/lazy maintenance + reconciliation
    events.ts           # Typed event emitter system
    rendering.ts        # Virtualized rendering utilities
    diff.ts             # Myers diff algorithm + setValue
    history.ts          # Undo/redo helper queries
    transaction.ts      # Nested transaction manager
    actions.ts          # Action creator factory (DocumentActions)
    encoding.ts         # Shared TextEncoder/TextDecoder singletons
```

### Assessment

The project follows a clean two-layer structure: `types/` for pure type definitions and `store/` for implementations. The barrel export pattern (`index.ts` at each level) provides a clear public API surface. The separation is consistent and discoverable.

**Strengths:**
- Clear separation of types from implementations
- Barrel exports provide a single import path for consumers
- Each file has a single, focused responsibility
- Comprehensive JSDoc documentation throughout

**Observations:**
- The `store/` directory contains both data structures (piece-table, rb-tree, line-index) and application logic (store, reducer, events). As the codebase grows, a sub-directory split (e.g., `store/data-structures/`, `store/logic/`) may become warranted.

---

## 2. Relations of Implementations (Types and Interfaces)

### Type Hierarchy

```
DocumentState
  ├── PieceTableState
  │     ├── PieceNode (extends RBNode<PieceNode>)
  │     ├── originalBuffer: Uint8Array
  │     └── addBuffer: Uint8Array
  ├── LineIndexState
  │     ├── LineIndexNode (extends RBNode<LineIndexNode>)
  │     └── DirtyLineRange[]
  ├── SelectionState
  │     └── SelectionRange (ByteOffset anchor/head)
  ├── HistoryState
  │     ├── HistoryEntry[]
  │     │     └── HistoryChange[]
  │     └── limit, coalesceTimeout
  └── DocumentMetadata

DocumentAction (discriminated union of 13 action types)

DocumentStore (interface)
  └── DocumentStoreWithEvents (extends DocumentStore)

LineIndexStrategy (interface)
  ├── eagerLineIndex (const implementation)
  └── lazyLineIndex (const implementation)

Branded Types: ByteOffset, ByteLength, CharOffset, LineNumber, ColumnNumber
```

### Key Type Relationships

| Interface | Role | Key Invariant |
|-----------|------|---------------|
| `RBNode<T>` | F-bounded generic for Red-Black tree nodes | Self-referential children via generics |
| `PieceNode` | Concrete RB node for piece table | `subtreeLength` must equal `length + left.subtreeLength + right.subtreeLength` |
| `LineIndexNode` | Concrete RB node for line index | `subtreeLineCount` and `subtreeByteLength` are maintained aggregates |
| `DocumentStore` | Framework-agnostic store | Compatible with React's `useSyncExternalStore` |
| `LineIndexStrategy` | Strategy pattern for eager/lazy | Reducer dispatches through this interface |

### Assessment

- The generic `RBNode<T>` with F-bounded polymorphism is well-designed, allowing two distinct tree types (PieceNode, LineIndexNode) to share balancing logic via `rb-tree.ts`.
- Branded types (`ByteOffset`, `CharOffset`, etc.) provide compile-time safety against mixing numeric domains. The constructor functions (`byteOffset()`, `charOffset()`) and arithmetic helpers maintain this discipline.
- All state types are `readonly`, enforcing immutability at the type level. Runtime freezing via `Object.freeze()` provides defense-in-depth.

---

## 3. Relations of Implementations (Functions)

### Core Data Flow

```
User Action
  → DocumentActions.insert/delete/replace (action creator)
  → store.dispatch(action)
  → documentReducer(state, action) [pure function]
      ├── pieceTableInsert/Delete (piece-table.ts)
      │     └── rbInsertPiece / deleteRange (rb-tree operations)
      ├── lazyLineIndex.insert/delete (line-index.ts, lazy path)
      │     └── Marks dirty ranges, defers reconciliation
      ├── historyPush (reducer.ts, captures undo info)
      └── withState (structural sharing)
  → notifyListeners()
  → scheduleReconciliation() (idle callback for line index)
```

### Undo/Redo Flow

```
UNDO action
  → historyUndo(state, version)
      → applyInverseChange(state, change, version)
          ├── pieceTableDelete/Insert (inverse of original)
          └── eagerLineIndex.delete/insert (immediate accuracy)
      → restore selectionBefore
```

### Key Function Dependency Graph

```
documentReducer
  ├── pieceTableInsert → rbInsertPiece → fixInsertWithPath (O(log n))
  ├── pieceTableDelete → deleteRange → mergeTrees → fixRedViolations
  ├── lazyLineIndex.insert → lineIndexInsertLazy → insertLinesAtPositionLazy
  ├── lazyLineIndex.delete → lineIndexDeleteLazy → deleteLineRangeLazy
  ├── historyPush → canCoalesce → coalesceChanges
  ├── historyUndo → applyInverseChange → eagerLineIndex.*
  └── historyRedo → applyChange → eagerLineIndex.*

createDocumentStore
  ├── createInitialState → createPieceTableState, createLineIndexState
  ├── documentReducer (via dispatch)
  ├── createTransactionManager (for batch/transaction)
  └── reconcileFull / reconcileViewport (via scheduleReconciliation)

createDocumentStoreWithEvents
  ├── createDocumentStore (composition, not inheritance)
  ├── createEventEmitter
  └── emitEventsForAction → createContentChangeEvent, etc.
```

### Assessment

- The reducer pattern is well-implemented: pure function, no side effects, exhaustive action handling with TypeScript's `never` check.
- The lazy/eager duality for line index is architecturally elegant: normal edits use lazy (O(log n) insert, deferred reconciliation), while undo/redo uses eager (immediate accuracy needed for correct state restoration).
- `fixInsertWithPath` provides O(log n) Red-Black tree fix-up, which is a significant optimization over the O(n) `fixInsert` (which still exists but is documented as deprecated in favor of the path-based approach).

---

## 4. Specific Contexts and Usages

### UTF-8/UTF-16 Duality

The piece table operates on UTF-8 byte offsets (`ByteOffset`), while JavaScript strings use UTF-16 code units. Conversion utilities bridge this gap:

- `charToByteOffset(text, charOffset)` - User input to piece table positions
- `byteToCharOffset(text, byteOffset)` - Piece table positions to user display
- `selectionToCharOffsets()` / `charOffsetsToSelection()` - Selection range conversion

### Reconciliation System

The lazy line index introduces a reconciliation lifecycle:

1. **Edit time:** `lineIndexInsertLazy` / `lineIndexDeleteLazy` update line counts and lengths but mark downstream offsets as dirty
2. **Idle time:** `scheduleReconciliation()` → `requestIdleCallback` → `reconcileFull()`
3. **Render time:** `reconcileViewport()` ensures visible lines are accurate before rendering
4. **On-demand:** `getLineRangePrecise()` applies cumulative dirty deltas for single-line queries

### Transaction Semantics

`createTransactionManager()` supports:
- Nested transactions (depth counter)
- Snapshot-based rollback (one snapshot per nesting level)
- Emergency reset (for when rollback itself throws)
- `batch()` in `store.ts` uses transactions internally, providing single-listener-notification and single-undo-unit semantics

---

## 5. Pitfalls

### 5.1 Add Buffer Mutation During Insert

In `pieceTableInsert` (piece-table.ts:313-324), the `addBuffer` is mutated in-place via `addBuffer.set(textBytes, addBufferLength)` before potentially being shared with a new state. When the buffer is grown (reallocated), a new `Uint8Array` is created, which is safe. However, when the buffer has sufficient capacity, the same `Uint8Array` reference is written to, meaning previous state snapshots sharing the buffer now see the new bytes appended. This is safe because previous pieces reference ranges that remain unchanged, and `addBufferLength` in the old state still reflects the old boundary. However, this is a subtle invariant that should be well-documented.

### 5.2 History Coalescing Uses `Date.now()`

The `canCoalesce()` function in `reducer.ts` uses `Date.now()` to check timing windows. This makes the reducer technically impure and non-deterministic, complicating:
- Deterministic replay of action sequences
- Testing (requires mocking or accepting timing-dependent behavior)
- Time-travel debugging

### 5.3 `getLine()` in piece-table.ts is O(n)

`getLine()` uses `findLineOffsets()` which calls `collectPieces()` and scans all bytes sequentially. The rendering module correctly uses `getLineContent()` (via line index, O(log n)), but `getLine()` remains available in the public API and could be misused by consumers.

### 5.4 Delete Operation Rebuilds Sub-trees

`deleteRange()` in piece-table.ts uses recursive tree reconstruction. While it has early-return optimizations for non-overlapping subtrees, deletions spanning multiple pieces can create unbalanced intermediate trees. The `mergeTrees()` helper fixes red violations but doesn't guarantee full RB-tree balance properties.

### 5.5 `deserializeAction` Trusts Input

`deserializeAction()` in `store/actions.ts` uses `JSON.parse()` and casts directly to `DocumentAction`. When processing actions from external sources (collaboration, logs), this bypasses the existing `validateAction()` / `isDocumentAction()` guards.

### 5.6 Reconciliation During Transaction

`scheduleReconciliation()` explicitly defers if a transaction is active, which is correct. However, after a `TRANSACTION_COMMIT`, reconciliation is triggered from the commit path in `store.ts`, which is fine. But if the transaction's inner dispatches individually triggered reconciliation scheduling (they would try, but the callback checks `transaction.isActive` and re-schedules), there's a small window of wasted scheduling.

---

## 6. Improvement Points (Design Overview)

### 6.1 Missing SAVE Action

The event system defines `SaveEvent` and `createSaveEvent()`, but there is no corresponding `SAVE` action in the `DocumentAction` union. Save functionality (clearing `isDirty`, setting `lastSaved`) would need to be handled outside the reducer or a new action added.

### 6.2 LOAD_CHUNK and EVICT_CHUNK Are No-ops

Both chunk actions return `state` unchanged in the reducer (`reducer.ts:632-640`), with comments indicating "Phase 3 will implement." These are declared in the public API but do nothing, which could confuse consumers.

### 6.3 No Dispose/Cleanup on Store

The store schedules background work via `requestIdleCallback`/`setTimeout` but provides no `dispose()` method to cancel pending callbacks. In SPA environments where editor instances are created/destroyed, this can cause memory leaks or stale callback execution.

### 6.4 Event Emission in Batch Replays Through Reducer Twice

`createDocumentStoreWithEvents.batch()` (store.ts:399-416) calls `baseStore.batch()` to apply all actions, then replays actions through `documentReducer` again to capture intermediate states for accurate event emission. This doubles the work for batched operations.

### 6.5 No Error Recovery Strategy for Corrupted Tree State

If a Red-Black tree invariant is violated (e.g., through a bug in `deleteRange` or `mergeTrees`), there's no validation or self-healing mechanism. A tree integrity check function would help detect corruption early.

---

## 7. Improvement Points (Types and Interfaces)

### 7.1 `documentOffset: number | 'pending'`

The `LineIndexNode.documentOffset` field uses a union with a string literal (`'pending'`), which introduces string comparisons at runtime. A separate boolean field (`isPending: boolean`) or sentinel value (`-1`) would be more performant and conventionally typed.

### 7.2 `Partial<PieceNode>` in `withPieceNode`

`withPieceNode(node, changes: Partial<PieceNode>)` accepts any partial subset of `PieceNode`, including `subtreeLength` and `subtreeAddLength` which are always recomputed. A narrower update type (e.g., `Pick<PieceNode, 'color' | 'left' | 'right' | 'start' | 'length'>`) would prevent accidentally passing pre-computed aggregates that get overwritten.

### 7.3 `BufferReference` vs Inline Buffer Fields

`PieceNode` duplicates `bufferType`, `start`, and `length` that also appear in `BufferReference`. While the duplication avoids an extra object allocation, it means `getPieceBufferRef()` constructs a new object each call. Since buffer references are frequently used, consider embedding `BufferReference` directly in `PieceNode`.

### 7.4 Readonly Arrays Are Spread-Copied Frequently

History operations (`historyPush`, `historyUndo`, `historyRedo`) create new arrays via spread (`[...history.undoStack, entry]`). For large history stacks (limit: 1000), this is O(n) per edit. A persistent/immutable data structure (e.g., a simple linked list or functional deque) would reduce this to O(1).

---

## 8. Improvement Points (Implementations)

### 8.1 `collectPieces()` Materializes Entire Tree

Several operations (`getValue`, `getValueStream`, `compactAddBuffer`) call `collectPieces()` which allocates an array of all nodes. For large documents with many pieces, this is memory-intensive. An in-order iterator (generator function) would avoid the allocation.

### 8.2 `byteToCharOffset` Encodes Entire String

`byteToCharOffset(text, byteOffset)` calls `textEncoder.encode(text)` on the entire string even when only a prefix is needed. Encoding could be terminated early once the target byte offset is reached.

### 8.3 Redundant `textEncoder.encode()` Calls

Several code paths encode the same text multiple times:
- `pieceTableInsert` encodes text to get bytes, then `lineIndexInsert` encodes again to find newlines
- `getAffectedRange` re-encodes `action.text` that was already encoded during dispatch

A shared "analyzed text" structure (bytes + newline positions + byte length) could eliminate redundant encoding.

### 8.4 `simpleDiff` DP Table Can Be Large

For strings just below the `n*m < 10000` threshold (~100x100 chars), `simpleDiff` allocates an `Int32Array` of 10,000 elements. The Myers algorithm above the threshold allocates `Int32Array` traces proportional to edit distance. Neither has a global memory cap. For very large documents, `computeSetValueActionsOptimized` (which finds a single differing region) is much more efficient and should be the default path.

### 8.5 `Object.freeze()` on Every Node Creation

Every `createPieceNode`, `withPieceNode`, `createLineIndexNode`, and `withLineIndexNode` call freezes the returned object. While this provides strong immutability guarantees, `Object.freeze()` has measurable overhead in hot paths. Consider making freeze opt-in (e.g., development-only) or relying solely on TypeScript's `readonly` for production builds.

### 8.6 Line Index Delete Falls Back to O(n) Rebuild

`deleteLineRangeLazy` calls `rebuildWithDeletedRange` which uses incremental R-B tree deletion (O(k * log n) where k = deleted lines). However, the `removeLinesToEnd` path collects all lines into an array and rebuilds from scratch. A consistent incremental approach would be preferable.

---

## 9. Learning Paths (Entries and Goals)

### Entry Points for New Contributors

| Starting Point | File | What You Learn |
|---|---|---|
| **Branded types** | `types/branded.ts` | TypeScript phantom types, type-safe numeric domains |
| **State model** | `types/state.ts` | Immutable state design, structural sharing concepts |
| **Action system** | `types/actions.ts` | Discriminated unions, type guards, action validation |
| **Piece table** | `store/piece-table.ts` | Core data structure, immutable R-B tree operations |
| **Store** | `store/store.ts` | Factory pattern, subscription model, `useSyncExternalStore` compatibility |
| **Tests** | `store/piece-table.test.ts` | Behavior examples for every piece table operation |

### Recommended Learning Path

```
1. types/branded.ts          → Understand the numeric type safety system
2. types/state.ts            → Understand the immutable state model
3. types/actions.ts          → Understand the action-based mutation model
4. store/encoding.ts         → Trivial but foundational (shared TextEncoder)
5. store/state.ts            → Factory functions, withState/withPieceNode helpers
6. store/rb-tree.ts          → Generic R-B tree balancing (rotations, fix-up)
7. store/piece-table.ts      → Core: insert, delete, getValue, streaming
8. store/line-index.ts       → Line tracking, eager vs lazy, reconciliation
9. store/reducer.ts          → Tying it all together: actions → state transitions
10. store/store.ts           → Store factory, transaction integration, reconciliation scheduling
11. store/events.ts          → Event system for reactive consumers
12. store/rendering.ts       → Virtualization, viewport management
13. store/diff.ts            → Myers diff, setValue functionality
14. store/transaction.ts     → Nested transaction state machine
```

### Architecture Goals (from SPEC.md)

| Goal | Current Status | Notes |
|---|---|---|
| O(log n) editing | Implemented | Piece table with R-B tree, path-based fix-up |
| O(log n) line lookups | Implemented | Separate line index R-B tree |
| Large file support (100MB) | Partial | Piece table works; chunk loading is stubbed |
| Lazy line index | Implemented | Dirty range tracking + reconciliation |
| Undo/redo | Implemented | With coalescing, proper selection restore |
| Transactions | Implemented | Nested, with rollback and emergency reset |
| Event system | Implemented | Type-safe, 5 event types |
| Collaboration (CRDT) | Partial | APPLY_REMOTE action exists; no Yjs integration |
| Plugin system | Not started | Spec exists (spec/05-plugin-system.md) |
| Rendering/DOM | Partial | Utility functions exist; no actual DOM rendering |
| Multi-cursor | Partial | SelectionState supports arrays; no editing support |

---

## Summary

Reed's core data layer is well-architected with strong TypeScript typing, immutable state management, and efficient algorithms. The piece table with immutable R-B tree, lazy line index with reconciliation, and the reducer-based state management form a solid foundation. The codebase is thoroughly tested (447 tests) with clean separation of concerns.

Key areas for next steps:
1. Implement chunk loading/eviction for true 100MB support
2. Add `dispose()` to store for cleanup
3. Optimize redundant `textEncoder.encode()` calls in hot paths
4. Implement the rendering/DOM layer
5. Build the plugin system defined in the spec
