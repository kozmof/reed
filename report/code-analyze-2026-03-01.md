# Code Analysis: Reconciliation Implementations

**Date:** 2026-03-01
**Scope:** Lazy/eager line index reconciliation system

---

## 1. Code Organization and Structure

The reconciliation system is spread across five layers with clear separation of concerns:

| Layer | Files | Responsibility |
|---|---|---|
| **Type** | `src/types/state.ts`, `src/types/store.ts` | Phantom-type contracts (`EvaluationMode`, `LineIndexState<M>`, `DirtyLineRange`, `LineIndexStrategy<M>`, `ReconcilableDocumentStore`) |
| **Core** | `src/store/core/line-index.ts` | All lazy/eager ops, dirty range management, `reconcileFull`, `reconcileRange`, `reconcileViewport`, `reconcileInPlace` |
| **State factory** | `src/store/core/state.ts` | `asEagerLineIndex` runtime narrowing, `withLineIndexState` structural sharing helper |
| **Reducer** | `src/store/features/reducer.ts` | `eagerLineIndex`/`lazyLineIndex` strategy objects, `applyEdit`, undo/redo pre-reconciliation via `reconcileFull` |
| **Store** | `src/store/features/store.ts` | `scheduleReconciliation` (idle/timeout), `reconcileNow`, `setViewport` |
| **Query API** | `src/api/query.ts` | `isReconciledState`, `getLineRange` (eager-only), `getLineRangePrecise` (no-reconcile) |

---

## 2. Relations of Implementations — Types & Interfaces

```
EvaluationMode = 'eager' | 'lazy'

LineIndexState<M> {
  root: LineIndexNode<M> | null
  lineCount: number
  dirtyRanges:      M extends 'eager' ? readonly []   : readonly DirtyLineRange[]
  rebuildPending:   M extends 'eager' ? false         : boolean
  lastReconciledVersion: number
}

DirtyLineRange { startLine, endLine, offsetDelta, createdAtVersion }

DocumentState<M> { lineIndex: LineIndexState<M>, ... }
```

The conditional types on `dirtyRanges` and `rebuildPending` enforce **at compile time** that `'eager'` state has no dirty ranges — the key invariant. `LineIndexStrategy<M>` mirrors this, so `eagerLineIndex` and `lazyLineIndex` operate on their respective modes and cannot be mixed.

`ReconcilableDocumentStore` extends `DocumentStore` with three surface methods:
- `scheduleReconciliation(): void`
- `reconcileNow(snapshot?): DocumentState<'eager'> | null`
- `setViewport(startLine, endLine): void`

---

## 3. Relations of Implementations — Functions

**Normal edit (lazy) path:**
```
dispatch INSERT/DELETE/REPLACE
  → documentReducer → applyEdit
    → lazyLineIndex.insert / .delete
      → lineIndexInsertLazy / lineIndexDeleteLazy
        → insertLinesAtPositionLazy / deleteLineRangeLazy
          → createDirtyRange → mergeDirtyRanges
    → rebuildPending = true
  → scheduleReconciliation()
    → requestIdleCallback/setTimeout → reconcileFull
        if totalDirty ≤ threshold → reconcileRange (per range)
                                       → updateLineOffsetByNumber (per line)
        else                       → reconcileInPlace (O(n) tree walk)
```

**Viewport-priority path:**
```
setViewport(start, end)
  → reconcileViewport → reconcileRange (viewport window only)
  → scheduleReconciliation()  (defers off-screen dirty ranges)
```

**Undo/Redo (eager) path:**
```
UNDO / REDO
  → applyChange / applyInverseChange
    → reconcileFull (lazy→eager pre-condition)
    → eagerLineIndex.insert / .delete
      → lineIndexInsert / lineIndexDelete  (offsets computed immediately)
```

**CRLF full-rebuild fallback:**
```
shouldRebuildLineIndexForDelete → true
  → rebuildLineIndexFromPieceTableState
    → getText (full document scan) → rebuildLineIndex (O(n))
```

---

## 4. Specific Contexts and Usages

**Normal editing** uses `lazyLineIndex` via `applyEdit`. Tree structure (line count, lengths) is updated immediately; `documentOffset` values for lines after the edit point are set to `null`. A `DirtyLineRange` is pushed and `rebuildPending` is set true. Listeners are notified before reconciliation.

