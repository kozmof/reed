# Code Analysis: Reed Text Editor Library

**Date:** 2026-03-27

---

## 1. Code Organization and Structure

The project is organized into three cleanly separated layers:

```
src/
├── types/          # Pure type definitions — no logic, no deps on store/
├── store/
│   ├── core/       # Immutable data structures (piece-table, line-index, rb-tree)
│   └── features/   # High-level store, reducer, history, transactions, events
└── api/            # Public-facing namespace exports (thin wrappers)
```

**Dependency direction is strictly maintained:**
```
api/ → store/features/ → store/core/ → types/
```

No reverse dependencies exist. `types/` has zero imports from `store/` or `api/`, which allows types to be shared without circular references.

**Layer responsibilities are well-defined:**
- `types/` — shapes only (interfaces, discriminated unions, branded types, cost algebra)
- `store/core/` — algorithms (tree ops, line math, encoding)
- `store/features/` — orchestration (reduce, dispatch, schedule, notify)
- `api/` — façade (re-exports with stable names for consumers)

**Gap:** `src/store/core/state.ts` plays a dual role — node factory functions (`createLineIndexNode`, `withLineIndexState`) and application state bootstrapping (`createInitialState`). These could be split into `node-factories.ts` and `initial-state.ts`.

---

## 2. Relations of Implementations (Types and Interfaces)

### Branded Primitives (`types/branded.ts`)
```
number → ByteOffset | ByteLength | CharOffset | LineNumber | ColumnNumber
```
Phantom types enforced at compile time; zero runtime cost. Used pervasively in `line-index.ts` and `piece-table.ts` to prevent accidental offset-mixing bugs.

### Node Types (`types/state.ts`)
Both tree node types share a common `RBNode<T>` base via F-bounded polymorphism:
```
RBNode<T extends RBNode<T>>
  ├── PieceNode         (_nodeKind: 'piece')
  └── LineIndexNode<M>  (_nodeKind: 'lineIndex', parameterized by EvaluationMode)
```
The `_nodeKind` discriminant allows generic RB-tree code (`rb-tree.ts`) to operate on both without losing type identity.

### Mode Parameterization (`LineIndexNode<M>`, `LineIndexState<M>`)
```
EvaluationMode = 'eager' | 'lazy'

LineIndexNode<'eager'>  → documentOffset: number        (always resolved)
LineIndexNode<'lazy'>   → documentOffset: number | null (may be pending)

LineIndexState<'eager'> → dirtyRanges: readonly [], rebuildPending: false
LineIndexState<'lazy'>  → dirtyRanges: readonly DirtyLineRange[], rebuildPending: boolean
```
The conditional type narrowing at the interface level propagates mode constraints through the type system. `asEagerLineIndex()` acts as the mode-coercion boundary.

### Dirty Ranges (`DirtyLineRange`)
Uses a proper discriminated union instead of an ad-hoc sentinel value:
```
DirtyLineRange = DirtyLineRangeEntry   { kind: 'range', startLine, endLine, offsetDelta }
               | DirtyLineRangeSentinel { kind: 'sentinel' }
```
This prevents accidental shape-matching that caused the previous P2 bug.

### `PStack<T>` — Persistent Stack
```
PStack<T> = null | { top: T, rest: PStack<T>, size: number, [_pstackBrand]: true }
```
The brand is a non-exported `unique symbol`, preventing external construction. The only constructors are the exported helpers (`pstackPush`, etc.).

### Cost Algebra (`types/cost-doc.ts`)
```
Cost = { p: Nat, l: Nat }  (O(n^p * log^l n))
Costed<Level, T> = T & { [costLevel]: LevelsUpTo<Level> }
```
The `LevelsUpTo<L>` type enables natural widening: a `ConstCost<T>` is assignable where a `LogCost<T>` is expected — O(1) is-a O(log n).

**Notable tension:** `Ctx<C, T>` has a phantom `_cost: C` field in the type, but at runtime objects are created with only `{ value }`. The cast `({ value } as Ctx<...>)` pattern is repeated throughout `$lift`, `$andThen`, `$map`, etc. This is technically sound since `_cost` is never accessed at runtime, but is a structural lie in the type.

---

## 3. Relations of Implementations (Functions)

### Piece Table Edit → Line Index Update → History Push chain

