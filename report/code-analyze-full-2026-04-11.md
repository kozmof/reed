# Reed — Full Codebase Analysis

**Date:** 2026-04-11

---

## 1. Code Organization and Structure

```
src/
├── index.ts                  ← Public entry: namespace re-exports + flat type exports
├── api/                      ← Namespaced public API
│   ├── interfaces.ts         ← TypeScript contracts (satisfies targets for each namespace)
│   ├── query.ts, scan.ts     ← O(log n)/O(n) read namespaces
│   ├── events.ts, rendering.ts, history.ts, diff.ts, position.ts, cost-doc.ts
│   └── store.ts, index.ts
├── store/
│   ├── core/                 ← Data structures (no framework coupling)
│   │   ├── rb-tree.ts        ← Generic immutable RB-tree (rotations, balancing)
│   │   ├── piece-table.ts    ← Piece table CRUD on the generic RB-tree
│   │   ├── line-index.ts     ← Line offset tree (lazy/eager modes)
│   │   ├── state.ts          ← Factory functions for all state shapes
│   │   ├── growable-buffer.ts← Append-only add-buffer
│   │   └── encoding.ts       ← Shared TextEncoder/TextDecoder singletons
│   └── features/             ← High-level features
│       ├── store.ts          ← createDocumentStore / createDocumentStoreWithEvents
│       ├── reducer.ts        ← Pure state reducer
│       ├── transaction.ts    ← Standalone nesting-aware transaction manager
│       ├── events.ts         ← Event emitter + event factories
│       ├── diff.ts           ← Myers diff + setValue helpers
│       ├── history.ts        ← canUndo/canRedo helpers
│       ├── rendering.ts      ← Viewport/line rendering utilities
│       └── actions.ts        ← DocumentActions factory
└── types/
    ├── state.ts              ← Core immutable state types, PStack
    ├── actions.ts            ← Action union + isDocumentAction + validateAction
    ├── store.ts              ← Store interface hierarchy
    ├── branded.ts            ← Phantom-type branded positions (ByteOffset, etc.)
    ├── cost-doc.ts           ← Cost algebra: types + combinators
    ├── str-enum.ts           ← strEnum utility
    └── utils.ts, operations.ts
```

Layering discipline is strong. `store/core/` has zero framework dependencies. `store/features/` depends on core but not on the public API layer. `api/` depends on features, never the reverse.

---

## 2. Relations — Types and Interfaces

```
DocumentState<M: EvaluationMode>
  ├── pieceTable: PieceTableState
  │     ├── root: PieceNode | null         ← RBNode<PieceNode> (F-bounded)
  │     ├── addBuffer: GrowableBuffer      ← append-only, shared backing array
  │     └── chunkMap: ReadonlyMap<...>
  ├── lineIndex: LineIndexState<M>
  │     ├── root: LineIndexNode<M> | null  ← RBNode<LineIndexNode<M>> (F-bounded)
  │     ├── dirtyRanges: M='eager' → []   (conditional on M)
  │     └── rebuildPending: M='eager' → false
  ├── selection: SelectionState
  │     └── ranges: NonEmptyReadonlyArray<SelectionRange>  ← byte offsets
  └── history: HistoryState
        ├── undoStack: PStack<HistoryEntry>   ← persistent linked list
        └── redoStack: PStack<HistoryEntry>

PieceNode = OriginalPieceNode | AddPieceNode | ChunkPieceNode  (discriminated on bufferType)
  All share PieceNodeBase extends RBNode<PieceNode>

LineIndexNode<M> extends RBNode<LineIndexNode<M>>
  documentOffset: M='eager' → number, M='lazy' → number | null

RBNode<T extends RBNode<T>>  ← F-bounded generic; shared by both tree types

DirtyLineRange = DirtyLineRangeEntry | DirtyLineRangeSentinel  (discriminated on kind)

Store hierarchy:
  DocumentStore
    └── ReconcilableDocumentStore  (adds reconcileNow, setViewport, emergencyReset)
          └── DocumentStoreWithEvents  (adds addEventListener, events emitter)
```

F-bounded polymorphism on `RBNode<T>` allows `rb-tree.ts` to export `rotateLeft`, `rotateRight`, and `fixInsertWithPath` as fully generic functions, reused by both piece table and line index without code duplication.

The `EvaluationMode` generic on `DocumentState`/`LineIndexState`/`LineIndexNode` propagates the lazy/eager distinction to type-safe call sites — `getLineRange` accepts only `DocumentState<'eager'>`, forcing callers to reconcile first.

