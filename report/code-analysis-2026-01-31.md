# Reed - Code Analysis Report

**Date:** 2026-01-31
**Analyzer:** Claude Opus 4.5
**Project:** Reed Text Editor Library
**Version:** 0.0.0

---

## Executive Summary

Reed is a high-performance text editor library written in Vanilla TypeScript, designed as an embeddable NPM package targeting both browser and desktop environments (Electron/Tauri). The codebase demonstrates strong architectural foundations with immutable data structures, pure functional patterns, and comprehensive test coverage.

| Metric | Value |
|--------|-------|
| Total Source Lines | ~9,300 |
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
│   │   ├── store.ts          # Store factory & state management (204 lines)
│   │   ├── reducer.ts        # Pure reducer function (507 lines)
│   │   ├── state.ts          # State factory functions (315 lines)
│   │   ├── actions.ts        # Action creators (165 lines)
│   │   ├── piece-table.ts    # Piece table with R-B tree (1,034 lines)
│   │   ├── line-index.ts     # Line index with R-B tree (751 lines)
│   │   ├── rb-tree.ts        # Generic R-B tree utilities (212 lines)
│   │   ├── diff.ts           # Myers diff algorithm (611 lines)
│   │   ├── events.ts         # Event pub/sub system (306 lines)
│   │   ├── history.ts        # Undo/redo helpers (56 lines)
│   │   ├── rendering.ts      # Viewport virtualization (345 lines)
│   │   ├── index.ts          # Store module exports (118 lines)
│   │   └── *.test.ts         # Comprehensive test suite (2,500+ lines)
│   └── types/                # Type definitions
│       ├── state.ts          # Core state types (225 lines)
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
│   └── LineIndexNode (R-B tree)
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

**Issue Identified:** The branded types are defined but **not consistently used** throughout the codebase. Most functions use plain `number` instead of the branded types.

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
- `lineIndexInsert()` → `rbInsertLine()` → `fixInsert()`
- `lineIndexDelete()` → `rebuildWithDeletedRange()`
- `findLineAtPosition()` / `findLineByNumber()` for queries

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

### Pitfall 1: Byte vs Character Offset Confusion

The piece table operates on **byte offsets** (UTF-8), but JavaScript strings use UTF-16 indices. This can cause issues with multi-byte characters.

**Location:** `src/store/reducer.ts:149-158`

```typescript
// Uses TextEncoder to get byte length
newPosition = change.position + new TextEncoder().encode(change.text).length;
```

**Risk:** Consumers might pass string indices directly to INSERT/DELETE actions expecting character positions.

### Pitfall 2: Line Index Rebuild Performance

The `deleteLineRange()` function rebuilds the entire line tree by collecting all lines and reconstructing:

**Location:** `src/store/line-index.ts:653-688`

```typescript
function rebuildWithDeletedRange(...): LineIndexState {
  const lines = collectLines(root);  // O(n)
  // ... rebuild from scratch
  const newRoot = buildBalancedTree(newLines, 0, newLines.length - 1);
}
```

**Risk:** Frequent deletions crossing newlines could degrade to O(n) per operation.

### Pitfall 3: Immutable Tree Overhead

Every tree modification creates new nodes up the path. For deeply nested operations, this creates many intermediate objects.

**Location:** `src/store/piece-table.ts:381-415` - `replacePieceInTree` does a full tree traversal

### Pitfall 4: Transaction State in Store Closure

Transaction state is mutable within the closure:

```typescript
const transaction: TransactionState = {
  depth: 0,
  snapshotBeforeTransaction: null,
  pendingActions: [],
};
```

**Risk:** If an error occurs during transaction, the depth might not reset properly (though rollback handles this).

### Pitfall 5: Unused Branded Types

Branded types are defined but the actual operations use plain `number`:

```typescript
// In piece-table.ts:
export function pieceTableInsert(
  state: PieceTableState,
  position: number,  // Should be ByteOffset
  text: string
): PieceTableState
```

---

## 6. Improvement Points (Design Overview)

### Improvement 1: Adopt Branded Types Consistently

Convert all position parameters to use `ByteOffset` or `CharOffset` branded types.

**Before:**
```typescript
function pieceTableInsert(state: PieceTableState, position: number, text: string)
```

**After:**
```typescript
function pieceTableInsert(state: PieceTableState, position: ByteOffset, text: string)
```

### Improvement 2: Lazy Line Index Maintenance

Instead of rebuilding the entire tree on deletions, implement an incremental update strategy:
- Track dirty ranges
- Defer full rebuilds to idle time
- Use a "rope" structure for the line index

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

### Implementation Improvement 1: Optimize `replacePieceInTree`

Currently does a full tree traversal to find and replace a node. Use the path from `findPieceAtPosition` instead.

**Current:** O(n) traversal in `src/store/piece-table.ts:381-415`

**Better:** Use zipper pattern with path for O(log n) replacement

### Implementation Improvement 2: Pool TextEncoder/Decoder

Currently creates new encoder/decoder instances per call:

```typescript
const encoder = new TextEncoder();
const textBytes = encoder.encode(text);
```

**Better:** Use module-level singleton:

```typescript
const encoder = new TextEncoder();
const decoder = new TextDecoder();
```

### Implementation Improvement 3: Add Buffer Pre-allocation Strategy

Current buffer growth is 2x when full:

```typescript
const newSize = Math.max(addBuffer.length * 2, addBufferLength + textBytes.length);
```

**Better:** Use a more sophisticated growth strategy based on document size patterns.

### Implementation Improvement 4: Streaming for Large getValue()

`getValue()` materializes the entire document. For large files, this can cause memory pressure:

```typescript
export function getValue(state: PieceTableState): string {
  const result = new Uint8Array(totalBytes);  // Full allocation
  // ...
}
```

**Better:** The `getValueStream()` already exists - document when to prefer it.

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
| piece-table.test.ts | 79 | Core piece table operations |
| line-index.test.ts | 70 | Line index operations |
| store.logic.test.ts | 119 | Reducer logic |
| store.usecase.test.ts | 37 | Real-world usage scenarios |
| diff.test.ts | 52 | Myers diff algorithm |
| events.test.ts | 18 | Event system |
| rendering.test.ts | 36 | Viewport calculations |
| history.test.ts | 24 | Undo/redo functionality |
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

**Key Areas for Attention:**
- Byte vs character offset confusion (pitfall for multi-byte characters)
- Branded types are defined but not consistently used
- Line index rebuilds can be O(n) for deletions crossing newlines
- TextEncoder/Decoder instances are recreated frequently

**Recommendation:** The foundation is solid and ready for Phase 3 (Large File Support) implementation. Before proceeding, consider adopting branded types consistently to prevent position-related bugs.

---

*Report generated by Claude Opus 4.5 on 2026-01-31*
