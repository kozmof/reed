# Reed Text Editor - Code Analysis Report

**Date**: 2026-02-06
**Codebase Version**: `52d3b47` (main branch)

---

## 1. Code Organization and Structure

### Project Overview

Reed is a high-performance text editor library built with Vanilla TypeScript, targeting files up to 100MB. It is distributed as an embeddable NPM library for browser and desktop (Electron/Tauri) environments.

### Directory Structure

```
reed/
├── src/
│   ├── index.ts              (266 lines) - Main entry, re-exports all public API
│   ├── types/
│   │   ├── index.ts           (96 lines)  - Type barrel file
│   │   ├── state.ts          (280 lines) - Core immutable state types
│   │   ├── actions.ts        (476 lines) - Action types + validation
│   │   ├── store.ts          (157 lines) - Store interface
│   │   └── branded.ts        (252 lines) - Branded position types
│   └── store/
│       ├── index.ts          (138 lines) - Store barrel file
│       ├── state.ts          (325 lines) - State factory functions
│       ├── store.ts          (475 lines) - Store implementation
│       ├── reducer.ts        (565 lines) - Pure reducer
│       ├── piece-table.ts   (1136 lines) - Piece table with RB-tree
│       ├── line-index.ts    (1491 lines) - Line index with RB-tree + lazy reconciliation
│       ├── rb-tree.ts        (205 lines) - Generic RB-tree utilities
│       ├── diff.ts           (612 lines) - Myers diff + setValue
│       ├── events.ts         (309 lines) - Event system
│       ├── rendering.ts      (352 lines) - Viewport/rendering utilities
│       ├── history.ts         (56 lines) - History query helpers
│       └── actions.ts        (166 lines) - Action creators + serialization
├── spec/                     - 10 specification documents
├── report/                   - Analysis reports
├── package.json              - pnpm, vite, vitest, typescript
└── tsconfig.json             - ES2022, strict mode
```

### Source Metrics

| Category | Files | Lines |
|----------|-------|-------|
| Types (`src/types/`) | 5 | 1,261 |
| Implementation (`src/store/`) | 11 | 5,830 |
| Tests (`src/store/*.test.ts`) | 9 | 3,604 |
| Entry (`src/index.ts`) | 1 | 266 |
| **Total** | **26** | **~11,000** |

### Architecture Pattern

The codebase follows a **Redux-like unidirectional data flow** pattern:

```
Action → Reducer → New State → Listeners
```

- **Immutable State**: All state structures are `Object.freeze()`-d with `readonly` properties
- **Structural Sharing**: State updates only create new objects for changed branches
- **Pure Reducer**: `documentReducer()` is a pure function with no side effects
- **Factory Functions**: No classes; store is created via factory function closure pattern

### Build & Tooling

- **Package Manager**: pnpm
- **Bundler**: Vite 7.x
- **Language**: TypeScript 5.9 (strict mode, `erasableSyntaxOnly`)
- **Testing**: Vitest 4.x
- **Module System**: ESM (`"type": "module"`)

---

## 2. Relations of Implementations (Types, Interfaces)

### Core Type Hierarchy

```
DocumentState (root state snapshot)
├── PieceTableState
│   ├── PieceNode (extends RBNode<PieceNode>)
│   │   └── subtreeLength, bufferType, start, length
│   ├── originalBuffer: Uint8Array
│   └── addBuffer: Uint8Array
├── LineIndexState
│   ├── LineIndexNode (extends RBNode<LineIndexNode>)
│   │   └── subtreeLineCount, subtreeByteLength, documentOffset, lineLength
│   ├── DirtyLineRange[]
│   └── rebuildPending: boolean
├── SelectionState
│   └── SelectionRange[] (anchor, head as ByteOffset)
├── HistoryState
│   ├── undoStack: HistoryEntry[]
│   └── redoStack: HistoryEntry[]
│       └── HistoryEntry
│           └── HistoryChange[]
└── DocumentMetadata
    └── filePath, encoding, lineEnding, isDirty
```

### Branded Types

