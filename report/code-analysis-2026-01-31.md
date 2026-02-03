# Reed - Code Analysis Report

**Date:** 2026-01-31
**Analyzer:** Claude Opus 4.5
**Project:** Reed Text Editor Library
**Version:** 0.0.0
**Last Updated:** 2026-02-03 (Lazy Line Index Maintenance)

---

## Executive Summary

Reed is a high-performance text editor library written in Vanilla TypeScript, designed as an embeddable NPM package targeting both browser and desktop environments (Electron/Tauri). The codebase demonstrates strong architectural foundations with immutable data structures, pure functional patterns, and comprehensive test coverage.

| Metric | Value |
|--------|-------|
| Total Source Lines | ~10,200 |
| Test Coverage | 374 tests passing |
| Core Data Structures | 2 (Piece Table, Line Index) |
| Action Types | 12 |
| Event Types | 5 |
| Implementation Phases Complete | 3 of 8 |

---

## 1. Code Organization and Structure

### Project Overview

Reed is designed with the following key principles:
- **Performance First:** O(log n) operations for editing, O(1) for common queries
- **Large File Support:** Targets smooth scrolling and editing up to 100MB
- **Embeddable:** Works as an NPM library
- **Extensible:** Rich plugin system (planned)
- **Collaborative:** Built-in CRDT support (planned)

### Directory Structure

```
reed/
├── src/
│   ├── index.ts              # Public library entry point
│   ├── store/                # Core store logic (~6,000+ lines)
│   │   ├── store.ts          # Store factory & state management (336 lines)
│   │   ├── reducer.ts        # Pure reducer function (565 lines)
│   │   ├── state.ts          # State factory functions (315 lines)
│   │   ├── actions.ts        # Action creators (165 lines)
│   │   ├── piece-table.ts    # Piece table with R-B tree (1,034 lines)
│   │   ├── line-index.ts     # Line index with R-B tree + lazy maintenance (1,477 lines)
│   │   ├── rb-tree.ts        # Generic R-B tree utilities (212 lines)
│   │   ├── diff.ts           # Myers diff algorithm (611 lines)
│   │   ├── events.ts         # Event pub/sub system (306 lines)
│   │   ├── history.ts        # Undo/redo helpers (56 lines)
│   │   ├── rendering.ts      # Viewport virtualization (345 lines)
│   │   ├── index.ts          # Store module exports (118 lines)
│   │   └── *.test.ts         # Comprehensive test suite (2,500+ lines)
│   └── types/                # Type definitions
│       ├── state.ts          # Core state types (249 lines)
│       ├── actions.ts        # Action types (279 lines)
│       ├── store.ts          # Store interface (83 lines)
│       ├── branded.ts        # Branded position types (252 lines)
│       └── index.ts          # Type exports (88 lines)
├── spec/                     # Design documentation
└── package.json
```

**Strengths:**
- Clear separation between types and implementation
- Single-responsibility modules
- Well-organized exports via barrel files
- Comprehensive inline documentation

---

## 2. Relations of Implementations (Types & Interfaces)

### Type Hierarchy

```
DocumentState (root state)
├── PieceTableState
│   ├── PieceNode (R-B tree)
│   └── Buffers (originalBuffer, addBuffer)
├── LineIndexState
│   ├── LineIndexNode (R-B tree)
│   └── DirtyLineRange[] (lazy maintenance)
├── SelectionState
│   └── SelectionRange[]
├── HistoryState
│   └── HistoryEntry[]
│       └── HistoryChange[]
└── DocumentMetadata
```

### Key Interface Relationships

| Interface | Depends On | Used By |
|-----------|-----------|---------|
| `PieceNode` | `NodeColor`, `BufferType` | `PieceTableState`, piece-table operations |
| `LineIndexNode` | `NodeColor` | `LineIndexState`, line-index operations |
| `DocumentAction` | `SelectionRange` | `documentReducer`, store dispatch |
| `DocumentStore` | `DocumentState`, `StoreListener` | Consumer applications |