```
documentReducer(state, action)
  ├── validatePosition / validateRange
  ├── pieceTableInsert / pieceTableDelete  [store/core/piece-table.ts]
  │     └── ptInsert / ptDelete
  ├── lineIndexUpdate (via strategy)
  │     ├── eagerStrategy → liInsert / liDelete  [line-index.ts]
  │     └── lazyStrategy  → liInsertLazy / liDeleteLazy
  ├── shouldRebuildLineIndex? → rebuildLineIndexFromPieceTableState
  └── historyPush / historyUndo / historyRedo
```

The `LineIndexStrategy` interface (`reducer.ts:121`) abstracts the eager/lazy choice away from `applyEdit`, preventing scattered `if (eager) ... else ...` branches.

### Reconciliation chain

```
store.dispatch(action)
  └── if rebuildPending → scheduleReconciliation()
        ├── requestIdleCallback → reconcileIfCurrent()
        │     └── reconcileFull / reconcileViewport / reconcileRange [line-index.ts]
        └── setTimeout(200ms) fallback
```

`reconcileIfCurrent()` is a snapshot-gated guard — if the state version has changed since the reconciliation was scheduled, it aborts. This prevents stale reconciliation from overwriting newer state.

### RB-Tree balancing

```
rb-tree.ts
  ├── fixInsertWithPath(path)    → O(log n) preferred path
  └── rebalanceAfterInsert(node) → O(n) recursive (used in simpler contexts)

line-index.ts / piece-table.ts
  └── lineIndexInsert → ... → fixInsertWithPath  (preferred)
```

`rb-tree.ts` exports a `WithNodeFn<T>` type to make the node-factory callback generic. `line-index.ts` binds this with `const withLine: WithNodeFn<LineIndexNode> = withLineIndexNode` — a clean adapter pattern.

### `mergeDirtyRanges`

The while-loop decomposition handles overlapping ranges with different deltas by producing non-overlapping sub-ranges. The correctness invariant (sorted, non-overlapping output) must be maintained carefully — it is the most algorithmically subtle function in the codebase.

---

## 4. Specific Contexts and Usages

### CRLF boundary handling

Three separate code paths handle CRLF edge cases:

1. **Insert boundary**: `getInsertBoundaryContext` + `hasCrossBoundaryCRLFMerge` → if true, `rebuildLineIndexFromPieceTableState`
2. **Delete boundary**: `getDeleteBoundaryContext` + `shouldRebuildLineIndexForDelete` → same fallback
3. **`countDeletedLineBreaks`**: uses before/after string trick to handle partial CRLF deletes accurately

The three conditions in `shouldRebuildLineIndexForDelete` cover:
- Deleted text contains `\r`
- Deleted text contains `\n` and prev char is `\r` (splitting CRLF from right)
- Delete range is between `\r` and `\n` (collapsing two breaks into CRLF)

### Undo/redo eager reconciliation

```
historyUndo(state):
  1. reconcileFull(state.lineIndex, ...) → eager LineIndexState
  2. Apply each change in reverse using eagerStrategy
  3. Return state with eager line index
```

Forced eager reconciliation before undo changes is necessary because precise byte offsets are required for undo. This costs O(n) per undo/redo operation.

### Transaction snapshot isolation

```
TransactionManager
  snapshotStack: DocumentState[]
  depth: number

begin()    → push(currentState), depth++
commit()   → pop, depth--, return isOutermost
rollback() → restore snapshot, depth--
```

Invariant: `snapshotStack.length === depth` always. `emergencyReset()` returns the earliest snapshot when rollback itself fails (double-fault protection).

### Store re-entrancy guard

```ts
let notifying = false;
function notifyListeners() {
  if (notifying) return;
  notifying = true;
  try { listeners.forEach(fn => fn(state)); }
  finally { notifying = false; }
}
```

Prevents listener-triggered dispatches from causing recursive notification loops. Re-entrant notifications are silently dropped rather than queued — safe but means a listener-triggered dispatch won't immediately notify.

---

## 5. Pitfalls

### P1 — `$lift` / `$proveCtx` verbosity in traversals

Functions like `findLineAtPosition` and `findLineByNumber` wrap every return with:
```ts
return $proveCtx('O(log n)', $lift('O(log n)', { ... }));
```
This is purely cosmetic plumbing with no runtime effect. It is easy to annotate an O(n) function as `O(log n)` since there is no enforcement — the noise ratio is high relative to signal.

