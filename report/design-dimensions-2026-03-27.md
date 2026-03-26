# Reed — Design Dimensions Analysis

**Date**: 2026-03-27
**Scope**: Full codebase (`src/`)

---

## Part 1: Design Dimensions

### Dimension 1: Persistent Immutable Data Structures

The entire state graph is built from immutable structural sharing. `PieceTableState`, `LineIndexState`, and `DocumentState` are all value objects — mutations produce new trees sharing unchanged subtrees. The `withPieceNode` / `withLineIndexNode` helpers enforce this consistently, and `Object.freeze()` is applied throughout.

**Key deviation from textbook**: Classic persistent RB-trees replace entire paths. Reed's version also recalculates subtree aggregates (`subtreeLength`, `subtreeAddLength`) inline during path reconstruction, turning the tree into a prefix-sum structure — eliminating a separate aggregation pass.

---

### Dimension 2: Dual-Mode Lazy/Eager Evaluation

`LineIndexState<M extends EvaluationMode>` is parameterized on `'lazy' | 'eager'` at the TypeScript level. This is the architectural center of gravity:

- **Lazy mode** (normal editing): new line offsets are recorded as `null`; dirty ranges accumulate.
- **Eager mode** (post-reconciliation / undo-redo): all offsets are `number` — no null allowed.

The discriminant is enforced at compile time: `getLineRange()` only accepts `DocumentState<'eager'>`. The type system, not runtime guards, separates the two worlds.

**Key deviation**: Rather than a simple dirty-flag, the system tracks an array of `DirtyLineRange` records with per-range `offsetDelta`, enabling O(K+V) targeted reconciliation instead of always-full O(n) rebuilds. When range count exceeds 32, a sentinel collapses this to a scheduled full rebuild.

---

### Dimension 3: Generic Red-Black Tree via Higher-Kinded Abstraction

`rb-tree.ts` defines a single set of rotation and balancing functions parameterized by `WithNodeFn<N extends RBNode<N>>`. Both the piece table and the line index use this same code — they differ only in their `withNode` implementation (which recomputes their respective subtree aggregates).

**Design intent**: This is a form of structural subtyping used as a substitute for higher-kinded types (unavailable in TypeScript). The pattern cleanly separates tree-shape invariants (handled generically) from subtree-aggregate semantics (handled concretely per tree type).

---

### Dimension 4: Cost Algebra for Complexity Proofs

`src/types/cost.ts` introduces a type-level cost algebra — `ConstCost`, `LogCost`, `LinearCost`, `NLogNCost`, `QuadCost` — composed via `$declare`, `$prove`, `$lift`, `$pipe`, `$map`. Functions annotate their complexity claims, and the algebra enforces that composed claims are consistent.

**Unusual choice**: This is not a standard pattern in editors. It reflects a design philosophy where algorithmic complexity is a first-class specification concern, not just documentation. The cost proofs serve as machine-checked comments that survive refactoring.

---

### Dimension 5: Strategy Pattern for Edit Pipelines

`applyEdit` in the reducer delegates line-index updates to a `LineIndexStrategy` object, choosing between `eagerStrategy` and `lazyStrategy(version)` at dispatch time. The edit pipeline itself is mode-agnostic — it calls `strategy.insert(...)` and `strategy.delete(...)` without conditionals.

**Deviation from classic Strategy**: Rather than a class hierarchy, strategies are plain objects of functions (`{ insert, delete }`). This keeps them stateless, composable, and tree-shakeable — closer to functional composition than OOP.

---

### Dimension 6: Persistent Cons-List for History

`PStack<T>` is a singly-linked persistent cons-list (`null | { top: T, rest: PStack<T>, size: number }`). Both `undoStack` and `redoStack` use it. Push/pop are O(1) and share structure, dropping snapshot overhead from O(K×H) to O(K) (K = document size, H = history depth).