### Branded Types System

The codebase defines branded types in `src/types/branded.ts` for type-safe position handling:

```typescript
type ByteOffset = Branded<number, 'ByteOffset'>;  // UTF-8 byte positions
type CharOffset = Branded<number, 'CharOffset'>;  // UTF-16 code unit positions
type LineNumber = Branded<number, 'LineNumber'>;  // 0-indexed line numbers
type ColumnNumber = Branded<number, 'ColumnNumber'>;
```

**Status:** ✅ Branded types are now consistently used throughout the codebase for type-safe position handling. All action types and function signatures use `ByteOffset` for positions.

---

## 3. Relations of Implementations (Functions)

### Core Data Flow

```
dispatch(action) → documentReducer(state, action) → newState
                          ↓
    ┌─────────────────────┴─────────────────────┐
    ↓                     ↓                     ↓
pieceTableInsert    lineIndexInsert      historyPush
pieceTableDelete    lineIndexDelete
```

### Function Dependency Graph

**Store Layer:**
- `createDocumentStore()` → creates closure over `state`, `listeners`, `transaction`
- `dispatch()` → calls `documentReducer()` → calls domain operations

**Piece Table Operations:**
- `pieceTableInsert()` → `rbInsertPiece()` → `fixInsert()` (from rb-tree.ts)
- `pieceTableDelete()` → `deleteRange()` → `mergeTrees()`
- `getValue()` / `getText()` → `collectPieces()` + buffer access

**Line Index Operations:**
- `lineIndexInsert()` → `rbInsertLine()` → `fixInsert()` (eager, O(n) for newlines)
- `lineIndexInsertLazy()` → marks dirty ranges, O(log n) (deferred reconciliation)
- `lineIndexDelete()` → `rebuildWithDeletedRange()` (eager)
- `lineIndexDeleteLazy()` → marks dirty ranges (deferred reconciliation)
- `findLineAtPosition()` / `findLineByNumber()` for queries
- `getLineRangePrecise()` → applies dirty range deltas on-demand
- `reconcileFull()` / `reconcileViewport()` → background reconciliation

**Shared Utilities:**
- `rb-tree.ts` provides generic `fixInsert()`, `rotateLeft()`, `rotateRight()`
- Both piece-table and line-index use these via `WithNodeFn<N>` pattern

---

## 4. Specific Contexts and Usages

### Usage Pattern: Creating a Document Store

```typescript
import { createDocumentStore, getValue } from 'reed';

const store = createDocumentStore({ content: 'Hello World' });

// Subscribe to changes
const unsubscribe = store.subscribe(() => {
  const state = store.getSnapshot();
  console.log(getValue(state.pieceTable));
});

// Dispatch actions
store.dispatch({ type: 'INSERT', position: 5, text: '!' });
```

### Usage Pattern: Batch Operations (Transactions)

```typescript
store.batch([
  { type: 'DELETE', start: 0, end: 5 },
  { type: 'INSERT', position: 0, text: 'Hi' },
]);
// Single notification, single undo unit
```

### Usage Pattern: Line-Based Access

```typescript
import { getVisibleLines, positionToLineColumn } from 'reed';

const result = getVisibleLines(state, {
  startLine: 0,
  visibleLineCount: 50,
  overscan: 5,
});

result.lines.forEach(line => {
  console.log(`Line ${line.lineNumber}: ${line.content}`);
});
```

---

## 5. Pitfalls

### ~~Pitfall 1: Byte vs Character Offset Confusion~~ ✅ ADDRESSED

~~The piece table operates on **byte offsets** (UTF-8), but JavaScript strings use UTF-16 indices. This can cause issues with multi-byte characters.~~

**Location:** `src/store/piece-table.ts:902-965`

**Fix Applied:** Added public conversion utilities for byte/char offset handling:

```typescript
// Convert character offset (string index) to byte offset
export function charToByteOffset(text: string, charOffset: number): number;

// Convert byte offset to character offset
export function byteToCharOffset(text: string, byteOffset: number): number;
```

