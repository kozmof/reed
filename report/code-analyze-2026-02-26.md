# Reed — Code Analysis & Formalization Report

**Date:** 2026-02-26
**Version:** 0.0.0
**Lines of Source:** ~2,554 TypeScript
**Tests:** 465 passing across 11 test files

---

## Part 1: Code Analysis

### 1. Code Organization and Structure

**Reed** is an immutable text editor library built on two independent Red-Black trees: a Piece Table for raw text storage, and a Line Index for line-to-byte-offset mapping. The directory layout reflects this separation cleanly:

```
src/
├── index.ts                     # Re-exports all public APIs
├── types/                       # Branded types, cost algebra, action types, state shapes
├── store/
│   ├── core/                    # Piece table, line index, R-B tree utilities, state factories
│   └── features/                # Reducer, store, events, transactions, history, diff, rendering
└── api/                         # Public query and scan namespaces
```

The primary abstraction boundary is between *core* (data structures) and *features* (behavior). The `api/` layer provides the documented public surface, wrapping internals with complexity annotations.

---

### 2. Relations of Implementations — Types and Interfaces

#### State Hierarchy

```
DocumentState<M extends EvaluationMode>
├── PieceTableState              — text storage (mode-independent)
├── LineIndexState<M>            — position tracking (mode-sensitive)
│   └── root: LineIndexNode<M> | null
├── SelectionState               — cursor / selection ranges (byte-offset based)
├── HistoryState                 — undo / redo stacks
└── DocumentMetadata             — encoding, line endings, dirty flag
```

`EvaluationMode = 'eager' | 'lazy'` flows through `DocumentState`, `LineIndexState`, and `LineIndexNode`, toggling whether `documentOffset` is `number` or `number | null`.

#### Key Discriminated Unions

| Type | Discriminant | Members |
|------|-------------|---------|
| `BufferReference` | `bufferType` | `OriginalBufferRef`, `AddBufferRef` |
| `HistoryChange` | `type` | `insert`, `delete`, `replace` |
| `DocumentAction` | `type` | `INSERT`, `DELETE`, `REPLACE`, `SET_SELECTION`, `UNDO`, `REDO`, … |
| `NodeColor` | — | `'red'`, `'black'`, `'double-black'` |

#### Branded Types

`ByteOffset`, `CharOffset`, `ByteLength`, `LineNumber`, `ColumnNumber` are nominal wrappers over `number`. Constructors (`byteOffset()`, `charOffset()`, …) perform no validation; the type safety is purely compile-time.

---

### 3. Relations of Implementations — Functions

#### Piece Table Call Graph

```
pieceTableInsert / pieceTableDelete / pieceTableReplace
    └── bstInsert / deleteRange / splitPiece
            └── rb-tree: rotateLeft, rotateRight, fixRedViolations
                    └── createPieceNode (path-copied new nodes)
```

#### Line Index Call Graph

```
lineIndexInsert / lineIndexInsertLazy
    └── scanNewlines / splitLineNode
            └── rb-tree (shared generic rotations)

lineIndexDelete / lineIndexDeleteLazy
    └── mergeLineNodes / updateSubtreeAggregates

reconcileFull / reconcileRange / reconcileViewport
    └── Walk line index tree, fill in null documentOffset values
```

#### State Transition Pipeline (Reducer)

```
documentReducer(state, action)
    ├── validatePosition() / validateRange()
    ├── pieceTableInsert() / pieceTableDelete()    ← piece table update
    ├── lineIndex.insert() / lineIndex.delete()    ← line index update (eager or lazy)
    ├── buildHistoryChange()                       ← capture change for undo
    ├── historyPush()                              ← coalesce or append
    └── { ...state, version: state.version + 1 }  ← new immutable state
```

#### Store Layer

```
createDocumentStore()
    ├── dispatch(action) → documentReducer → notify listeners
    ├── batch(actions[]) → fold reduces → notify once
    ├── scheduleReconciliation() → requestIdleCallback / setTimeout
    └── reconcileNow() → reconcileFull() → DocumentState<'eager'>
```

---

### 4. Specific Contexts and Usages

| Context | Entry Point | Key Behavior |
|---------|-------------|--------------|
| Normal typing | `DocumentActions.insert(pos, text)` → `dispatch` | Lazy line index, coalescing history |
| Undo/Redo | `DocumentActions.undo()` → reducer | Eager line index reconstructed before replay |
| Bulk replace | `setValue(store, text)` | Myers diff → minimal edit actions |
| Viewport rendering | `query.getVisibleLines(state, start, end)` | Needs reconciled (eager) line index |
| Remote collaboration | `DocumentActions.applyRemote(changes)` | No history push, lazy line index |
| Background work | `store.scheduleReconciliation()` | `requestIdleCallback` fills null offsets |
| Streaming large files | `scan.getValueStream(state)` | Generator; O(n) allocation deferred to iteration |