```
ByteOffset = Branded<number, 'ByteOffset'>   -- UTF-8 byte positions
CharOffset = Branded<number, 'CharOffset'>    -- UTF-16 code unit positions
LineNumber = Branded<number, 'LineNumber'>     -- 0-indexed line numbers
ColumnNumber = Branded<number, 'ColumnNumber'> -- 0-indexed column numbers
```

These use a phantom brand pattern (`declare const brand: unique symbol`) to prevent accidental mixing of offset types at compile time, with zero runtime overhead.

### Action Types (Discriminated Union)

```
DocumentAction =
  | InsertAction      { type: 'INSERT', start: ByteOffset, text: string }
  | DeleteAction      { type: 'DELETE', start: ByteOffset, end: ByteOffset }
  | ReplaceAction     { type: 'REPLACE', start: ByteOffset, end: ByteOffset, text: string }
  | SetSelectionAction
  | UndoAction / RedoAction / HistoryClearAction
  | TransactionStartAction / TransactionCommitAction / TransactionRollbackAction
  | ApplyRemoteAction { changes: RemoteChange[] }
  | LoadChunkAction / EvictChunkAction
```

### Store Interfaces

```
DocumentStore
├── subscribe(listener) → Unsubscribe      -- React useSyncExternalStore compatible
├── getSnapshot() → DocumentState           -- Immutable snapshot
├── dispatch(action) → DocumentState
├── batch(actions) → DocumentState
├── scheduleReconciliation?()               -- Background idle reconciliation
├── reconcileNow?()                         -- Synchronous reconciliation
└── setViewport?(startLine, endLine)        -- Viewport-aware reconciliation

DocumentStoreWithEvents extends DocumentStore
├── addEventListener(type, handler) → Unsubscribe
├── removeEventListener(type, handler)
└── events: DocumentEventEmitter

ReadonlyDocumentStore (subset for consumers)
```

### Generic RB-Tree Abstraction

```
RBNode<T extends RBNode<T>>   -- F-bounded polymorphic base
├── PieceNode                  -- Piece table nodes
└── LineIndexNode              -- Line index nodes

WithNodeFn<N>                  -- Generic node update function
```

The `WithNodeFn<N>` pattern allows `rb-tree.ts` to provide generic rotation and balancing operations that work with both `PieceNode` and `LineIndexNode`, since each node type has different aggregate values (subtreeLength vs subtreeLineCount/subtreeByteLength) that must be recalculated on structural changes.

---

## 3. Relations of Implementations (Functions)

### Core Data Flow

```
createDocumentStore(config)
  └── createInitialState(config)
        ├── createPieceTableState(content)     -- Encodes to originalBuffer
        ├── createLineIndexState(content)      -- Builds balanced RB-tree of line offsets
        ├── createInitialSelectionState()
        ├── createInitialHistoryState(limit)
        └── createInitialMetadata(config)

store.dispatch(action)
  └── documentReducer(state, action)
        ├── INSERT → pieceTableInsert → lineIndexUpdateLazy → historyPush
        ├── DELETE → getTextRange → pieceTableDelete → lineIndexRemoveLazy → historyPush
        ├── REPLACE → getTextRange → pieceTableDelete → pieceTableInsert → lineIndex* → historyPush
        ├── SET_SELECTION → setSelection
        ├── UNDO → historyUndo → applyInverseChange (for each change)
        ├── REDO → historyRedo → applyChange (for each change)
        ├── HISTORY_CLEAR
        ├── APPLY_REMOTE → loop(pieceTableInsert/Delete + lineIndex*)
        └── LOAD_CHUNK / EVICT_CHUNK → (stub, Phase 3)
```

### Piece Table Operation Chain