**Example usage:**
```typescript
import { charToByteOffset, byteToCharOffset } from 'reed';

charToByteOffset('Hello', 2);     // Returns 2 (ASCII: 1 byte per char)
charToByteOffset('你好', 1);       // Returns 3 (CJK: 3 bytes per char)
charToByteOffset('Hello 😀', 7);  // Returns 8 (emoji: 4 bytes)
```

**Status:** ✅ Resolved - Conversion utilities exported for public use

### ~~Pitfall 2: Line Index Rebuild Performance~~ ✅ FIXED

~~The `deleteLineRange()` function rebuilds the entire line tree by collecting all lines and reconstructing.~~

**Location:** `src/store/line-index.ts:653-774`

**Fix Applied:** Implemented optimized `rebuildWithDeletedRange()` with:
- Threshold-based optimization: small deletions (≤3 lines) use incremental approach
- Pre-allocated arrays to reduce memory churn
- Single-pass tree traversal with state object instead of intermediate array collection

```typescript
// Now uses optimized approach for common case of small edits
if (deletedCount <= 3 && totalLines > 10) {
  return rebuildWithSmallDeletion(root, startLine, endLine, mergedLength, totalLines);
}
```

**Status:** ✅ Resolved

### ~~Pitfall 3: Immutable Tree Overhead~~ ✅ FIXED

~~Every tree modification creates new nodes up the path. For deeply nested operations, this creates many intermediate objects.~~

**Location:** `src/store/piece-table.ts:384-409`

**Fix Applied:** Optimized `replacePieceInTree` to use path-based O(log n) approach:

```typescript
function replacePieceInTree(
  _root: PieceNode,
  path: PathEntry[],
  oldNode: PieceNode,
  newNode: PieceNode
): PieceNode {
  // Start with the new node, preserving the old node's children
  let current = withPieceNode(newNode, {
    left: oldNode.left,
    right: oldNode.right,
  });

  // Walk back up the path in reverse, creating new parent nodes
  // This only touches O(log n) nodes - the ones on the path from root to target
  for (let i = path.length - 1; i >= 0; i--) {
    const { node: parent, direction } = path[i];
    if (direction === 'left') {
      current = withPieceNode(parent, { left: current });
    } else {
      current = withPieceNode(parent, { right: current });
    }
  }

  return current;
}
```

**Status:** ✅ Resolved - Now uses path from `findPieceAtPosition` for O(log n) updates

### ~~Pitfall 4: Transaction State in Store Closure~~ ✅ FIXED

~~Transaction state is mutable within the closure, and if an error occurs during transaction, the depth might not reset properly.~~

**Location:** `src/store/store.ts:153-189`

**Fix Applied:** Added robust error handling with `finally` block:

```typescript
let success = false;
try {
  // Apply all actions
  for (const action of actions) {
    dispatch(action);
  }
  dispatch({ type: 'TRANSACTION_COMMIT' });
  success = true;
} finally {
  if (!success) {
    try {
      dispatch({ type: 'TRANSACTION_ROLLBACK' });
    } catch {
      // Manual cleanup if rollback fails
      if (transaction.snapshotBeforeTransaction) {
        state = transaction.snapshotBeforeTransaction;
      }
      transaction.depth = 0;
      transaction.snapshotBeforeTransaction = null;
      transaction.pendingActions = [];
    }
  }
}
```

**Status:** ✅ Resolved

### ~~Pitfall 5: Unused Branded Types~~ ✅ FIXED

~~Branded types are defined but the actual operations use plain `number`.~~

**Fix Applied:** All position parameters now use `ByteOffset` branded type:

**Action types (`src/types/actions.ts`):**
```typescript
export interface InsertAction {
  readonly type: 'INSERT';
  readonly position: ByteOffset;  // Now branded
  readonly text: string;
}

export interface DeleteAction {
  readonly type: 'DELETE';
  readonly start: ByteOffset;     // Now branded
  readonly end: ByteOffset;       // Now branded
}
```