**Undo/Redo** calls `reconcileFull` first to guarantee an `'eager'` state before replaying history changes. This is necessary because undo requires correct offsets to place the inverse edit.

**Viewport rendering** via `setViewport` prioritizes the visible window, reconciling only those lines immediately (O(k log n) where k = viewport size), then schedules background work for the rest.

**Remote collaboration** (`APPLY_REMOTE`) uses `lazyLineIndex` and does not push to history, but follows the same dirty-range tracking as local edits.

**Background idle reconciliation** uses `requestIdleCallback` with a 1-second timeout, or `setTimeout(16ms)` fallback. It deliberately does **not** notify listeners — reconciliation is an invisible internal optimization.

---

## 5. Pitfalls

**P1 — `mergeDirtyRanges` merges overlapping ranges with unequal deltas incorrectly when `startLine` values differ.**

When two ranges overlap (`next.startLine > current.startLine`) with different `offsetDelta`, the code pushes `current` and sets `current = next`. The overlap region from `next.startLine` to `current.endLine` then has only `next.offsetDelta` applied instead of the combined delta. Lines in that overlap will be under-corrected during reconciliation.
(`src/store/core/line-index.ts:1378–1385`)

**P2 — The collapsed-cap sentinel `{startLine:0, endLine:MAX_SAFE_INT, delta:0}` is indistinguishable from a legitimate full-document zero-delta range.**

`reconcileFull` detects it by shape (`line-index.ts:1943–1947`). A net-zero edit sequence (insert then delete same range) could naturally produce the same shape, causing the slow path (`reconcileInPlace`) to always be selected even when incremental would be correct.

**P3 — `DirtyLineRange.createdAtVersion` is tracked but never read in any reconciliation logic.**

The field is created, merged (taking `max`), and stored in state, but no code path uses it to skip or prioritize ranges. It is effectively dead data in the current implementation.
(`src/store/core/line-index.ts:1443–1455`)

**P4 — `asEagerLineIndex` narrows via a structural check, not an offset correctness check.**

If `reconcileInPlace` had a bug in offset accumulation, `toEagerLineIndexState` would still pass the check and return a `LineIndexState<'eager'>` with incorrect `documentOffset` values — corrupting all downstream line lookups silently.
(`src/store/core/state.ts:328–333`)

**P5 — `deleteLineRangeLazy` still calls `rebuildWithDeletedRange` (an O(n) tree rebuild) even in lazy mode.**

For multi-line deletions, the structural tree rebuild cannot be deferred because the resulting tree shape changes. This means lazy delete with newlines has the same O(n) cost as eager delete, negating the lazy optimization for this case.
(`src/store/core/line-index.ts:1682`)

**P6 — `scheduleReconciliation`'s `setTimeout(16ms)` fallback runs at near-frame-rate frequency in non-browser environments.**

In Node.js (no `requestIdleCallback`), every edit with newlines schedules a 16ms timeout. For high-throughput batch edits, this creates a continuous storm of 16ms-interval reconciliations regardless of system load.
(`src/store/features/store.ts:270`)

---

## 6. Improvement Points — Design Overview

**D1: The eager/lazy duality at the `LineIndexStrategy` level is over-engineered for two concrete implementations.**

`eagerLineIndex` and `lazyLineIndex` are the only two instances and they are not user-extensible. The interface adds indirection without extensibility value. The two implementation paths could be plain conditional branches in the reducer.

**D2: Viewport reconciliation does not track that the viewport window has already been reconciled.**

After `setViewport(0, 50)`, the dirty ranges for lines 0–50 are removed. But `lineIndex.rebuildPending` remains `true` (off-screen dirty ranges still exist), and `scheduleReconciliation` is called again. There is no mechanism to skip re-reconciling the viewport on the next background pass.

**D3: The reconciliation threshold function `defaultThresholdFn` is not adaptive to document structure.**

It scales by `lineCount / log2(lineCount)` — roughly O(n/log n) dirty lines trigger the slow path. The threshold does not account for whether the dirty ranges are contiguous (cheap to reconcile incrementally) or scattered (expensive).

---

## 7. Improvement Points — Types & Interfaces

**T1: `LineIndexNode<M>` propagates the phantom type through the entire tree, making node-level functions verbose.**