```
pieceTableInsert(state, position, text)
  ├── textEncoder.encode(text)         -- Get byte representation
  ├── Grow addBuffer if needed         -- Double-or-fit strategy
  ├── findPieceAtPosition(root, pos)   -- O(log n) tree search
  ├── If at boundary:
  │   └── rbInsertPiece(root, pos, 'add', start, len)
  │         ├── createPieceNode(...)
  │         ├── bstInsert(root, pos, newNode) -- Recursive BST insert
  │         └── fixInsert(newRoot, withPiece) -- Generic RB rebalancing
  └── If mid-piece:
      └── insertWithSplit(root, location, ...)
            ├── splitPiece(piece, offset) → [left, right]
            ├── replacePieceInTree(root, path, old, new) -- O(log n) path copy
            ├── rbInsertPiece(result, insertPos, ...) -- Insert new piece
            └── rbInsertPiece(result, rightPos, ...) -- Insert right fragment

pieceTableDelete(state, start, end)
  └── deleteRange(node, offset, start, end) -- Recursive tree rebuild
        ├── Process children recursively
        ├── No overlap → keep (with updated children if changed)
        ├── Full overlap → mergeTrees(left, right)
        ├── Partial overlap before → keep left part
        ├── Partial overlap after → keep right part
        └── Split overlap → leftPiece + rightPiece
```

### Line Index Dual Path (Eager vs Lazy)

```
Eager path (used by undo/redo):
  lineIndexInsert → updateLineLength | insertLinesAtPosition | appendLines
  lineIndexDelete → updateLineLength | deleteLineRange → rebuildWithDeletedRange

Lazy path (used by normal editing):
  lineIndexInsertLazy → updateLineLengthLazy | insertLinesAtPositionLazy | appendLinesLazy
    └── Marks dirty ranges, defers offset recalculation
  lineIndexDeleteLazy → updateLineLengthLazy | deleteLineRangeLazy
    └── Marks dirty ranges via DirtyLineRange

Reconciliation:
  reconcileFull()     -- O(n) full rebuild, called from idle callback
  reconcileRange()    -- O(k * log n) partial update
  reconcileViewport() -- Reconcile only visible lines
```

### Rendering Pipeline

```
getVisibleLines(state, ViewportConfig)
  ├── getLineCountFromIndex(state.lineIndex) -- O(1)
  ├── Calculate range with overscan
  └── For each line in range:
        ├── getLineRangePrecise(lineIndex, lineNum) -- O(log n) + dirty delta
        ├── getText(pieceTable, start, end)          -- O(log n + k)
        └── Build VisibleLine object

positionToLineColumn(state, position)
  ├── findLineAtPosition(lineIndex.root, position) -- O(log n)
  ├── getLineRangePrecise(lineIndex, lineNumber)
  └── getText(...) → compute character column
```

### Diff & setValue Pipeline

```
setValue(state, newContent, options)
  ├── getValue(state.pieceTable) -- Get current content O(n)
  ├── computeSetValueActionsOptimized(old, new)
  │     ├── Find common prefix (character-by-character)
  │     ├── Find common suffix
  │     ├── Handle surrogate pairs at boundaries
  │     └── Generate single REPLACE / INSERT / DELETE action
  └── Apply actions through documentReducer

diff(oldText, newText) -- Myers algorithm
  ├── Common prefix/suffix extraction
  ├── myersDiff(middle) or simpleDiff(middle) -- <10000 chars²: DP LCS
  └── consolidateEdits → DiffEdit[]
```

---

## 4. Specific Contexts and Usages

### React Integration (useSyncExternalStore)

The store interface is designed for direct use with React's `useSyncExternalStore`:
```typescript
const state = useSyncExternalStore(
  store.subscribe,
  store.getSnapshot,
  store.getServerSnapshot
);
```

### Event-Driven Architecture

`createDocumentStoreWithEvents()` wraps the base store to emit typed events:
- `content-change` → INSERT/DELETE/REPLACE/APPLY_REMOTE
- `selection-change` → SET_SELECTION
- `history-change` → UNDO/REDO
- `dirty-change` → When `metadata.isDirty` changes

### Transaction Support

Transactions provide atomic batching:
- `TRANSACTION_START` snapshots current state
- Actions during transaction are accumulated
- `TRANSACTION_COMMIT` notifies listeners once
- `TRANSACTION_ROLLBACK` restores snapshot
- Supports nested transactions via depth counter

### Collaboration Readiness

- `APPLY_REMOTE` action applies remote changes without pushing to history
- Action serialization/deserialization (`serializeAction`/`deserializeAction`)
- `RemoteChange` type models insert/delete operations from network

### Large File Strategy