**Function signatures (`src/store/piece-table.ts`):**
```typescript
export function pieceTableInsert(
  state: PieceTableState,
  position: ByteOffset,           // Now branded
  text: string
): PieceTableState

export function pieceTableDelete(
  state: PieceTableState,
  start: ByteOffset,              // Now branded
  end: ByteOffset                 // Now branded
): PieceTableState
```

**Usage:**
```typescript
import { createDocumentStore, DocumentActions, byteOffset } from 'reed';

const store = createDocumentStore({ content: 'Hello' });
store.dispatch(DocumentActions.insert(byteOffset(5), ' World'));
```

**Status:** ✅ Resolved - Branded types now used consistently throughout codebase

---

## 6. Improvement Points (Design Overview)

### ~~Improvement 1: Adopt Branded Types Consistently~~ ✅ IMPLEMENTED

~~Convert all position parameters to use `ByteOffset` or `CharOffset` branded types.~~

**Implemented:** All position parameters now use `ByteOffset`:
- Action types: `InsertAction.position`, `DeleteAction.start/end`, `ReplaceAction.start/end`
- Piece table: `pieceTableInsert`, `pieceTableDelete`, `getText`, `findPieceAtPosition`
- Line index: `lineIndexInsert`, `lineIndexDelete`, `findLineAtPosition`
- Rendering: `positionToLineColumn`, `lineColumnToPosition`
- Reducer: All internal position handling

**Exported from main index:**
```typescript
export type { ByteOffset, CharOffset, LineNumber, ColumnNumber } from './types/index.ts';
export { byteOffset, charOffset, lineNumber, columnNumber } from './types/index.ts';
```

### ~~Improvement 2: Lazy Line Index Maintenance~~ ✅ IMPLEMENTED

~~Instead of rebuilding the entire tree on deletions, implement an incremental update strategy.~~

**Implemented:** Full lazy maintenance system with:

**New Types (`src/types/state.ts`):**
```typescript
interface DirtyLineRange {
  readonly startLine: number;
  readonly endLine: number;      // -1 = to end of document
  readonly offsetDelta: number;
  readonly createdAtVersion: number;
}

interface LineIndexState {
  readonly root: LineIndexNode | null;
  readonly lineCount: number;
  readonly dirtyRanges: readonly DirtyLineRange[];  // NEW
  readonly lastReconciledVersion: number;            // NEW
  readonly rebuildPending: boolean;                  // NEW
}
```

**Lazy Operations (`src/store/line-index.ts`):**
- `lineIndexInsertLazy()` - O(log n) insert, defers offset recalculation
- `lineIndexDeleteLazy()` - marks dirty ranges for later reconciliation
- `getLineRangePrecise()` - applies offset deltas on-demand for queries

**Dirty Range Management:**
- `mergeDirtyRanges()` - consolidates overlapping ranges
- `isLineDirty()` - checks if line needs reconciliation
- `getOffsetDeltaForLine()` - computes cumulative offset delta

**Reconciliation (`src/store/line-index.ts`):**
- `reconcileRange()` - fixes offsets for specific line range
- `reconcileFull()` - rebuilds entire tree (called from idle callback)
- `reconcileViewport()` - ensures visible lines are accurate

**Store Integration (`src/store/store.ts`):**
```typescript
interface DocumentStore {
  // ...existing
  scheduleReconciliation?(): void;  // Uses requestIdleCallback
  reconcileNow?(): void;            // Synchronous reconciliation
  setViewport?(startLine: number, endLine: number): void;  // Viewport accuracy
}
```

**Performance Impact:**
| Operation | Before | After |
|-----------|--------|-------|
| Insert with newlines | O(n) immediate | O(log n) + deferred O(n) |
| Delete with newlines | O(n) immediate | O(log n) + deferred O(n) |
| Query visible line | O(log n) | O(log n) + O(d) where d = dirty ranges |
| Rapid typing | Each keystroke O(n) | Batched in idle time |