---

## 3. Relations — Functions

```
createDocumentStoreWithEvents(config)
  └── createDocumentStore(config)           ← base store (owns transaction stack)
        ├── createInitialState(config)
        ├── documentReducer(state, action)  ← pure, no side effects
        │     ├── ptInsert / ptDelete       ← piece-table.ts
        │     └── liInsert/liDelete (eager) or liInsertLazy/liDeleteLazy (lazy)
        ├── createTransactionManager()      ← snapshot-stack + nesting depth
        └── reconcileFull / reconcileViewport ← line-index.ts

createDocumentStoreWithEvents wraps base store dispatch/batch,
intercepting each action to call emitter.emit(event).

withTransactionBatch(txDispatch, actionDispatch, emergencyReset, actions)
  └── shared by both batch() implementations (base + event-enhanced)

setValue(state, newContent)
  └── computeSetValueActionsOptimized(old, new)  ← single REPLACE, O(n)
        └── finds differing region, emits one INSERT/DELETE/REPLACE action

setValueWithDiff(state, newContent)
  └── computeSetValueActions(old, new)       ← Myers diff O(n²)
        └── diff(old, new)
              ├── myersDiff()                ← full Myers for large strings
              └── simpleDiff()              ← LCS DP for small strings (n*m < 10000)

fixInsertWithPath(path, withNode)            ← O(log n), preferred
fixInsert(root, withNode)                    ← O(n), full-tree traversal, legacy
```

The delegation pattern in `createDocumentStoreWithEvents` (wrapping base store, not subclassing) is clean: transaction control always routes through `baseStore.dispatch`, while per-action events route through the enhanced `dispatch`. This avoids double-notification bugs.

---

## 4. Specific Contexts and Usages

**Cost algebra** (`$prove`, `$proveCtx`, `$checked`, `$pipe`, `$andThen`, `$map`): Pervasive in piece-table, line-index, rendering, and diff. Returns wrapped `Costed<Level, T>` values. Critical caveat from the SPEC: these are documentation annotations, not runtime enforcement. Any contributor can annotate an O(n) loop as O(1) — only a benchmark harness would catch it.

**Lazy vs Eager line index**: After inserts/deletes, `lineIndexInsertLazy`/`lineIndexDeleteLazy` update line counts immediately but mark ranges as dirty (`dirtyRanges`). `reconcileFull` resolves all dirty offsets. `reconcileViewport` resolves only the visible range. `getLineRangePrecise` works on both modes by falling back to range-delta arithmetic when dirty.

**GrowableBuffer sharing invariant**: When `append()` has capacity, it mutates the shared `bytes` array in-place. Old `GrowableBuffer` snapshots sharing the same backing array are safe *only* if all access stays within their own `length` field. Any caller reading `buffer.bytes.length` instead of `buffer.length` will silently read garbage bytes.

**PStack**: Persistent singly-linked list with the `_pstackBrand` private symbol. External code cannot construct a `PStackCons<T>` without `pstackPush`, which is the intended encapsulation. `pstackTrimToSize` is O(maxSize), not O(stack.size) — the comment and implementation are consistent.

**Transaction nesting**: The `TransactionManager` maintains a `snapshotStack` in parallel with `depth`. An invariant assertion (`snapshotStack.length === depth`) runs after every operation. Rollback restores the snapshot at the current nesting level only (inner rollback does not restore to the pre-outermost state).

---

## 5. Pitfalls

**P1. `reconcileNow` bumps `state.version`; background reconciliation does not.**
`scheduleReconciliation` comments say "background reconciliation is version-neutral." `reconcileNow` increments version. Two consumers using the same store can observe equal content but different version numbers depending on which reconciliation path ran. React's `useSyncExternalStore` compares by reference so it is safe, but any consumer diffing `state.version` will see spurious bumps.

**P2. `fixInsert` is O(n) and still exported.**
`rb-tree.ts` exports both `fixInsert` (O(n), full-tree traversal) and `fixInsertWithPath` (O(log n), path-only). The comment warns about this. Any caller that imports `fixInsert` silently gets O(n) per insert, making inserts into large documents O(n log n) total.

**P3. `backtrack` in Myers diff uses `edits.unshift()` per character.**
`edits.unshift()` is O(result.length). For a diff of `d` changes on a string of length `n`, backtracking is O(d × n) in the worst case, materially worse than building in reverse and calling `reverse()` once.