### P2 — `rebuildFromReadText` uses `Number.MAX_SAFE_INTEGER` as end offset ✅ Fixed

```ts
// Before
const content = readText(byteOffset(0), byteOffset(Number.MAX_SAFE_INTEGER));
// After
const content = readText(byteOffset(0), byteOffset(END_OF_DOCUMENT));
```
Replaced the raw `Number.MAX_SAFE_INTEGER` literal with the named `END_OF_DOCUMENT` constant already defined in `types/state.ts`. Makes intent explicit and consistent with every other "to end of document" usage in the codebase.

### P3 — `getInsertBoundaryContext` reads one byte before position ✅ Fixed

```ts
const prevChar = pos > 0
  ? readText(byteOffset(pos - 1), position)
  : '';
```
Assumes `pos - 1` is a valid character boundary. For multi-byte UTF-8 sequences this is theoretically incorrect, though practically safe since only `\r` (0x0D, single byte) is checked. Added a comment at the call site (`line-index.ts`) documenting the invariant explicitly so future readers do not need to rediscover it.

### P4 — `validateRange` returns unclamped values on invalid range ✅ Fixed

```ts
// Before
if (start > end) {
  return { start: byteOffset(start), end: byteOffset(end), valid: false };
}
// After
if (start > end) {
  return {
    start: validatePosition(start, totalLength),
    end: validatePosition(end, totalLength),
    valid: false,
  };
}
```
Both `start` and `end` are now clamped through `validatePosition` even when the range is invalid, so callers that accidentally use the values without checking `valid` still receive in-bounds offsets.

### P5 — `coalesceChanges` default arm is unreachable dead code ✅ Fixed

```ts
// Before
default:
  return incoming;  // 'replace' changes are not coalesced
// After
default:
  throw new Error(`coalesceChanges called with uncoalesceable change type: ${(incoming as HistoryChange).type}`);
```
Changed to a `throw`. The invariant (`canCoalesce` never passes a `replace` change here) is now enforced at runtime rather than silently returning a potentially wrong result if it is ever violated.

### P6 — `Ctx<C, T>` phantom `_cost` field is a structural lie ✅ Fixed

Added a `@remarks` block to the `Ctx<C, T>` type in `types/cost-doc.ts` explicitly documenting that `_cost` is phantom — never initialized or read at runtime — and why that is intentional and safe. The type declaration is unchanged.

---

## 6. Improvement Points: Design Overview

### I1 — Eager reconciliation before every undo/redo is O(n)

Each undo/redo call invokes `reconcileFull` before applying changes. For large files, this is a performance cliff for rapid undo sequences.

**Alternative:** Apply undo changes using an incremental approach — resolve only the specific byte offsets needed (O(k) where k = changed lines) rather than resolving all offsets eagerly.

### I2 — Background reconciliation has no back-pressure

`scheduleReconciliation` relies on `reconcileIfCurrent` to detect staleness, but if edits arrive faster than reconciliation runs, the dirty range array grows until the sentinel kicks in at 32 entries. There is no explicit throttling or priority mechanism.

**Alternative:** Expose a `reconcilePriority` signal, or allow the sentinel threshold to be configurable.

### I3 — `reducer.ts` and `store.ts` are large monoliths

`reducer.ts` (828 lines) handles position validation, piece-table ops, line-index strategy dispatch, CRLF edge case detection, history coalescing, undo, redo, transaction reduction, selection computation, and remote change application — mostly independent concerns.

**Alternative:** Extract `applyEdit`, `historyPush`, `applyHistoryUndo`, and `applyHistoryRedo` as pure functions into separate files, keeping `reducer.ts` as an orchestrator only.

### I4 — `DocumentStoreConfig.lineEnding` is not enforced on insert

The `lineEnding` metadata records the document's intended line ending, but `lineIndexInsert` handles all three variants uniformly. There is no normalization layer that enforces the configured line ending on incoming text.

---

## 7. Improvement Points: Types and Interfaces

### T1 — `LineIndexState<M>` conditional types do not propagate in practice ✅ Fixed

```ts
readonly dirtyRanges: M extends 'eager' ? readonly [] : readonly DirtyLineRange[];
```
Most functions accept the union default `LineIndexState` (no `M` parameter), losing the eager constraint. Added named aliases to `types/state.ts` and exported them from `types/index.ts`:

```ts
export type EagerLineIndexState = LineIndexState<'eager'>;
export type LazyLineIndexState  = LineIndexState<'lazy'>;
```

Call sites can now use these names to make mode transitions visible and get precise narrowing without writing out the conditional type inline.

### T2 — `HistoryChange.byteLength` invariant is unprotected

```ts
interface HistoryInsertChange {
  text: string;
  byteLength: ByteLength;  // must equal textEncoder.encode(text).length
}
```
`text` fully determines `byteLength`. If they diverge, undo/redo offsets are silently wrong.

**Alternative:** Compute `byteLength` lazily on demand, or validate on construction via a factory function.

### T3 — `ReadTextFn` and `DeleteBoundaryContext` are operational parameters, not state shapes ✅ Fixed

Moved both types out of `types/state.ts` into a new `types/operations.ts`:

```
src/types/operations.ts   ← ReadTextFn, DeleteBoundaryContext (new file)
```

`types/state.ts` re-exports them for backwards compatibility. `store/core/line-index.ts` and `store/features/reducer.ts` import directly from `types/operations.ts`. `types/index.ts` re-exports from the new file.

### T4 — `NonEmptyReadonlyArray<T>` is a general utility defined in one specific location ✅ Fixed

Moved to a new `types/utils.ts`:

```
src/types/utils.ts   ← NonEmptyReadonlyArray<T> (new file)
```

`types/state.ts` re-exports it for backwards compatibility. `types/index.ts` re-exports from the new file.

---

## 8. Improvement Points: Implementations

### Impl1 — `findNewlineBytePositions` allocates `Uint8Array` per call (hot path)

```ts
const bytes = textEncoder.encode(text);  // allocation on every insert
```
Since `\r` (0x0D) and `\n` (0x0A) are single-byte ASCII and never appear in UTF-8 continuation bytes, positions can be found via direct string scan, avoiding the allocation:
```ts
for (let i = 0; i < text.length; i++) {
  const c = text.charCodeAt(i);
  if (c === 0x0D || c === 0x0A) { ... }
}
```
Note: computing `byteLength` still requires a UTF-8 encode, but it can be separated from the newline scan.

### Impl2 — `pstackToArray` does two passes (push + reverse) ✅ Fixed

```ts
// Before: two passes
arr.push(cur.top);  // fill newest-first
arr.reverse();      // then flip

// After: single pass
const arr = new Array<T>(s?.size ?? 0);
let i = arr.length - 1;
while (cur !== null) { arr[i--] = cur.top; cur = cur.rest; }
```
Pre-allocates using the `size` field already stored on each `PStackCons` node and fills from the end in one pass, eliminating the O(n) reversal.

### Impl3 — `withTransactionBatch` success-flag ordering is subtle

```ts
success = true;
txDispatch({ type: 'TRANSACTION_COMMIT' });  // success set before the operation it guards
```
If COMMIT throws, the finally block correctly skips ROLLBACK — but the intent is non-obvious. A separate `committed` flag set inside a `try/catch` around the commit would make the intent explicit.

### Impl4 — `reconcileViewport`, `reconcileRange`, and `mergeDirtyRanges` are embedded in a 2251-line file

These are the most complex functions in the codebase. Extracting them into `store/core/reconcile.ts` would improve navigability and allow independent testing.

---

## 9. Learning Paths

### Path 1: Understanding the data model
**Goal:** Understand how text is stored and how positions are tracked.

1. `src/types/branded.ts` — Branded position types (`ByteOffset` vs `CharOffset`).
2. `src/types/state.ts` — `PieceTableState`, `LineIndexState<M>`, `DirtyLineRange`, `PStack<T>`.
3. `src/store/core/piece-table.ts` — How text is stored as a tree of buffer references. Focus on `pieceTableInsert` and `pieceTableDelete`.
4. `src/store/core/rb-tree.ts` — Generic RB-tree balancing used by both piece table and line index.

### Path 2: Understanding line lookup
**Goal:** Understand how `getLineRange(state, lineNumber)` achieves O(log n).

1. `src/types/state.ts` lines 112–128 — `LineIndexNode<M>` fields: `subtreeLineCount`, `subtreeByteLength`, `subtreeCharLength`.
2. `src/store/core/line-index.ts` lines 216–335 — `findLineByNumber`, `getLineStartOffset`. Core O(log n) traversals using subtree aggregates.
3. `src/api/query.ts` — `getLineRange`, `getLineRangePrecise`. The eager vs lazy distinction in the public API.