---

### 5. Pitfalls

1. **Silent fallback in lazy mode rendering.** `getLineContent()` returns an empty string when the line's offset is not yet computed. There is no warning or error; callers see blank content.

2. **`primaryIndex` is unconstrained.** `SelectionState.primaryIndex` can exceed `ranges.length` with no type protection. `ranges[primaryIndex]` fails silently.

3. **Cost labels are phantom.** `LinearCost<T>`, `LogCost<T>`, etc. carry no runtime enforcement. A function returning `O(1)` cost may perform O(n) work; the type system will not catch it.

4. **Branded type constructors accept invalid values.** `byteOffset(-1)`, `byteOffset(NaN)`, `byteOffset(Infinity)` all compile. The `isValidOffset()` utility is not called automatically.

5. **Tree path ordering is implicit.** `bstInsert()` builds a path that is then `.reverse()`d. This ordering dependency is undocumented; if the traversal order changes, balancing silently breaks.

6. **`Number.MAX_SAFE_INTEGER` as a sentinel.** `DirtyLineRange.endLine` uses this magic constant to mean "to end of document". No type alias or constant enforces this; any integer would pass the type check.

7. **History coalescing mixes byte / char boundaries.** The contiguity check (`newChange.position === last.position + last.byteLength`) uses byte counts from UTF-8 encoding. If an editor layer uses character (UTF-16) positions, edits that feel adjacent may fail to coalesce.

8. **Generator cost deferral is invisible.** `getValueStream()` calls `collectPieces()` only during iteration, not at call time. The O(n) allocation occurs invisibly when the consumer first pulls from the generator.

---

### 6. Improvement Points — Design Overview

1. **Mode propagation through the public API is implicit.** Functions in `query.*` accept `DocumentState` (union mode) without communicating whether the line index is reconciled. A caller cannot safely use `getLineRange()` without checking reconciliation state first.

2. **No version-gating at mode transitions.** When `reconcileNow()` returns a `DocumentState<'eager'>`, there is no mechanism to ensure stale `DocumentState<'lazy'>` snapshots held by consumers are invalidated.

3. **Chunk loading is a stub.** The `LOAD_CHUNK` / `EVICT_CHUNK` action handlers are not implemented. The `DocumentState` already holds `metadata` for these, creating a false impression of readiness.

4. **Event delivery is not transactional.** If a listener throws midway through `notifyListeners()`, the state change has persisted but some listeners never received the event. There is no recovery path.

5. **Reconciliation is never triggered by `batch()`.** After a batch of actions that sets `rebuildPending = true`, reconciliation must be scheduled manually.

---

### 7. Improvement Points — Types and Interfaces

1. **`SelectionState.primaryIndex` has no invariant.** Ideally this would be constrained or use a smarter structure (e.g., a non-empty array with a focus indicator) that guarantees validity.

2. **`HistoryReplaceChange` has asymmetric byte length tracking.** The `byteLength` field tracks the inserted text, but the deleted `oldText` byte length must be recomputed during undo. The other change types precompute length; `replace` diverges from this pattern.

3. **`DirtyLineRange.endLine` sentinel is not type-enforced.** A type alias `type EndOfDocument = typeof Number.MAX_SAFE_INTEGER` or a tagged union would make the intent clearer and prevent bugs from alternative sentinel choices.

4. **`RBNode<T extends RBNode<T>>` does not prevent cross-type node children.** The F-bounded polymorphism is too loose; `PieceNode.left` could technically hold a `LineIndexNode` without a type error in certain generic contexts.

5. **`BufferType` is not sealed against extension.** `BufferReference` is a union, but `getPieceBuffer()` uses an `if/else` rather than exhaustive match; adding a third buffer type would silently fall through to `addBuffer`.

---

### 8. Improvement Points — Implementations

1. **`splitPiece()` assumes the split target is a leaf.** The left piece inherits `piece.left`, the right piece inherits `piece.right`. If the split target is an interior node, its existing children are relocated without re-linking; the resulting tree may be structurally invalid.

2. **`deleteRange()` has three separate boundary check styles.** The early-exit check, the left-child recurse guard, and the right-child recurse guard use different orderings of `deleteStart`, `deleteEnd`, `pieceStart`, `pieceEnd`, `subtreeEnd`. Inconsistency increases the chance of off-by-one errors across future modifications.