**Contrast with the rest**: Most of the codebase uses arrays for small collections. The PStack design was chosen specifically because history stacks are frequently snapshotted whole (every dispatch copies the entire `DocumentState`). The cons-list makes those copies free — the "snapshot" of the stack is just the pointer to its head.

---

### Dimension 7: Closure-Based Encapsulation (Anti-Class)

`createDocumentStore()`, `createTransactionManager()`, `createDocumentStoreWithEvents()` — all are factory functions returning object literals with closures over private mutable state (`listeners`, `currentState`, `snapshotStack`). No classes appear in the store layer.

**Design intent**: This achieves private mutable state without TypeScript's `private` keyword (which is erased at runtime and bypassable). Closures provide true encapsulation — the internal state is unreachable by callers. The public interface is a plain object, making it trivially serializable and testable.

---

### Dimension 8: Reconciliation Scheduling as a State Machine

`scheduleReconciliation` / `reconcileNow` / `reconcileIfCurrent` form a small state machine around background work:

- `scheduleReconciliation` — version-neutral, fires via `requestIdleCallback` (or 200ms `setTimeout`).
- `reconcileNow` — user-visible, increments version, returns `DocumentState<'eager'>`.
- `reconcileIfCurrent(snapshot)` — snapshot-gated: returns `null` if a newer dispatch has occurred.

**Key insight**: The version-gate on `reconcileIfCurrent` is what makes background reconciliation safe without locking. It's an optimistic-concurrency approach — the background task checks freshness before committing its result.

---

### Dimension 9: Discriminated Union–Driven Domain Model

Virtually every multi-variant concept uses a discriminated union with a `kind` / `type` field:
- `DirtyLineRange`: `'range' | 'sentinel'`
- `EditOperation`: `'insert' | 'delete' | 'replace'`
- `DocumentAction`: 12+ action kinds
- `BufferReference`: `'original' | 'add'`

This enables exhaustive `switch` narrowing throughout. Optional-field guards (`if (op.deleteEnd !== undefined)`) are absent — the type system enforces which fields exist per variant. Adding a new variant is a compile-time breaking change, caught at every switch site.

---

## Part 2: How the Dimensions Drive Each Other

---

### Interaction 1: Immutability is the precondition for PStack correctness

PStack's O(1) snapshot claim rests entirely on the immutability guarantee. When `historyPush` stores a `HistoryEntry` in the cons-list, it shares that node with all future stack states. If `HistoryEntry` were mutable, any later modification would silently corrupt earlier snapshots.

The code enforces this with `Object.freeze()` at every boundary:

```typescript
// reducer.ts:311-316
const mergedEntry: HistoryEntry = Object.freeze({
  changes: Object.freeze([merged]),
  selectionBefore: lastEntry.selectionBefore,
  selectionAfter,
  timestamp: now,
});
```

The same guarantee is what makes transaction snapshots cheap. When `TRANSACTION_START` captures the current `DocumentState` (which contains `HistoryState` with `PStack<HistoryEntry>`), it doesn't clone the stack — it just holds the reference. The whole history is "copied" in O(1). Without immutability, every transaction begin would require O(H) history duplication.

**The arrow**: Immutability → PStack structural sharing is valid → Transaction snapshots are O(1).

---

### Interaction 2: The Lazy/Eager divide is enforced by three mechanisms simultaneously

Three separate mechanisms enforce the eager/lazy boundary, and all three must agree:

**Level 1 — Types** (`state.ts:116`, `state.ts:207-211`):
```typescript
documentOffset: M extends 'eager' ? number : number | null;
dirtyRanges: M extends 'eager' ? readonly [] : readonly DirtyLineRange[];
rebuildPending: M extends 'eager' ? false : boolean;
```

**Level 2 — Strategy injection** (`reducer.ts:576-577`):
```typescript
function applyEdit(state: DocumentState, op: EditOperation): DocumentState {
  const strategy = lazyStrategy(nextVersion);  // always lazy for normal edits
```
vs. undo/redo, which pre-reconcile then use `eagerStrategy`.