**P4. `computeSetValueActions` calls `textEncoder.encode(str.slice(0, i))` per diff edit.**
`stringIndexToByteIndex` slices and encodes a prefix of the string for each edit, allocating a Uint8Array per call. For documents with many small edits this produces O(edit_count × n) total allocations. A single scan building a char-to-byte offset map reduces this to O(n) allocations.

**P5. `getAffectedRange` for `APPLY_REMOTE` spans the full change extent.**
If remote changes are non-contiguous (e.g. insert at byte 0 and insert at byte 10000), the reported range covers [0, 10000+], making the event imprecise for consumers trying targeted re-renders.

**P6. `notifyListeners` snapshots to `Array.from(listeners)` on every notification.**
The snapshot prevents re-entrancy issues when a listener unsubscribes during notification. However, it allocates a new array on every state change. For high-frequency dispatch (key-per-character edits) this creates allocation pressure. The `notifying` flag already handles the re-entrancy case for `emergencyReset`; the snapshot is needed only for mid-iteration unsubscribes, which are rare.

**P7. `APPLY_REMOTE` event emission (SPEC-documented gap).**
The SPEC states `APPLY_REMOTE` does not auto-emit `content-change`. The current code in `store.ts` does check `action.type === 'APPLY_REMOTE'` for event emission, so the gap may already be resolved. This should be pinned with a targeted integration test.

---

## 6. Improvement Points — Design Overview

**I1. Version bump inconsistency between `reconcileNow` and background reconciliation.**
Unify the contract: either both bump version or neither does. The background path's "version-neutral" rationale is stronger (reconciliation does not change visible content), so `reconcileNow` should stop bumping version. Callers that need to re-render after `reconcileNow` should compare line index state, not version.

**I2. `batch()` reconciliation scheduling gap.**
Per SPEC: "`batch()` commit path does not automatically schedule line-index reconciliation when `rebuildPending` remains true." The current implementation routes `TRANSACTION_COMMIT` through `dispatch`, which does check `rebuildPending`. If the routing changed this may be closed; if not, `batch()` needs an explicit post-commit reconciliation check.

**I3. No integration test for `APPLY_REMOTE` → event emission.**
The known gap around `APPLY_REMOTE` event emission is underdocumented in tests. A test checking that `createDocumentStoreWithEvents` fires `content-change` after `APPLY_REMOTE` would pin the contract.

**I4. Cost algebra enforcement is entirely manual.**
There is no benchmark harness. Given the cost annotations appear on hot-path functions, adding benchmarks that measure insert/delete/query at N=10K, 100K, 1M would make the cost claims meaningful.

**I5. Chunk eviction is a stub.**
`EVICT_CHUNK` is defined but eviction semantics (e.g. whether pieces referencing the evicted chunk become invalid) are unspecified. Using chunk mode without understanding this can produce silent runtime errors (`Chunk N is not loaded` thrown from `getBuffer`).

---

## 7. Improvement Points — Types and Interfaces

**~~I6. `DocumentStore.getSnapshot()` returns unparameterized `DocumentState`.~~ ✓ Fixed 2026-04-11**

Added `getEagerSnapshot(): DocumentState<'eager'>` to `ReconcilableDocumentStore` (`src/types/store.ts`) and implemented it in `createDocumentStore` (`src/store/features/store.ts`). Unlike `reconcileNow()`, it does not bump the version number — resolving dirty offsets is content-neutral. Passed through unchanged in `createDocumentStoreWithEvents`.

**~~I7. `PStack` uses `as unknown as PStack<T>` casts internally.~~ ✓ Fixed 2026-04-11**

Replaced the `declare const _pstackBrand: unique symbol` + branded-type approach with an unexported `class PStackCons<T>` in `src/types/state.ts`. The class carries `private declare readonly _brand: never` (zero runtime overhead) to block plain-object structural assignability. All internal helpers now use `new PStackCons(...)` directly — no casts remain in `pstackPush` or `pstackTrimToSize`.

**~~I8. `getAffectedRange` returns `readonly [number, number]` (raw numbers, not `ByteOffset`).~~ ✓ Fixed 2026-04-11**

`getAffectedRange` in `src/store/features/events.ts` now returns `readonly [ByteOffset, ByteOffset]`. `ContentChangeEvent.affectedRange` and `createContentChangeEvent`'s parameter updated to match. All return sites now wrap computed offsets with `byteOffset(...)`.

**~~I9. `Unsubscribe` type is declared in two places.~~ ✓ Fixed 2026-04-11**

`src/types/store.ts` no longer declares `Unsubscribe`; it imports it from `src/store/features/events.ts` (the canonical site) and re-exports it, so `types/index.ts` consumers are unaffected.