- **Piece Table**: O(log n) insertions/deletions via RB-tree
- **Lazy Line Index**: Defers O(n) offset recalculation to idle time
- **Streaming**: `getValueStream()` yields 64KB chunks via generator
- **Buffer Management**: `compactAddBuffer()` reclaims wasted space
- **Chunk Loading**: `LOAD_CHUNK`/`EVICT_CHUNK` actions (stub, Phase 3)

---

## 5. Pitfalls

### P1: Line Index Text Length vs Byte Length Mismatch

In `line-index.ts`, the `findNewlinePositions()` and `countNewlines()` functions operate on **string (UTF-16) positions**, but the line index stores **byte lengths**. When text contains multi-byte UTF-8 characters (CJK, emoji), `text.length` (UTF-16 code units) differs from the byte length. Functions like `insertLinesAtPosition()` use `text.length` directly as byte delta for `insertedBytes`, which is incorrect for non-ASCII content.

**Affected areas**: `lineIndexInsert`, `lineIndexInsertLazy`, `lineIndexDelete`, `lineIndexDeleteLazy`

### P2: Delete Range Complexity for Multi-Line Deletions

The `deleteRange()` function in `piece-table.ts` recursively processes the entire tree for deletions. While the RB-tree gives O(log n) for lookups, the delete operation traverses all nodes, making it effectively O(n) where n is the number of pieces. For large documents with many pieces, this can degrade performance.

### P3: History Undo/Redo Uses Eager Line Index Updates

The `applyChange()` and `applyInverseChange()` functions in `reducer.ts` only update the piece table but do not update the line index. After undo/redo, the line index may be stale until the next reconciliation.

### P4: Transaction Rollback Doesn't Notify Listeners

When `TRANSACTION_ROLLBACK` restores the snapshot, no listeners are notified. If external state depends on tracking all state transitions, rollbacks create a silent state change.

### P5: `batch()` Error Recovery

If an action within `batch()` throws, the catch block in `finally` tries to rollback. If rollback itself fails, it manually resets transaction state. However, the piece table and line index may be in an inconsistent intermediate state.

### P6: `reconcileFull()` Doesn't Update `lastReconciledVersion`

The `reconcileFull()` function clears dirty ranges but doesn't update `lastReconciledVersion` to the current version. It preserves the old value from `state.lastReconciledVersion`. This could cause stale version tracking.

### P7: `getAffectedRange` for REPLACE Uses `Math.max`

The `getAffectedRange()` function for `REPLACE` actions computes the affected end as `start + Math.max(deleteLength, insertLength)`. This means if the replacement text is shorter than the deleted range, the reported "affected range" extends beyond the actual changed content, which could cause unnecessary re-renders.

### P8: Module-level `TextEncoder`/`TextDecoder` Duplication

`textEncoder` is instantiated as a module-level singleton in 5 different files: `reducer.ts`, `piece-table.ts`, `state.ts`, `events.ts`, and `diff.ts`. While each instance is lightweight (~100 bytes), this pattern creates unnecessary redundancy.

---

## 6. Improvement Points 1 (Design Overview)

### D1: Separate "Core" from "Features"

Currently all functionality lives in `src/store/`. Consider splitting into:
- `src/core/` — piece-table, rb-tree, state, reducer (zero external dependencies)
- `src/features/` — events, rendering, diff, history helpers
- `src/store/` — store factory only

This would enable tree-shaking for consumers who only need the pure data structure.

### D2: Extract Buffer Management

The add buffer growth logic (doubling strategy) is embedded in `pieceTableInsert()`. Extracting it into a dedicated `BufferPool` or `GrowableBuffer` abstraction would:
- Make the growth strategy configurable
- Enable memory pooling for large files
- Simplify the piece table code

### D3: Formalize the Eager/Lazy Duality

The line index has parallel implementations (eager + lazy) for insert and delete. This pattern could be formalized with a `LineIndexStrategy` interface:
```
interface LineIndexStrategy {
  insert(state, position, text, version): LineIndexState
  delete(state, start, end, deletedText, version): LineIndexState
}
```
This would make it easier to swap strategies (e.g., always-eager for small files).

### D4: Consider Immutable.js or Immer Alternative

The current manual `Object.freeze()` + spread pattern is verbose. While it avoids library dependencies, it leads to deeply nested freeze calls. Consider:
- Keeping current approach for maximum performance (recommended for library code)
- Adding a development-only deep-freeze validator in tests