**Level 3 — Runtime assertion** (`reducer.ts:467`):
```typescript
function applyChange(state: DocumentState, change: HistoryChange): DocumentState {
  const li = asEagerLineIndex(state.lineIndex); // throws if not eager
```

None of the three mechanisms is sufficient alone. Types can be bypassed with `as`. Strategy selection could be called with the wrong strategy. The runtime check would have no way to distinguish lazy/eager without the type-level distinction. All three are necessary and enforce the same invariant at different phases.

---

### Interaction 3: The DirtyLineRange sentinel is the discriminated union's escape hatch from the Strategy Pattern

The lazy strategy accumulates dirty ranges. When those ranges exceed 32, `mergeDirtyRanges` produces a `DirtyLineRangeSentinel` (`kind: 'sentinel'`). At reconciliation time, the sentinel triggers a full linear rebuild instead of the incremental path.

The two variants of `DirtyLineRange` encode two fundamentally different downstream behaviors: targeted O(K+V) patch vs. full O(n) linear rebuild. The `kind` discriminant makes the branching structurally visible — it's not an implicit threshold check, it's encoded in the type.

Additionally, `EditOperation.kind` is what makes the `needsRebuild` decision (for CRLF) computable once, upfront, before any mutations (`reducer.ts:584-588`):

```typescript
const needsRebuild = op.kind !== 'insert'
  && shouldRebuildLineIndexForDelete(op.deletedText, deleteContext);
```

If this were optional-field guarded (`op.deleteEnd !== undefined`), the decision would be re-evaluated in both delete and insert phases with inconsistent state.

**The arrow**: Discriminated union on `EditOperation` → single upfront rebuild decision → no scattered conditionals across the mutation sequence.

---

### Interaction 4: F-bounded polymorphism is the load-bearing joint between the Generic RB-tree and Immutability

`RBNode<T extends RBNode<T>>` is F-bounded (`state.ts:56-60`):
```typescript
export interface RBNode<T extends RBNode<T>> {
  readonly color: NodeColor;
  readonly left: T | null;
  readonly right: T | null;
}
```

This means `PieceNode.left` is `PieceNode | null`, not `RBNode<PieceNode> | null`. Without F-bounded polymorphism, `WithNodeFn<N>` would return a generic `RBNode`, and `rotateLeft` would produce an `RBNode<PieceNode>` — losing all the concrete aggregate fields (`subtreeLength`, `subtreeAddLength`) that make the tree a prefix-sum structure.

The F-bound is what allows the generic rotation to produce an `N` (e.g., `PieceNode`) with all its concrete fields recalculated by `withNode`. Without it, the rotations would produce structurally-correct but aggregate-incorrect trees — the subtree byte lengths would be stale after every rotation.

**The arrow**: F-bounded `RBNode<T>` → `WithNodeFn<N>` can return `N` (not just `RBNode`) → rotations remain aggregate-correct after each structural change → prefix-sum positional queries are correct.

---

### Interaction 5: PStack coalescing is O(1) — and this is only true because of the cons-list structure

In `historyPush`, coalescing pops the top entry, merges it, and pushes the result (`reducer.ts:317-323`):

```typescript
const [, restUndo] = pstackPop(history.undoStack!);
return withState(state, {
  history: Object.freeze({
    ...history,
    undoStack: pstackPush(restUndo, mergedEntry),
    redoStack: null,
  }),
});
```

`pstackPop` is `[s.top, s.rest]` — O(1), returns the tail by pointer. `pstackPush` is `{ top: v, rest: s, size: ... }` — O(1), allocates one node. Coalescing is two O(1) operations.

With an array: `[...history.undoStack.slice(0, -1), mergedEntry]` — O(H) copy. For a fast typist with a 1000-entry history, every keystroke would copy 999 entries just to merge the last two.

Similarly, `pstackTrimToSize` is O(limit), walking only the top `limit` nodes. An array version would be O(H) to convert, O(1) to slice, O(limit) to reconstruct — the O(H) term eliminated.