All tree operations must carry `<M extends EvaluationMode>`. Since `M` only affects `documentOffset` nullability, keeping nodes unparameterized and parameterizing only `LineIndexState<M>` would simplify type signatures significantly.

**T2: `DirtyLineRange.createdAtVersion` should either be used or removed.**

If intended for future use (e.g., per-range reconciliation priority), this should be documented with the intended semantic. If unused, it should be removed to avoid confusion.

**T3: `getLineRange` and `getLineRangeChecked` expose the same semantic but with different type contracts.**

`getLineRange` requires `LineIndexState<'eager'>` at compile time; `getLineRangeChecked` accepts any state and calls `asEagerLineIndex` at runtime. There is no third option for "reconcile on demand if needed," which creates API confusion for consumers.

---

## 8. Improvement Points — Implementations

**Impl1: `reconcileRange` applies `getOffsetDeltaForLine` (O(k)) per line in a loop of `(endLine - startLine)` lines.**

For a viewport of V lines with K dirty ranges, this is O(V × K). A single pass over dirty ranges to build a prefix-sum array, then O(1) delta lookup per line, would reduce this to O(K + V).

**Impl2: `mergeDirtyRanges` sorts on every call (O(k log k)), even when ranges are appended in order.**

Since `createDirtyRange` always uses `Number.MAX_SAFE_INTEGER` as `endLine` and ranges are appended sequentially, ranges are nearly always already sorted by `startLine`. An insertion-order assumption with a fallback sort would be faster in practice.

**Impl3: `reconcileInPlace` visits all nodes even when they already have correct offsets.**

The short-circuit `node.documentOffset !== correctOffset` avoids node allocation but not subtree traversal. A subtree-level correctness flag (analogous to `rebuildPending` at the state level) would allow pruning entire subtrees known to be clean.

**Impl4: `reconcileNow` and the background `scheduleReconciliation` callback both increment `state.version + 1`.**

Both produce a version bump for what is semantically the same state mutation (reconciling dirty ranges). Callers comparing versions would see unexpected increments. Reconciliation could be treated as version-neutral since it does not change visible content.

---

## 9. Learning Paths

**Path 1 — Phantom type invariants (data model)**
1. `src/types/state.ts` — `EvaluationMode`, `LineIndexState<M>`, `DirtyLineRange`, `LineIndexNode<M>`
2. `src/store/core/state.ts` — `asEagerLineIndex`, `withLineIndexState`, `createEmptyLineIndexState`
3. **Goal:** understand how conditional types on `dirtyRanges` and `rebuildPending` enforce the eager/lazy invariant at compile time

**Path 2 — Lazy mutation tracking**
1. `src/store/features/reducer.ts:116–136` — `lazyLineIndex` strategy, `applyEdit`
2. `src/store/core/line-index.ts:1466–1699` — `lineIndexInsertLazy`, `insertLinesAtPositionLazy`, `deleteLineRangeLazy`
3. `src/store/core/line-index.ts:1349–1410` — `mergeDirtyRanges`, `createDirtyRange`
4. **Goal:** trace a single `INSERT` action through to dirty range creation

**Path 3 — Reconciliation strategies (core)**
1. `src/store/core/line-index.ts:1761–1975` — `reconcileRange`, `reconcileFull`, `reconcileInPlace`, `reconcileViewport`
2. `src/store/features/store.ts:224–325` — `scheduleReconciliation`, `reconcileNow`, `setViewport`
3. **Goal:** understand the incremental vs. full-walk decision (threshold function) and when each is chosen

**Path 4 — Undo/Redo and the eager boundary**
1. `src/store/features/reducer.ts:351–500` — `historyUndo`, `historyRedo`, `applyChange`, `applyInverseChange`
2. `src/store/features/reducer.ts:452–458` — pre-reconciliation call in `applyChange`
3. **Goal:** understand why undo/redo must force eager state before applying inverse changes

**Path 5 — Consumer API and reconciliation surface**
1. `src/types/store.ts:82–112` — `ReconcilableDocumentStore`
2. `src/api/query.ts:28–58` — `isReconciledState`, `getLineRange`, `getLineRangeChecked`, `getLineRangePrecise`
3. **Goal:** understand what guarantees the public API provides and how to correctly select between `getLineRange` (requires eager) vs. `getLineRangePrecise` (works on any mode)