### D5: Phase 3 Stubs

`LOAD_CHUNK` and `EVICT_CHUNK` actions return state unchanged. These should be documented more prominently, and the chunk management strategy should be designed before implementation to avoid breaking changes.

---

## 7. Improvement Points 2 (Types, Interfaces)

### T1: `BufferType` vs `BufferReference.kind`

There are two ways to express buffer type: `BufferType = 'original' | 'add'` and `BufferReference.kind = 'original' | 'add'`. `PieceNode.bufferType` uses `BufferType` while `BufferReference` uses `kind`. This inconsistency means code must translate between the two representations.

### T2: `PieceNode.start` and `PieceNode.length` Are Unbranded

These are raw `number` values representing byte offsets into buffers, but they're not typed as `ByteOffset`. Since the piece table operates entirely in byte space, branding these fields would prevent accidental mixing with character offsets.

### T3: `HistoryChange.position` Is `ByteOffset` But Text Is `string`

The `HistoryChange` type stores `position` as `ByteOffset` but `text` as a JavaScript string. During undo/redo, `textEncoder.encode(change.text).length` is called repeatedly to convert string length to byte length. Pre-computing and storing `byteLength` would eliminate this repeated encoding.

### T4: `DirtyLineRange.endLine` Uses `-1` as Sentinel

The `endLine: number` field uses `-1` to mean "to end of document". A more type-safe approach would use `endLine: number | 'end'` or a separate `DirtyLineRangeToEnd` variant.

### T5: `SelectionRange` Uses `ByteOffset` for Anchor/Head

Selection positions are stored as byte offsets, but users typically think in character positions. The API should consider providing a `CharSelectionRange` type alongside, or making byte ↔ char conversion more prominent.

### T6: Missing `Readonly` on Action Creator Return Types

The `DocumentActions` object methods return mutable action objects (e.g., `{ type: 'INSERT', start, text }`). While the type declarations mark fields as `readonly`, the runtime objects are not frozen. This could lead to accidental mutation.

---

## 8. Improvement Points 3 (Implementations)

### I1: `deleteRange()` Full Tree Traversal

The piece table's `deleteRange()` rebuilds the entire tree by visiting every node. An alternative approach would be:
1. Split the tree at `deleteStart` → (left, right₁)
2. Split right₁ at `deleteEnd - deleteStart` → (deleted, right)
3. Merge left + right

This "split-merge" approach is O(log n) for balanced trees.

### I2: `byteToCharOffset()` Linear Scan

The function uses a linear scan from the beginning of the string. For large strings, this is O(n). A binary search approach (doubling the position until past the target, then binary searching) would be O(log n).

### I3: `findLineOffsets()` Is O(n)

The `getLine()` function scans the entire document to find line boundaries. For documents with a line index, it should use the line index tree instead. The function even has a comment suggesting this.

### I4: `simpleDiff()` Memory Usage

The DP-based LCS in `simpleDiff()` allocates an `(n+1) × (m+1)` matrix. For strings up to ~100 characters (where n*m < 10000), this is fine. But the threshold should be documented, and the allocation pattern `Array(n+1).fill(null).map(...)` creates garbage.

### I5: `mergeDirtyRanges()` Only Merges Same-Delta Ranges

Two adjacent dirty ranges with different `offsetDelta` values won't be merged. While this is correct for precise tracking, it means rapid editing can accumulate many small dirty ranges, degrading reconciliation performance.

### I6: Event Emission in Batch Mode

`createDocumentStoreWithEvents().batch()` emits events for each action with the *overall* `prevState` and `nextState`. This means each event gets the same before/after states, losing intermediate state information. For consumers tracking individual changes, this could be misleading.

### I7: `replacePieceInTree()` Receives Unused `_root` Parameter

The function signature includes `_root: PieceNode` which is never used. The path-based reconstruction doesn't need the original root since the last path entry leads to it.

### I8: `compactAddBuffer()` Uses Two Passes

The buffer compaction builds an offset map in one pass then copies data in another. These could be combined into a single pass, reducing memory allocation.