**The interaction**: The coalescing algorithm in `historyPush` was designed assuming O(1) pop/push. The PStack was chosen specifically to make that assumption true.

---

### Interaction 6: Reconciliation's version-neutral design creates a subtle contract with consumers

`scheduleReconciliation` (`store.ts:282-295`) updates state without incrementing version:

```typescript
setState(Object.freeze({
  ...state,
  lineIndex: newLineIndex,
  // state.version is intentionally unchanged
}));
notifyListeners();  // notified, but version didn't change
```

vs. `reconcileNow` (`store.ts:331-338`) which bumps version:

```typescript
const nextVersion = state.version + 1;
setState(Object.freeze({ ...state, lineIndex: newLineIndex, version: nextVersion }));
```

Background reconciliation notifies listeners but does NOT bump the version. This creates an implicit contract: consumers must use `getSnapshot()` reference comparison, not `snapshot.version`, to detect the reconciliation update. A consumer comparing `prevSnapshot.version !== newSnapshot.version` would silently miss the moment when null offsets become valid.

`reconcileIfCurrent` uses referential identity (`snapshot === state`), not version comparison. A consumer holding a snapshot from two dispatches ago gets `null` — it cannot reconcile stale state.

**The interaction**: Version-neutral background reconciliation + reference-gated `reconcileIfCurrent` + lazy/eager type split together define a precise contract: "if you want accurate offsets, hold the current snapshot and call `reconcileIfCurrent`, not just check the version."

---

### Interaction 7: The `_pstackBrand` unique symbol mirrors `_nodeKind` — both prevent unauthorized construction, for different reasons

`PStack` uses a branded unique symbol to prevent external construction (`state.ts:335-337`):

```typescript
declare const _pstackBrand: unique symbol;
type PStackCons<T> = { readonly top: T; readonly rest: PStack<T>; readonly size: number; readonly [_pstackBrand]: true };
```

`_pstackBrand` is not exported. External code cannot create a `PStackCons<T>` without `as unknown as PStack<T>`. This gates construction to `pstackPush`, ensuring the `size` invariant holds by construction.

`PieceNode` and `LineIndexNode` use `_nodeKind: 'piece'` / `_nodeKind: 'lineIndex'` for a similar-looking but different purpose — runtime distinguishability in generic RB-tree contexts, not construction gatekeeping.

**The contrast**: `_nodeKind` is a visible discriminant for consumer narrowing at union sites. `_pstackBrand` is an invisible brand for construction discipline — there's never a union of two PStack types that needs narrowing.

---

### Interaction 8: `WithNodeFn` forces aggregate recalculation on every structural change — which is what makes prefix-sum queries possible

Every rotation in `rb-tree.ts` calls `withNode` immediately after modifying a child pointer. `withNode` for a `PieceNode` recalculates `subtreeLength` and `subtreeAddLength` from the new children. `withNode` for a `LineIndexNode` recalculates `subtreeLineCount`, `subtreeByteLength`, and `subtreeCharLength`.

This means after any rotation, the subtree aggregates are immediately correct — no deferred recalculation pass. The consequence: `findPieceAtPosition(root, position)` descends the tree in O(log n) by comparing `position` against `node.left.subtreeLength` to decide which subtree to enter.

If `withNode` were allowed to skip aggregate recalculation (e.g., to save allocations), `rotateLeft` would produce a tree where the rotated node has stale `subtreeLength`. The prefix-sum property would be violated, and positional queries would produce wrong results.

**The arrow**: `WithNodeFn` contract (always recalculate aggregates) → rotations preserve prefix-sum invariant → O(log n) positional queries are correct.

---

### Interaction 9: The CRLF rebuild path breaks both the Strategy Pattern and the Lazy/Eager boundary simultaneously

When `shouldRebuildLineIndexForDelete()` returns true, `applyEdit` skips the strategy entirely and calls `rebuildLineIndexFromPieceTableState()`:

```typescript
// reducer.ts:176-180
function rebuildLineIndexFromPieceTableState(state: DocumentState): DocumentState {
  const content = getText(state.pieceTable, byteOffset(0), byteOffset(state.pieceTable.totalLength));
  const rebuilt = rebuildLineIndex(content);
  return withState(state, { lineIndex: rebuilt });
}
```

`rebuildLineIndex` returns `LineIndexState<'eager'>` — all offsets computed, dirty ranges empty. So a normal edit path (which should produce lazy state) can produce eager state when CRLF rebuild triggers.

The type of `DocumentState` after `applyEdit` is therefore `DocumentState<'lazy' | 'eager'>` — not consistently lazy. The CRLF rebuild is a joint point where the Strategy Pattern, the Lazy/Eager mode boundary, and `rebuildPending` state must all agree.

`reconcileNow` absorbs this gracefully:
```typescript
if (!state.lineIndex.rebuildPending) {
  return state as DocumentState<'eager'>;
}
```
If rebuild already produced eager state, `rebuildPending` is false, and `reconcileNow` is a no-op. The mode-check absorbs the inconsistency without special-casing.

---

## Part 3: Dependency Graph Between Dimensions

```
Immutability
  ├── enables PStack structural sharing (O(1) snapshots)
  │     └── enables O(1) history coalescing (pop + push, not slice + copy)
  │           └── enables O(1) transaction snapshots
  ├── is the correctness requirement for WithNodeFn (no in-place mutation allowed)
  │     └── WithNodeFn forces aggregate recalculation on every rotation
  │           └── prefix-sum property holds after every structural change
  │                 └── O(log n) positional queries are correct
  └── enables reference-identity snapshot gating in reconcileIfCurrent

F-bounded RBNode<T>
  └── enables WithNodeFn<N> to return N (not RBNode<N>)
        └── rotations preserve concrete aggregate fields (subtreeLength, etc.)

Lazy/Eager type split
  ├── enforced by 3 mechanisms (types + strategy + runtime assertion)
  │     └── any gap between them is caught at the runtime assertion boundary
  ├── creates version-neutral vs version-bumping reconciliation asymmetry
  │     └── consumers must use reference comparison, not version comparison
  └── CRLF rebuild escapes lazy → produces eager directly
        └── rebuildPending:false absorbs the inconsistency downstream

Discriminated unions
  ├── EditOperation.kind → single upfront rebuild decision (no scattered guards)
  ├── DirtyLineRange sentinel → incremental strategy degrades to full rebuild
  └── _nodeKind discriminant → generic RB-tree code can distinguish node types at unions

PStack
  ├── requires immutability (shared cons cells must not change)
  ├── makes coalescing O(1) by design (pop + push, not slice + copy)
  └── _pstackBrand → construction is gated to pstackPush only (size invariant)

Cost algebra
  └── annotates the complexity consequences of the lazy/eager split at the API boundary
        (getLineRange requires eager O(log n); getLineRangePrecise tolerates lazy)
```

---

## Part 4: Performance Summary

| Operation | Complexity | Enabling dimensions |
|---|---|---|
| Insert text | O(log n) + O(m) encoding | Immutable RB-tree + WithNodeFn aggregate update |
| Delete text | O(log n) | Same |
| Find line at byte offset | O(log n) | Prefix-sum aggregates via WithNodeFn |
| Get line range | O(log n) | Eager mode only (type enforced) |
| Normal edit (lazy) | O(log n) + O(K) dirty range merge | Lazy strategy + DirtyLineRange discriminated union |
| CRLF edit | O(n) full rebuild | Escape from strategy via EditOperation.kind |
| History push | O(1) | PStack + immutable HistoryEntry |
| History coalesce | O(1) | PStack pop + push |
| History trim | O(limit) | pstackTrimToSize cons-list walk |
| Transaction snapshot | O(1) | PStack structural sharing + immutability |
| Background reconcile | O(n) or O(K+V) | DirtyLineRange sentinel vs. range variant |
| reconcileIfCurrent | O(1) gate + O(n) or O(K+V) | Reference identity + reconcileFull |