**~~I10. `NonEmptyReadonlyArray` is a type alias, not a runtime guarantee.~~ ✓ Fixed 2026-04-11**

Added a guard at the top of `setSelection` in `src/store/features/reducer.ts`: if `ranges.length === 0`, a `console.warn` is emitted and the action is treated as a no-op (current state returned unchanged), consistent with the reducer's existing fail-soft style.

---

## 8. Improvement Points — Implementations

**~~I11. Replace `edits.unshift()` in diff backtracking with `push` + `reverse`.~~ ✓ Fixed 2026-04-11**

`backtrack` and `simpleDiff` in `src/store/features/diff.ts` now use `edits.push(...)` and call `edits.reverse()` once before `consolidateEdits()`. Backtracking from O(d²) to O(d).

**~~I12. Cache char-to-byte offset map in `computeSetValueActions`.~~ ✓ Fixed 2026-04-11**

Added `buildCharToByteMap(str): number[]` (single O(n) pass) in `src/store/features/diff.ts`. `computeSetValueActions` builds the map once before the ops loop and does O(1) lookups instead of calling `textEncoder.encode(str.slice(0, i))` per edit. `stringIndexToByteIndex` is retained as a thin helper for `computeSetValueActionsOptimized`, which calls it at most twice per invocation.

**~~I13. `estimateTotalHeight` with soft wrap calls `getVisibleLine` per line.~~ ✓ Fixed 2026-04-11**

Added `collectLineCharLengths` (O(n) in-order tree traversal) and `wrappedHeight` helpers in `src/store/features/rendering.ts`. Small-doc path (≤100 lines) now does a single tree traversal using `node.charLength`, eliminating O(n log n + n × line_length) `getVisibleLine` calls. Sampling path uses `findLineByNumber` + `charLength` (O(log n) per sample, no `getText` calls).

**I14. `scheduleReconciliation` 200ms `setTimeout` fallback in Node.js.**
For test environments and SSR, the 200ms timer can accumulate and affect teardown timing. A `reconcileMode: 'idle' | 'sync' | 'none'` option in `DocumentStoreConfig` would give consumers control without patching the global.

**I15. GrowableBuffer shared-mutation contract needs a dev-mode assertion.**
The class JSDoc describes the invariant, but a debug-mode bounds check would catch misuse in development:

```ts
// Development only:
if (start >= this.length || end > this.length) {
  throw new Error('GrowableBuffer: out-of-bounds read');
}
```

---

## 9. Learning Paths

### Path A — Core data structures (start here for contributors)

1. `src/types/state.ts` — `RBNode`, `PieceNode`, `LineIndexNode`, `DocumentState<M>`
2. `src/store/core/rb-tree.ts` — `rotateLeft/Right`, `fixInsertWithPath`, `WithNodeFn<N>`
3. `src/store/core/growable-buffer.ts` — shared-backing invariant
4. `src/store/core/piece-table.ts` — insert/delete, O(log n) position lookup
5. `src/store/core/line-index.ts` — lazy dirty ranges, reconciliation, `findLineAtPosition`
6. `src/store/core/state.ts` — factory functions, `withPieceNode` / `withLineIndexNode`

### Path B — Store / reducer / actions (for feature contributors)

1. `src/types/actions.ts` — exhaustive action union, `validateAction`, `isDocumentAction`
2. `src/store/features/reducer.ts` — `documentReducer`, position validation, undo/redo application
3. `src/store/features/transaction.ts` — `TransactionManager`, nesting, `emergencyReset`
4. `src/store/features/store.ts` — `createDocumentStore`, reconciliation scheduling, event wrapping

### Path C — API / rendering / diff (for application developers)

1. `src/api/interfaces.ts` — `QueryApi`, `ScanApi`, `HistoryApi` contracts with cost brands
2. `src/store/features/diff.ts` — `setValue`, `setValueWithDiff`, Myers vs optimized paths
3. `src/store/features/rendering.ts` — `getVisibleLines`, `positionToLineColumn`, `selectionToCharOffsets`
4. `src/store/features/events.ts` — event map, `createEventEmitter`, `getAffectedRange`

### Key concepts to internalize

- The lazy/eager line index trade-off and when `getLineRangePrecise` vs `getLineRange` is appropriate
- Why structural sharing is safe in `GrowableBuffer` (old snapshots + length boundary)
- Transaction snapshot stack: rollback restores only the current nesting level's snapshot
- Cost algebra: annotations are documentation, not enforced by the runtime