### I9: `fixInsert()` Calls `rebalanceAfterInsert()` Which Traverses Full Tree

The `rebalanceAfterInsert()` function in `rb-tree.ts` recursively visits the entire tree to find and fix violations, making it O(n). Standard RB-tree insertion fix-up is O(log n) by only walking from the inserted node to the root. This is the most significant performance issue in the codebase.

---

## 9. Learning Paths on Implementations

### Entry Points

1. **`src/index.ts`** — Start here to see the complete public API surface. Every exported symbol is listed with its module origin.

2. **`src/types/state.ts`** — Understand the data model. All state types are defined here with thorough JSDoc. Read this before diving into implementations.

3. **`src/types/actions.ts`** — The action discriminated union. Includes type guards and validation. Understanding the action vocabulary is key to understanding the reducer.

### Core Data Structures Path

```
types/branded.ts → types/state.ts → store/state.ts → store/rb-tree.ts
    ↓                                     ↓
Branded types              Factory functions (createPieceNode, etc.)
for positions              + structural sharing helpers (withState, etc.)
```

4. **`src/types/branded.ts`** — The branded type pattern. Small and self-contained. Good introduction to phantom types in TypeScript.

5. **`src/store/rb-tree.ts`** — Generic Red-Black tree operations. The `WithNodeFn<N>` pattern is the key abstraction. Understanding rotations and `fixRedViolations` is prerequisite for piece table and line index.

### Piece Table Path

```
store/state.ts (createPieceNode, createPieceTableState)
  → store/piece-table.ts (insert/delete/getValue/getText)
    → store/rb-tree.ts (fixInsert, rotateLeft/Right)
```

6. **`src/store/piece-table.ts`** — The heart of the editor. Start with `getValue()` (simplest read), then `pieceTableInsert()`, then `pieceTableDelete()`. The streaming `getValueStream()` is a good example of generator usage.

### Line Index Path

```
store/state.ts (createLineIndexState)
  → store/line-index.ts (eager operations)
    → store/line-index.ts (lazy operations + reconciliation)
```

7. **`src/store/line-index.ts`** — Largest file. Start with the eager `lineIndexInsert()` to understand line tracking, then read the lazy variants to understand the dirty range optimization.

### Store & Reducer Path

```
store/reducer.ts → store/store.ts → store/events.ts
```

8. **`src/store/reducer.ts`** — The pure reducer. Follow the INSERT case first (simplest), then DELETE (needs text capture for undo), then REPLACE (combines both). UNDO/REDO demonstrate the inverse change pattern.

9. **`src/store/store.ts`** — Factory function closure pattern. Transaction handling and background reconciliation scheduling. The `createDocumentStoreWithEvents()` shows the decorator/wrapper pattern for adding event emission.

### Features Path

```
store/rendering.ts (viewport virtualization)
store/diff.ts (Myers diff + setValue)
store/history.ts (query helpers)
store/actions.ts (action creators + serialization)
```

10. **`src/store/rendering.ts`** — Converts line index data into renderable `VisibleLine` objects. `estimateTotalHeight()` demonstrates the sampling strategy for large documents.

11. **`src/store/diff.ts`** — Two diff strategies (Myers for large, DP for small), plus the optimized "find changed region" approach in `computeSetValueActionsOptimized()`.

### Goals

| Goal | Key Files | Concepts |
|------|-----------|----------|
| Understand the data model | `types/state.ts`, `types/actions.ts`, `types/branded.ts` | Immutable state, discriminated unions, branded types |
| Understand the piece table | `store/piece-table.ts`, `store/rb-tree.ts` | RB-tree, structural sharing, UTF-8 buffers |
| Understand line management | `store/line-index.ts` | Eager vs lazy updates, dirty ranges, reconciliation |
| Understand state management | `store/reducer.ts`, `store/store.ts` | Pure reducer, transactions, background reconciliation |
| Understand rendering | `store/rendering.ts` | Viewport virtualization, variable line heights |
| Add a new action type | `types/actions.ts` → `store/reducer.ts` → `src/index.ts` | Follow INSERT as template |
| Build a UI integration | `store/store.ts`, `types/store.ts` | Subscribe/getSnapshot, event system |