3. **Transaction rollback does not guard against unmatched calls.** `rollback()` pops from `snapshotStack` and decrements `depth` without checking whether a matching `begin()` was called. Calling `rollback()` an extra time decrements `depth` to `-1` silently.

4. **Lazy diff cost contract overstates worst case.** `diff()` always returns `QuadCost` even though the Myers path for D-small inputs is O((n+m)D). The inflated cost label may cause callers to avoid the function for use cases where it would be inexpensive.

5. **`getValueStream()` triggers O(n) work during iteration, not on call.** The `collectPieces()` call sits inside the generator body. Callers that hold a generator reference and delay iteration will trigger allocation at unpredictable times.

---

### 9. Learning Paths — Entries and Goals

| Goal | Entry Point | Path |
|------|-------------|------|
| Understand text storage | `src/store/core/piece-table.ts` | `createPieceTableState` → `pieceTableInsert` → `bstInsert` → `fixRedViolations` |
| Understand line tracking | `src/store/core/line-index.ts` | `lineIndexInsert` → `scanNewlines` → `splitLineNode` → `reconcileFull` |
| Understand state transitions | `src/store/features/reducer.ts` | `documentReducer` → action switch → edit pipeline |
| Understand store lifecycle | `src/store/features/store.ts` | `createDocumentStore` → `dispatch` → `notifyListeners` → `scheduleReconciliation` |
| Understand type safety system | `src/types/branded.ts` + `src/types/cost.ts` | Branded constructors → cost combinators → `$prove` / `$lift` |
| Understand public API contracts | `src/api/query.ts` | `query.getText` → `query.getVisibleLines` → `query.positionToLineColumn` |
| Understand undo/redo | `src/store/features/history.ts` | `historyPush` → coalescing → `src/store/features/reducer.ts` UNDO case |

---

## Part 2: Formalization Analysis

> Formalization is evaluated by: readability improvement, boundary clarity, testability, regularity of patterns, extension rules, value effect simplicity, TypeScript feature usage, first-reader pitfalls, and fragility under future modification.

---

### 1. Data Structures

#### 1.1 `LineIndexNode<M>` — Incomplete Parametric Constraint

`documentOffset` is typed `M extends 'eager' ? number : number | null`, but the type system does not enforce that nodes created in lazy mode actually initialize `documentOffset` to `null`. Code accepting `LineIndexNode` without specifying `M` receives the union, which obscures whether the offset is safe to use.

#### 1.2 `DirtyLineRange.endLine` — Untyped Sentinel

`endLine: number` uses `Number.MAX_SAFE_INTEGER` to represent "rest of document." This is documented in a comment but is not expressed at the type level. Any integer passes the type check, making the sentinel indistinguishable from a real line number.

#### 1.3 `RBNode<T extends RBNode<T>>` — Over-permissive Generic Bound

The F-bounded polymorphism allows `left` and `right` to be assigned any `RBNode` subtype. In certain indirect generic contexts, `PieceNode.left` could be assigned a `LineIndexNode` without a compile-time error. Generic tree operations assume same-type children but cannot enforce it.

#### 1.4 `SelectionState.primaryIndex` — No Structural Invariant

`primaryIndex: number` is unconstrained in the type. There is no non-empty array guarantee, no index bound, and no compile-time protection against `ranges[primaryIndex]` being `undefined`.

---

### 2. Interfaces

#### 2.1 `HistoryChange` — Asymmetric Field Presence

`HistoryInsertChange` and `HistoryDeleteChange` precompute `byteLength`. `HistoryReplaceChange` carries `oldText` but its byte length must be recomputed at undo time. The inconsistency means undo logic for `replace` cannot follow the same pattern as `insert`/`delete`.

#### 2.2 `LineIndexState<M>` — Mode Is Not Narrowable

`dirtyRanges` and `rebuildPending` use conditional types that resolve to a union when `M` is not fixed. There is no type guard to narrow a `LineIndexState` to a specific mode. Code that wants to assert "this state is reconciled" must inspect dirty ranges at runtime with no type-level support.

#### 2.3 `BufferReference` — Implicit Discrimination in Implementation

`getPieceBuffer()` uses `if (ref.bufferType === 'original')` rather than an exhaustive switch. A third buffer type would not cause a type error; it would silently fall through to `addBuffer`. The union type promises safety that the implementation does not deliver.

---

### 3. Algorithms

#### 3.1 RB-Tree Insertion — Implicit Path Ordering Contract

`bstInsert()` builds a path in leaf-to-root order, then `.reverse()` is called before balancing. This ordering dependency is not expressed in any type, comment, or assertion. Changing the traversal order in `bstInsert()` silently breaks balancing.