**Rendering Integration:** `getVisibleLines()` and `getVisibleLine()` now use `getLineRangePrecise()` for dirty-aware accuracy.

### Improvement 3: Add Buffer View Abstraction

Create a unified buffer abstraction that handles byte/char conversions:

```typescript
interface BufferView {
  getBytes(start: ByteOffset, end: ByteOffset): Uint8Array;
  getString(start: CharOffset, end: CharOffset): string;
  byteToChar(offset: ByteOffset): CharOffset;
  charToByte(offset: CharOffset): ByteOffset;
}
```

### Improvement 4: Event Integration with Store

The `DocumentEventEmitter` is separate from the store. Consider integrating them:

```typescript
interface DocumentStore {
  // ...existing
  on<K extends keyof DocumentEventMap>(type: K, handler: EventHandler<K>): Unsubscribe;
}
```

---

## 7. Improvement Points (Types & Interfaces)

### Type Improvement 1: Generic Tree Node

Extract common tree node structure:

```typescript
interface TreeNode<T extends TreeNode<T>> {
  readonly color: NodeColor;
  readonly left: T | null;
  readonly right: T | null;
}

interface PieceNode extends TreeNode<PieceNode> {
  readonly bufferType: BufferType;
  readonly start: number;
  readonly length: number;
  readonly subtreeLength: number;
}
```

### Type Improvement 2: Discriminated Union for Buffer Access

```typescript
type BufferReference =
  | { type: 'original'; buffer: Uint8Array }
  | { type: 'add'; buffer: Uint8Array };
```

### Type Improvement 3: Stricter Action Validation

Add runtime validation for action positions:

```typescript
interface InsertAction {
  readonly type: 'INSERT';
  readonly position: ByteOffset;  // Use branded type
  readonly text: string;
}
```

---

## 8. Improvement Points (Implementations)

### ~~Implementation Improvement 1: Optimize `replacePieceInTree`~~ ✅ IMPLEMENTED

~~Currently does a full tree traversal to find and replace a node.~~

**Fix Applied:** Now uses path from `findPieceAtPosition` for O(log n) replacement:

```typescript
function replacePieceInTree(
  _root: PieceNode,
  path: PathEntry[],
  oldNode: PieceNode,
  newNode: PieceNode
): PieceNode {
  let current = withPieceNode(newNode, {
    left: oldNode.left,
    right: oldNode.right,
  });

  // Walk back up the path in reverse - O(log n)
  for (let i = path.length - 1; i >= 0; i--) {
    const { node: parent, direction } = path[i];
    current = withPieceNode(parent,
      direction === 'left' ? { left: current } : { right: current }
    );
  }
  return current;
}
```

**Status:** ✅ Implemented

### ~~Implementation Improvement 2: Pool TextEncoder/Decoder~~ ✅ IMPLEMENTED

~~Currently creates new encoder/decoder instances per call.~~

**Fix Applied:** Added module-level singletons in both files:

**`src/store/reducer.ts:21`:**
```typescript
const textEncoder = new TextEncoder();
```

**`src/store/piece-table.ts:18-19`:**
```typescript
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
```

**Status:** ✅ Implemented

### Implementation Improvement 3: Add Buffer Pre-allocation Strategy

Current buffer growth is 2x when full:

```typescript
const newSize = Math.max(addBuffer.length * 2, addBufferLength + textBytes.length);
```

**Better:** Use a more sophisticated growth strategy based on document size patterns.

**Status:** ⚠️ Open

### Implementation Improvement 4: Streaming for Large getValue()

`getValue()` materializes the entire document. For large files, this can cause memory pressure:

```typescript
export function getValue(state: PieceTableState): string {
  const result = new Uint8Array(totalBytes);  // Full allocation
  // ...
}
```

**Better:** The `getValueStream()` already exists - document when to prefer it.

**Status:** ⚠️ Open - Documentation improvement needed

---

## 9. Learning Paths