### Path 3: Understanding lazy/eager reconciliation
**Goal:** Understand why line offsets can be `null` and how they get resolved.

1. `src/types/state.ts` lines 130–175 — `DirtyLineRange`, `DirtyLineRangeSentinel`, `END_OF_DOCUMENT`.
2. `src/store/core/line-index.ts` — `lineIndexInsertLazy`, `lineIndexDeleteLazy`, `mergeDirtyRanges`, `reconcileFull`, `reconcileRange`.
3. `src/store/features/store.ts` — `scheduleReconciliation`, `reconcileIfCurrent`, `setViewport`.
4. `src/store/core/state.ts` — `asEagerLineIndex` (the mode-coercion boundary).

### Path 4: Understanding the edit pipeline
**Goal:** Trace a single `INSERT` action from dispatch to committed state.

1. `src/store/features/store.ts` — `dispatch()`. How actions flow through transaction management.
2. `src/store/features/reducer.ts` — `documentReducer` → `applyEdit` → `pieceTableInsert` + `lineIndexStrategy`.
3. `src/types/actions.ts` — Action type definitions.
4. `src/store/features/actions.ts` — Action constructors (`DocumentActions.insert`).

### Path 5: Understanding undo/redo
**Goal:** Understand how undo restores previous state without storing full snapshots.

1. `src/types/state.ts` lines 260–401 — `HistoryChange`, `HistoryEntry`, `HistoryState`, `PStack<T>`.
2. `src/store/features/reducer.ts` — `historyPush`, `canCoalesce`, `coalesceChanges`, `historyUndo`, `historyRedo`.
3. `src/store/features/history.ts` — `canUndo`, `canRedo`, `getUndoCount`.

### Path 6: Understanding the cost algebra
**Goal:** Understand what `$prove`, `$lift`, `$andThen` mean and why they exist.

1. `src/types/cost-doc.ts` — Full read. Start from `Cost`, `CostLabel`, `Costed<L,T>`, then the combinators.
2. `src/store/core/line-index.ts` lines 216–260 — `$proveCtx` and `$lift` in `findLineAtPosition`. Typical usage pattern.
3. Key insight: these are **documentation annotations, not runtime contracts**. The combinators check internal consistency of claimed costs at the type level but cannot detect false claims.

---

## Summary

| Category | Finding |
|---|---|
| **Strengths** | Immutable persistent structures; `PStack<T>` with brand-protected construction; `DirtyLineRange` discriminated union; `LineIndexStrategy` abstraction; cost algebra as living documentation |
| **Top design concern** | Undo/redo forces O(n) reconciliation per operation (I1, open) |
| **Top type concern** | `HistoryChange.byteLength` invariant unprotected at construction (T2, open) |
| **Top impl concern** | `Uint8Array` allocation in `findNewlineBytePositions` on every insert (Impl1, open) |
| **Largest file** | `src/store/core/line-index.ts` (2251 lines) — candidate for extraction (Impl4, open) |
| **Most complex function** | `mergeDirtyRanges` — correct but requires careful invariant maintenance |

### Fixed (2026-04-07)

| ID | Summary |
|---|---|
| P2 | `rebuildFromReadText`: use `END_OF_DOCUMENT` constant instead of raw `Number.MAX_SAFE_INTEGER` |
| P3 | `getInsertBoundaryContext`: document why `pos - 1` byte read is safe for ASCII-only check |
| P4 | `validateRange`: clamp start/end through `validatePosition` even when returning `valid: false` |
| P5 | `coalesceChanges`: replace silent dead `default: return incoming` with a `throw` |
| P6 | `Ctx<C, T>`: add `@remarks` documenting `_cost` as intentional phantom field |
| T1 | Add `EagerLineIndexState` and `LazyLineIndexState` named aliases; export from `types/index.ts` |
| T3 | Move `ReadTextFn` and `DeleteBoundaryContext` to new `types/operations.ts` |
| T4 | Move `NonEmptyReadonlyArray<T>` to new `types/utils.ts` |
| Impl2 | `pstackToArray`: pre-allocate and fill in one pass, eliminating the `arr.reverse()` |