#### 3.2 `splitPiece()` — Assumes Leaf Context

When splitting, the left piece inherits `piece.left` and the right piece inherits `piece.right`. If the piece being split is an interior node, its original children are relocated without re-linking. The invariant "only split leaf-adjacent nodes" is not enforced or documented.

#### 3.3 `deleteRange()` — Inconsistent Boundary Semantics

Three separate boundary checks within the same function use different orderings of `deleteStart`, `deleteEnd`, `pieceStart`, `pieceEnd`, and `subtreeEnd`. Each check follows slightly different logic; whether the boundaries are inclusive or exclusive changes across them with no unifying convention.

#### 3.4 History Coalescing — Byte vs. Char Boundary Drift

The contiguity check `newChange.position === last.position + last.byteLength` compares byte offsets against a byte length derived from `textEncoder.encode()`. If a caller operates in char offsets and passes a char-based position, contiguous edits may fail to coalesce, or non-contiguous edits may coalesce incorrectly.

#### 3.5 Lazy Reconciliation — Mode Mismatch Not Detectable

After reconciliation, the returned `DocumentState` holds an eager line index embedded in a type that remains the union default. There is no assertion or type constraint ensuring the mode in `DocumentState.lineIndex` matches what the reducer expected.

---

### 4. Specific Implementations

#### 4.1 Cost Branding — Phantom Types Without Enforcement

`$lift('O(1)', value)` accepts any value without measuring cost. The level parameter (`_level`) is intentionally unused at runtime. Any contributor can annotate an O(n) operation as `O(1)` and the type system will not object. The cost algebra is documentation, not a contract.

#### 4.2 Branded Type Constructors — Validation Is Optional

`byteOffset(-1)`, `byteOffset(NaN)`, and `byteOffset(Infinity)` all compile and produce valid-looking `ByteOffset` values. `isValidOffset()` exists but is not called by any constructor. The branded types promise nominal safety that the constructors do not provide.

#### 4.3 `getValueStream()` — Cost Materialization Is Deferred and Invisible

`collectPieces()` is called inside the generator body, so the O(n) allocation happens during the first iteration, not at the time the generator is created. The function signature gives no indication of when this work occurs. Callers that hold the generator and iterate later trigger allocation at an unpredictable point in the call stack.

#### 4.4 Event Delivery — Half-Delivery Is Silent

In `events.ts`, if a handler throws, subsequent handlers in the same iteration still run (errors are caught). However, the caught error does not prevent the state change from having persisted. State has changed; some listeners did not receive the event. There is no mechanism to re-deliver or detect the incomplete notification.

#### 4.5 Transaction Rollback — Unmatched Calls Are Silent

`rollback()` calls `snapshotStack.pop()` and decrements `depth` without checking whether a corresponding `begin()` was called. An extra `rollback()` produces `depth = -1` and returns `snapshot = undefined`. Subsequent operations see negative depth; subsequent dispatches may notify listeners prematurely or skip notifications.

#### 4.6 `diff()` — Cost Label Overstates Worst Case

The function always returns `QuadCost<DiffResult>` even for the Myers fast path, which is O((n+m)D) where D is edit distance. For near-identical texts with small D, the actual cost is closer to linear. The inflated annotation causes callers to treat the function as inherently expensive when it may not be.

#### 4.7 `getLineContent()` — Silent Empty Return on Stale Offset

When the line index is in lazy mode and the target line's offset is not yet computed, `getLineRangePrecise()` returns `null`. The fallback is `getText(state.pieceTable, byteOffset(0), byteOffset(0))`, which returns an empty string. There is no warning, error, or distinct return value that distinguishes "line is empty" from "line offset is stale."

---

## Summary

**Reed** is architecturally coherent: immutable trees, a clean reducer pipeline, parameterized evaluation modes, and nominal type branding demonstrate deliberate design. The issues identified fall into three recurring themes:

1. **Phantom enforcement.** Cost labels, branded type constructors, and lazy mode typing all promise constraints that runtime or compile-time checks do not actually verify. Invariants that should be structural are expressed only in documentation.

2. **Implicit ordering and context dependencies.** R-B tree path ordering, `splitPiece` leaf assumptions, and the `Number.MAX_SAFE_INTEGER` sentinel are conventions that exist outside the type system. They will be bypassed or misunderstood as the codebase grows.

3. **Silent failures at mode boundaries.** Lazy-to-eager transitions, half-delivered events, and stale offset fallbacks all degrade silently. A caller that receives wrong data (empty line, missed notification, incorrect undo) has no signal that something went wrong.