### Entry Point: Understanding the Store

1. Start with `src/store/store.ts` - the `createDocumentStore()` factory
2. Read `src/types/state.ts` to understand `DocumentState`
3. Study `src/types/actions.ts` for action patterns

### Core Algorithm: Piece Table

1. Read `src/store/piece-table.ts` - understand `PieceNode` and buffers
2. Study `pieceTableInsert()` and `pieceTableDelete()` for edit operations
3. Understand `findPieceAtPosition()` for tree traversal

### Supporting Structure: Line Index

1. Read `src/store/line-index.ts` after understanding piece table
2. Focus on `lineIndexInsert()` and `lineIndexDelete()`
3. Understand the separate tree for O(log n) line lookups

### Advanced: Red-Black Tree Balancing

1. Study `src/store/rb-tree.ts` for generic R-B utilities
2. Understand `fixInsert()`, `rotateLeft()`, `rotateRight()`
3. See how `withPieceNode` / `withLineIndexNode` enable immutable updates

### Application: Rendering Pipeline

1. Read `src/store/rendering.ts` for viewport calculations
2. Understand `getVisibleLines()` for virtualization
3. Study `positionToLineColumn()` for coordinate conversion

### Goals for Contributors

| Goal | Key Files | Skills Needed |
|------|-----------|---------------|
| Add new action type | actions.ts, reducer.ts | TypeScript unions |
| Optimize tree operations | piece-table.ts, rb-tree.ts | R-B trees, immutability |
| Add collaboration support | events.ts, reducer.ts (APPLY_REMOTE) | CRDT concepts |
| Framework adapter | store.ts | React/Vue/Svelte hooks |

---

## 10. Test Coverage Summary

| Test File | Tests | Focus Area |
|-----------|-------|------------|
| piece-table.test.ts | 59 | Core piece table operations |
| line-index.test.ts | 35 | Line index operations |
| store.logic.test.ts | 103 | Reducer logic |
| store.usecase.test.ts | 29 | Real-world usage scenarios |
| diff.test.ts | 35 | Myers diff algorithm |
| events.test.ts | 20 | Event system |
| rendering.test.ts | 26 | Viewport calculations |
| history.test.ts | 31 | Undo/redo functionality |
| streaming.test.ts | 17 | Streaming operations |
| branded.test.ts | 19 | Branded types |

**Total: 374 tests passing**

---

## 11. Current Implementation Status

### Completed Phases

- **Phase 1:** Core Data Store (DocumentStore, actions, reducers)
- **Phase 2:** Core Document Model (Piece table, line index, tree operations)
- **Phase 4:** History & Undo (Full undo/redo with transaction support)

### Not Started

- **Phase 3:** Large File Support (Chunk loading, LRU cache)
- **Phase 5:** Framework Adapters (React, Vue, Svelte)
- **Phase 6:** Plugin System
- **Phase 7:** Collaboration (CRDT/Yjs integration)
- **Phase 8:** Polish & Optimization

---

## 12. Conclusion

The Reed codebase demonstrates excellent software engineering practices:

**Strengths:**
- Clean architecture with immutable state and pure reducers
- O(log n) operations via Red-Black tree-based piece table and line index
- Comprehensive test coverage (374 tests)
- Good separation of concerns between types and implementations
- Well-documented design specifications

**Resolved Issues:**
- ✅ Line index rebuild performance optimized for small deletions
- ✅ Transaction state cleanup now robust against errors
- ✅ TextEncoder/Decoder instances pooled as module-level singletons
- ✅ `replacePieceInTree` optimized from O(n) to O(log n)
- ✅ Byte/char conversion utilities added (`charToByteOffset`, `byteToCharOffset`)
- ✅ Branded types (`ByteOffset`) consistently used throughout codebase
- ✅ Lazy line index maintenance with dirty range tracking and background reconciliation

**Remaining Areas for Attention:**
- Buffer pre-allocation strategy could be more sophisticated
- Documentation improvement needed for when to use `getValueStream()` vs `getValue()`

