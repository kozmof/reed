# Reed Text Editor - Code Analysis Report

**Date:** 2026-02-03

## 1. Code Organization and Structure

### Directory Layout
```
reed/
├── src/
│   ├── index.ts           # Main entry point, re-exports
│   ├── types/             # Type definitions
│   │   ├── index.ts       # Type re-exports
│   │   ├── state.ts       # Core state types (DocumentState, PieceTableState, etc.)
│   │   ├── actions.ts     # Action types and type guards
│   │   ├── store.ts       # Store interfaces
│   │   └── branded.ts     # Branded types for ByteOffset, CharOffset, etc.
│   └── store/             # Implementation
│       ├── index.ts       # Store module re-exports
│       ├── store.ts       # DocumentStore factory implementation
│       ├── state.ts       # State factory functions
│       ├── reducer.ts     # Pure reducer for state transitions
│       ├── piece-table.ts # Piece table operations (insert, delete, getText)
│       ├── line-index.ts  # Line index operations (1400+ lines)
│       ├── rb-tree.ts     # Generic Red-Black tree utilities
│       ├── events.ts      # Event emitter system
│       ├── rendering.ts   # Virtualized rendering utilities
│       ├── diff.ts        # Myers diff algorithm and setValue
│       ├── actions.ts     # Action creators
│       └── history.ts     # History helper functions
├── spec/                  # Specification documents
└── public/                # Static assets
```

### Architectural Pattern
The codebase follows a **Redux-like pattern with pure functions**:
- Immutable state managed by a store
- Actions as serializable commands
- Pure reducer function for state transitions
- Structural sharing for efficient updates

---

## 2. Relations of Implementations (Types/Interfaces)

### Core Type Hierarchy

```
DocumentState (Root)
├── version: number
├── pieceTable: PieceTableState
│   ├── root: PieceNode | null
│   │   └── RBNode<PieceNode> (color, left, right)
│   │       └── bufferType, start, length, subtreeLength
│   ├── originalBuffer: Uint8Array
│   ├── addBuffer: Uint8Array
│   ├── addBufferLength: number
│   └── totalLength: number
├── lineIndex: LineIndexState
│   ├── root: LineIndexNode | null
│   │   └── RBNode<LineIndexNode>
│   │       └── documentOffset, lineLength, subtreeLineCount, subtreeByteLength
│   ├── lineCount: number
│   ├── dirtyRanges: DirtyLineRange[]
│   └── rebuildPending: boolean
├── selection: SelectionState
│   ├── ranges: SelectionRange[]
│   └── primaryIndex: number
├── history: HistoryState
│   ├── undoStack: HistoryEntry[]
│   ├── redoStack: HistoryEntry[]
│   └── limit: number
└── metadata: DocumentMetadata
```

### Store Interface Hierarchy

```
DocumentStore (base)
├── subscribe(listener): Unsubscribe
├── getSnapshot(): DocumentState
├── dispatch(action): DocumentState
└── batch(actions): DocumentState

DocumentStoreWithEvents extends DocumentStore
├── addEventListener(type, handler): Unsubscribe
├── removeEventListener(type, handler): void
└── events: DocumentEventEmitter
```

### Branded Types
`src/types/branded.ts` provides compile-time type safety:
- `ByteOffset` - UTF-8 byte positions (piece table internal)
- `CharOffset` - UTF-16 code unit positions (JavaScript strings)
- `LineNumber` - 0-indexed line numbers
- `ColumnNumber` - 0-indexed column positions

---

## 3. Relations of Implementations (Functions)

### Function Dependency Graph

```
createDocumentStore()
└── createInitialState()
    ├── createPieceTableState(content)
    └── createLineIndexState(content)

dispatch(action)
└── documentReducer(state, action)
    ├── INSERT
    │   ├── pieceTableInsert() → ptInsert()
    │   ├── lineIndexInsertLazy() → liInsertLazy()
    │   └── historyPush()
    ├── DELETE
    │   ├── getText() [capture deleted text]
    │   ├── pieceTableDelete() → ptDelete()
    │   ├── lineIndexDeleteLazy() → liDeleteLazy()
    │   └── historyPush()
    ├── UNDO/REDO
    │   ├── historyUndo()/historyRedo()
    │   └── applyInverseChange()/applyChange()
    └── ...

getValue(pieceTable)
├── collectPieces(root)
└── getPieceBuffer(state, piece)

getVisibleLines(state, config)
├── getLineRangePrecise(lineIndex, lineNumber)
└── getText(pieceTable, start, end)
```

### Red-Black Tree Operations Shared Pattern
`src/store/rb-tree.ts` provides generic R-B tree utilities:
- `rotateLeft()`, `rotateRight()` - Tree rotations
- `fixRedViolations()` - Balance violations
- `fixInsert()` - Complete rebalancing after insert

Both `PieceNode` and `LineIndexNode` use these via `WithNodeFn<N>` callback pattern.

---

## 4. Specific Contexts and Usages

### Primary Use Cases

1. **Creating an Editor Store**
   ```typescript
   const store = createDocumentStore({ content: 'Hello World' });
   ```

2. **Text Editing Operations**
   ```typescript
   store.dispatch(DocumentActions.insert(byteOffset(5), ' Amazing'));
   store.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(5)));
   ```

3. **Reading Document State**
   ```typescript
   const state = store.getSnapshot();
   const content = getValue(state.pieceTable);
   const line = getVisibleLine(state, 0);
   ```

4. **Event-Based Updates**
   ```typescript
   const storeWithEvents = createDocumentStoreWithEvents({ content });
   storeWithEvents.addEventListener('content-change', (event) => {
     console.log('Changed:', event.affectedRange);
   });
   ```

5. **Virtualized Rendering**
   ```typescript
   const visible = getVisibleLines(state, {
     startLine: 0,
     visibleLineCount: 50,
     overscan: 5,
   });
   ```

6. **Large File Streaming**
   ```typescript
   for (const chunk of getValueStream(pieceTable, { chunkSize: 64 * 1024 })) {
     process(chunk.content);
   }
   ```

---

## 5. Pitfalls

### 5.1 Byte vs Character Offset Confusion
**Problem**: The piece table internally uses UTF-8 byte offsets, but JavaScript strings use UTF-16 code units.

**Location**: Throughout `src/store/piece-table.ts`, `src/store/reducer.ts`

**Mitigation**: Use branded types (`ByteOffset`, `CharOffset`) and conversion functions (`charToByteOffset`, `byteToCharOffset`).

### 5.2 Lazy Line Index Reconciliation
**Problem**: Line index updates are lazy (deferred to idle time), so `documentOffset` values may be stale.

**Location**: `src/store/line-index.ts:1015-1196`

**Mitigation**: Use `getLineRangePrecise()` which applies dirty range deltas, or call `reconcileViewport()` before rendering.

### 5.3 Transaction Rollback Edge Cases
**Problem**: Nested transactions share the same snapshot, so rollback resets to the outermost transaction state.

**Location**: `src/store/store.ts:140-148`

**Impact**: Cannot partially rollback nested transactions.

### 5.4 History Entry Text Capture Timing
**Problem**: For DELETE/REPLACE, the deleted text must be captured *before* applying the operation.

**Location**: `src/store/reducer.ts:429-441`

**Mitigation**: The reducer correctly calls `getTextRange()` before `pieceTableDelete()`.

### 5.5 Selection Not Auto-Updated on Edit
**Problem**: Dispatching INSERT/DELETE does not automatically update selection positions.

**Location**: `src/store/reducer.ts` - no selection adjustment logic

**Mitigation**: Consumers must dispatch `SET_SELECTION` separately after edits.

### 5.6 Add Buffer Growth Strategy
**Problem**: Add buffer doubles in size when full, which can cause memory spikes.

**Location**: `src/store/piece-table.ts:315-323`

**Mitigation**: Consider `compactAddBuffer()` when waste ratio exceeds threshold.

---

## 6. Improvement Points (Design Overview)

### 6.1 Missing Cursor Management
**Issue**: No automatic cursor/selection adjustment when text is inserted/deleted.
**Recommendation**: Add selection transformation logic to the reducer for edit actions.

### 6.2 No Undo Grouping Timeout
**Issue**: Each action creates a separate history entry; no auto-grouping of rapid keystrokes.
**Recommendation**: Add a `coalesceTimeout` option to group edits within a time window.

### 6.3 Line Index Rebuild is O(n)
**Issue**: `deleteRange` with newlines triggers full tree rebuild via `rebuildWithDeletedRange`.
**Recommendation**: Implement incremental R-B tree deletion to maintain O(log n).

### 6.4 No Memory Pressure Handling
**Issue**: Large files load entirely into memory (originalBuffer + addBuffer).
**Recommendation**: Implement Phase 3 (chunk-based loading with LRU eviction).

### 6.5 Event Emission During Batch
**Issue**: `batch()` emits events for each action, not a single consolidated event.
**Recommendation**: Aggregate events during transaction and emit once on commit.

---

## 7. Improvement Points (Types/Interfaces)

### 7.1 `position` Field Inconsistency
**Issue**: Actions use `position` (INSERT), `start/end` (DELETE, REPLACE) inconsistently.
```typescript
InsertAction: { position: ByteOffset, text: string }
DeleteAction: { start: ByteOffset, end: ByteOffset }
```
**Recommendation**: Unify to `{ start, end?, text? }` or `{ range: [start, end], text? }`.

### 7.2 Missing Generic Constraints on RBNode
**Issue**: `RBNode<any>` default allows unsafe operations.
**Recommendation**: Remove default: `interface RBNode<T extends RBNode<T>>`.