**Recommendation:** The foundation is solid and ready for Phase 3 (Large File Support) implementation. All major pitfalls and Improvement 2 (Lazy Line Index Maintenance) have been addressed.

---

## 13. Changelog

### 2026-01-31 - Phase 1-3 Pitfalls Fixed

**Phase 1: Performance Optimization**
| Issue | Location | Fix |
|-------|----------|-----|
| Impl Improvement 1: `replacePieceInTree` | `piece-table.ts:384-409` | O(n) → O(log n) using path-based approach |

**Phase 2: Byte/Char Conversion Utilities**
| Issue | Location | Fix |
|-------|----------|-----|
| Pitfall 1: Byte/Char Offset | `piece-table.ts:902-965` | Added `charToByteOffset()`, `byteToCharOffset()` |
| Improvement 2: TextEncoder Pool | `reducer.ts:21`, `piece-table.ts:18-19` | Module-level singletons |
| Rendering TextEncoder | `rendering.ts` | Pooled encoder for `lineColumnToPosition()` |

**Phase 3: Branded Types Adoption**
| Issue | Location | Fix |
|-------|----------|-----|
| Pitfall 5: Branded Types | `types/actions.ts` | Action types now use `ByteOffset` |
| Function Signatures | `piece-table.ts`, `line-index.ts`, `rendering.ts` | All position params use `ByteOffset` |
| Public Exports | `index.ts` | Exported branded types and constructors |
| Test Updates | All `*.test.ts` files | Updated to use `byteOffset()` |

**Earlier Fixes**
| Issue | Location | Fix |
|-------|----------|-----|
| Pitfall 2: Line Index Rebuild | `line-index.ts:653-774` | Optimized with threshold-based incremental approach |
| Pitfall 4: Transaction State | `store.ts:153-189` | Added `finally` block with manual cleanup fallback |

All 374 tests passing after fixes.

### 2026-02-03 - Lazy Line Index Maintenance (Improvement 2)

**New Types:**
| Type | Location | Purpose |
|------|----------|---------|
| `DirtyLineRange` | `types/state.ts:89-98` | Tracks stale offset regions |
| Extended `LineIndexState` | `types/state.ts:105-116` | Added `dirtyRanges`, `lastReconciledVersion`, `rebuildPending` |

**New Functions (`line-index.ts`):**
| Function | Purpose |
|----------|---------|
| `lineIndexInsertLazy()` | O(log n) insert with deferred offset recalculation |
| `lineIndexDeleteLazy()` | Delete with dirty range marking |
| `getLineRangePrecise()` | Query with on-demand offset delta application |
| `mergeDirtyRanges()` | Consolidate overlapping dirty ranges |
| `isLineDirty()` | Check if line needs reconciliation |
| `getOffsetDeltaForLine()` | Compute cumulative offset delta |
| `reconcileRange()` | Fix offsets for specific line range |
| `reconcileFull()` | Rebuild tree with correct offsets |
| `reconcileViewport()` | Ensure visible lines are accurate |

**Store Updates (`store.ts`):**
| Method | Purpose |
|--------|---------|
| `scheduleReconciliation()` | Queue idle callback for background reconciliation |
| `reconcileNow()` | Force synchronous reconciliation |
| `setViewport()` | Reconcile visible lines immediately |

**Reducer Updates (`reducer.ts`):**
- INSERT, DELETE, REPLACE, APPLY_REMOTE now use lazy versions
- Eager versions preserved for undo/redo accuracy

**Rendering Updates (`rendering.ts`):**
- `getVisibleLines()`, `getVisibleLine()`, `positionToLineColumn()`, `lineColumnToPosition()` now use `getLineRangePrecise()`

All 374 tests passing after implementation.

---

*Report generated by Claude Opus 4.5 on 2026-01-31*
*Updated with Phase 1-3 fixes on 2026-01-31*
*Updated with Lazy Line Index Maintenance on 2026-02-03*