### 7.3 SelectionRange Should Use Branded Types
**Issue**: `SelectionRange` uses raw `number` instead of `ByteOffset`.
```typescript
interface SelectionRange {
  readonly anchor: number;  // Should be ByteOffset
  readonly head: number;    // Should be ByteOffset
}
```

### 7.4 Missing `readonly` on Array Returns
**Issue**: Some functions return mutable arrays that could be accidentally modified.
**Example**: `collectPieces()` returns `PieceNode[]`, not `readonly PieceNode[]`.

### 7.5 Discriminated Union for BufferReference
**Strength**: Good use of discriminated union with `kind` field.
**Note**: This is well-designed and should be maintained.

---

## 8. Improvement Points (Implementations)

### 8.1 TextEncoder/Decoder Reuse
**Good**: Module-level singletons are used (e.g., `src/store/piece-table.ts:21-22`).
**Issue**: Some files create new instances in hot paths (e.g., `src/store/events.ts:295`).
**Recommendation**: Use shared encoders throughout.

### 8.2 collectBytesInRange Uses Push Loop
**Location**: `src/store/piece-table.ts:660-694`
**Issue**: `result.push()` in a loop can be slow for large ranges.
**Recommendation**: Pre-allocate array or use `Uint8Array.set()`.

### 8.3 Myers Diff Memory Allocation
**Location**: `src/store/diff.ts:163-196`
**Issue**: Creates new arrays for each trace step: `trace.push([...v])`.
**Recommendation**: Use typed arrays or optimize for common cases.

### 8.4 Line Index Deletion Still O(n)
**Location**: `src/store/line-index.ts:697-757`
**Issue**: `rebuildWithDeletedRange` collects all lines then rebuilds tree.
**Recommendation**: Implement true R-B tree node deletion.

### 8.5 Duplicate Code in Lazy vs Eager Operations
**Issue**: `lineIndexInsert` and `lineIndexInsertLazy` share 80% code.
**Recommendation**: Extract shared logic into internal functions.

### 8.6 getBufferStats Iterates All Pieces
**Location**: `src/store/piece-table.ts:809-830`
**Issue**: O(n) to compute stats.
**Recommendation**: Track stats incrementally in PieceTableState.

---

## 9. Learning Paths (Entries and Goals)

### Path 1: Understanding the Core Data Model
**Entry Point**: `SPEC.md` → `spec/01-core-architecture.md`
**Files to Read**:
1. `src/types/state.ts` - Core state types
2. `src/store/state.ts` - State factory functions
3. `src/store/piece-table.ts` - Piece table operations
4. `src/store/rb-tree.ts` - R-B tree utilities

**Goal**: Understand how text is stored in buffers and organized in R-B trees.

### Path 2: Understanding the Store Pattern
**Entry Point**: `src/types/store.ts`
**Files to Read**:
1. `src/types/actions.ts` - Action definitions
2. `src/store/reducer.ts` - State transitions
3. `src/store/store.ts` - Store implementation

**Goal**: Understand the Redux-like dispatch pattern and immutable updates.

### Path 3: Line Index and Rendering
**Entry Point**: `src/store/line-index.ts`
**Files to Read**:
1. Line index core operations (lines 1-600)
2. Lazy maintenance and reconciliation (lines 920-1477)
3. `src/store/rendering.ts` - Virtualized rendering

**Goal**: Understand O(log n) line lookups and viewport reconciliation.

### Path 4: History and Undo/Redo
**Entry Point**: `src/types/state.ts` (HistoryState section)
**Files to Read**:
1. `src/store/reducer.ts:175-355` - History operations
2. `src/store/history.ts` - Helper functions

**Goal**: Understand undo/redo with selection restoration.

### Path 5: Diff and setValue
**Entry Point**: `src/store/diff.ts`
**Topics Covered**:
1. Myers diff algorithm (lines 45-200)
2. Edit consolidation (lines 335-356)
3. Byte/string offset conversion (lines 439-450)
4. setValue with transaction batching (lines 551-591)

**Goal**: Understand efficient bulk content replacement.

---

## Summary

**Reed** is a well-architected text editor library implementing:
- **Piece Table** with Red-Black trees for O(log n) edits
- **Separate Line Index** for O(log n) line lookups
- **Immutable State** with structural sharing
- **Redux-like Store** pattern compatible with any framework
- **Lazy Reconciliation** for viewport-focused performance

**Completion Status**: Phases 1, 2, 4 complete (348 tests passing). Phases 3, 5, 6, 7, 8 not started.

**Key Strengths**:
- Clean separation of concerns (piece table vs line index)
- Type-safe branded types for position handling
- Framework-agnostic store interface
- Comprehensive test coverage

**Areas for Improvement**:
- Selection auto-adjustment on edits
- True O(log n) line index deletion
- Large file chunk-based loading (Phase 3)
- Event consolidation during batches
