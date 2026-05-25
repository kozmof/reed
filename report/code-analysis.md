# Reed — Code Analysis

_Date: 2026-05-25_

---

## 1. Code Organization and Structure

The project is a TypeScript text-engine library called **Reed**. It has no runtime dependencies — dev dependencies are Vitest, oxlint/oxfmt, and Vite.

**Directory layout:**

```
src/
  index.ts            ← Public entry point (namespaced exports)
  types/              ← All type definitions, no logic
    state.ts          ← DocumentState, PieceTable, LineIndex, History, PStack
    actions.ts        ← Action types, guards, validateAction
    store.ts          ← Store/transaction interface types
    branded.ts        ← ByteOffset, CharOffset, LineNumber, etc.
    cost-doc.ts       ← Cost-algebra types and combinators
    operations.ts     ← ReadTextFn, DeleteBoundaryContext
    utils.ts, str-enum.ts
  store/
    core/             ← Low-level data structures (no knowledge of DocumentState)
      rb-tree.ts      ← Generic immutable RB-tree (rotations, fixup, insert-path)
      piece-table.ts  ← Piece table CRUD on PieceTableState
      line-index.ts   ← Line index CRUD on LineIndexState (lazy+eager)
      reconcile.ts    ← Background dirty-range reconciliation
      state.ts        ← Node constructors: createPieceNode, withPieceNode, etc.
      growable-buffer.ts
      encoding.ts
    features/         ← High-level features on DocumentState
      reducer.ts      ← documentReducer (the single pure dispatch function)
      edit.ts         ← applyEdit, applyChange, historyPush
      history.ts      ← historyUndo, historyRedo, canUndo/Redo
      store.ts        ← createDocumentStore, createDocumentStoreWithEvents
      transaction.ts  ← TransactionManager
      chunk-manager.ts← ChunkManager (LRU eviction policy)
      diff.ts         ← Myers diff, setValue, setValueWithDiff
      events.ts       ← DocumentEventEmitter
      rendering.ts    ← Viewport, line-column, selection conversion
      actions.ts      ← DocumentActions creator helpers
  api/
    index.ts          ← Assembles named namespaces (store, query, scan, …)
    interfaces.ts     ← satisfies-checked interface contracts for each namespace
    query.ts, scan.ts, history.ts, diff.ts, rendering.ts, events.ts, position.ts
    cost-doc.ts       ← cost namespace
```

**Layering discipline** is well-enforced:

```
types/  ←  store/core/  ←  store/features/  ←  api/  ←  src/index.ts
```

No upward imports; the boundary is clean. Zero runtime npm dependencies.

---

## 2. Relations of Implementations — Types & Interfaces

```
RBNode<T>
  ├─ PieceNode = OriginalPieceNode | AddPieceNode | ChunkPieceNode
  └─ LineIndexNode<M extends EvaluationMode>

PieceTableState           ──uses──> PieceNode, GrowableBuffer
LineIndexState<M>         ──uses──> LineIndexNode<M>
DocumentState<M>          ──uses──> PieceTableState, LineIndexState<M>,
                                     SelectionState, HistoryState, DocumentMetadata

HistoryState              ──uses──> PStack<HistoryEntry>
HistoryEntry              ──uses──> HistoryChange (insert|delete|replace), SelectionState

DocumentAction            ── union of 11 action types (INSERT…DECLARE_CHUNK_METADATA)
DocumentStore             ── subscribe/getSnapshot/dispatch/batch
ReconcilableDocumentStore ─ extends DocumentStore + reconcileNow / setViewport
DocumentStoreWithEvents   ─ extends Reconcilable + addEventListener

Costed<Level, T>          ── phantom brand over T; aliases ConstCost/LogCost/LinearCost/…
CostFn<Level, Args, R>    ── function with declared cost bound
Ctx<C,T>                  ── pipeline context carrying phantom cost C
```

Key generic relationships:

- `DocumentState<M>` propagates the `EvaluationMode` type parameter down to `LineIndexState<M>` and `LineIndexNode<M>`, making "has-no-dirty-offsets" statically provable at call sites.
- `RBNode<T>` uses F-bounded polymorphism (`T extends RBNode<T>`) so `rb-tree.ts` is fully generic and shared by both the piece tree and line-index tree without any casting.
- `BufferReference` is a discriminated union on `bufferType`; `PieceNode` mirrors this with `bufferType` as its discriminant, so switch statements narrow cleanly with exhaustiveness checking.

**Branded position types** (`src/types/branded.ts`) create a nominal type system on top of `number`:

```
ByteOffset  ≠  CharOffset  ≠  ByteLength  ≠  LineNumber  ≠  ColumnNumber
```

Zero runtime cost — phantom brand only. Prevents the classic "mixed UTF-8 byte offset with UTF-16 code unit" bug at compile time.

---

## 3. Relations of Implementations — Functions

**Edit pipeline (write path):**

```
store.dispatch(action)
  └─ documentReducer(state, action)               [reducer.ts]
       ├─ INSERT/DELETE/REPLACE → applyEdit(state, params)  [edit.ts]
       │    ├─ validatePosition / validateRange
       │    ├─ ptInsert / ptDelete                [piece-table.ts]
       │    ├─ liInsertLazy / liDeleteLazy         [line-index.ts]
       │    └─ historyPush → pstackPush, pstackTrimToSize
       ├─ UNDO → historyUndo → applyInverseChange  [history.ts / edit.ts]
       ├─ REDO → historyRedo → applyChange         [history.ts / edit.ts]
       ├─ LOAD_CHUNK → appendChunkPiece / insertChunkPieceAt + liInsertLazy
       └─ EVICT_CHUNK → removeChunkPiecesFromTree + liDeleteLazy
```

**RB-tree write path (insert):**

```
pieceTableInsert → rbInsertPiece
  └─ bstInsert (recursively builds insertion path, then reverses to root-to-leaf order)
       └─ fixInsertWithPath [rb-tree.ts]
            ├─ fixInsertViolation (color-flip or rotation)
            └─ ensureBlackRoot

pieceTableDelete → deleteRange (recursive tree rebuild with early-exit on non-overlap)
  └─ mergeTrees → joinByBlackHeight → joinRight / joinLeft
```

**Read path:**

```
query.getText             → getText              [piece-table.ts]   O(n)
query.findPieceAtPosition → findPieceAtPosition                    O(log n)
query.findLineAtPosition  → findLineAtPosition   [line-index.ts]   O(log n)
scan.getValue             → getValue → collectPieces               O(n)
scan.getValueStream       → inOrderPieces (lazy generator)         O(n) streaming
rendering.getVisibleLines → getLineRangePrecise + getText          O(n in viewport range)
```

**Reconciliation path:**

```
store.scheduleReconciliation()
  └─ requestIdleCallback / setTimeout (200 ms fallback)
       └─ reconcileFull(lineIndex, version)   [reconcile.ts]
            └─ reconcileRange (per dirty range, or full rebuild if sentinel)
```

---

## 4. Specific Contexts and Usages

**Piece table** uses an immutable RB-tree where every edit creates O(log n) new nodes via path-copying. `subtreeLength` aggregates total byte count per subtree for O(log n) position lookups without full traversal. `subtreeAddLength` provides O(1) buffer-waste statistics without any traversal.

**Line index** is maintained lazily on edit — O(log n) insert/delete for the tree structure, with only dirty-range bookkeeping for offset recomputation. Offsets (`documentOffset`) can be `null` in lazy mode. They are resolved in background via `reconcileFull`, or on demand via `getEagerSnapshot()` / `reconcileNow()`. `unloadedLineCountsByChunk` lets the index report a total line count even when chunks are evicted.

**PStack** (`src/types/state.ts`) is a persistent cons-list stack used for undo/redo. The private `PStackCons` class prevents external construction, enforcing use of the helper API. `pstackTrimToSize` is deliberately O(maxSize) rather than O(H), which is important for bounded history in long sessions.

**Cost algebra** (`src/types/cost-doc.ts`) uses phantom types (`Costed<Level, T>`) to annotate return types of every exported function with their Big-O bound. `$prove` and `$proveCtx` verify at compile time that the composed plan's type-level cost is ≤ the declared bound. The `$pipe` / `$andThen` / `$map` combinators propagate cost through a pipeline with zero runtime overhead.

**Chunk streaming** (`LOAD_CHUNK` / `EVICT_CHUNK`): A sequential first-time load uses the O(log n) `appendChunkPiece` right-spine graft. Out-of-order or re-loads use the O(n) `findReloadInsertionPos` scan + `insertChunkPieceAt`. Eviction rebuilds the RB-tree from survivors via `removeChunkPiecesFromTree`. `unloadedLineCountsByChunk` preserves line counts for evicted chunks so callers can still query total line count.

**Event store** (`createDocumentStoreWithEvents`): Wraps the base store with a depth-indexed event buffer (`pendingEventLevels`). Events accumulate per transaction nesting level and are flushed on outermost commit or discarded on rollback. This prevents partial-transaction events from leaking to subscribers.

---

## 5. Pitfalls

**a) `deleteRange` is O(n) in number of pieces, not O(log n)**
The function in `src/store/core/piece-table.ts` recurses the entire tree when the deleted range spans many pieces. Callers annotate the result correctly as `LinearCost`, but this can surprise developers expecting piece-table deletes to be O(log n).

**b) `collectPieces` uses recursive in-order traversal**
The private `inOrder` helper in `piece-table.ts` uses recursion, creating call-stack frames proportional to tree depth O(log n). The iterative `pieceTableInOrder` pattern used elsewhere in the same file is the preferred idiom and avoids this risk for pathologically deep trees.

**c) `removeChunkPiecesFromTree` produces red leaf nodes in the rebuilt tree**
`src/store/features/reducer.ts` — leaves are colored red "so subsequent inserts have RB slack." This is correct because the median-split guarantees equal black-height on all root-to-null paths, but the invariant reasoning is non-obvious and not locally documented.

**d) `bstInsert` builds insertion path in leaf-to-root order, then reverses**
`src/store/core/piece-table.ts` — the recursion unwinds leaf-to-root, then `.reverse()` converts to root-to-leaf. This allocates an extra pass. An iterative descent building the path directly in root-to-leaf order would avoid it.

**e) Myers diff `trace` allocates `Int32Array` per step `d`**
`src/store/features/diff.ts` — `trace.push(new Int32Array(v))` on each outer-loop iteration creates O(n+m) arrays of O(n+m) length each, so worst-case O((n+m)²) memory for the large-string path. The simple DP path uses a single flat `Int32Array` and is much more memory-efficient.

**f) `SET_SELECTION` with empty ranges silently no-ops with only a `console.warn`**
`src/store/features/reducer.ts` — callers have no way to detect the error other than comparing before/after state. Consider using `validateAction` before dispatch, or returning a typed error result.

**g) Background reconciliation reads the live `state` closure variable, not a snapshot**
`src/store/features/store.ts` — the idle callback always reconciles the *current* state, not the state that was pending when the callback was scheduled. This is correct behavior (reconcile against the latest state) but can be surprising if a test or caller expects snapshot-stable semantics.

---

## 6. Improvement Points — Design Overview

**1. Two `setValue` paths with different performance profiles**
`setValue` (O(n), single REPLACE) and `setValueWithDiff` (O(n²) Myers) are both exposed at the top level. Their relationship and tradeoffs could be clearer — e.g., a unified `setValue(state, newContent, strategy: 'optimized' | 'minimal-diff' = 'optimized')`.

**2. No formal "reconciliation ready" contract in the public API**
External consumers must check `lineIndex.rebuildPending` and call `reconcileNow()` manually. A `whenReconciled(): Promise<DocumentState<"eager">>` helper or a `'reconciled'` event would make the lazy→eager transition ergonomic.

**3. `createDocumentStoreWithEvents.batch` duplicates base store's batch logic**
The events store reimplements `batch` using `withTransactionBatch` rather than delegating to the base store's `batch`. Future changes to base-store batch semantics require a parallel update here.

**4. Chunk API is imperative and easy to misuse**
Callers must sequence `DECLARE_CHUNK_METADATA → LOAD_CHUNK → EVICT_CHUNK` correctly. A higher-level `StreamingDocumentLoader` encapsulating this protocol would reduce misuse surface.

**5. No add-buffer compaction strategy**
The add buffer grows unboundedly as edits accumulate. A long-lived document with many edits will keep allocating. A periodic "compact" operation (flatten piece table + add buffer into a single original buffer) is missing. `compactAddBuffer` exists in `piece-table.ts` but is not wired into any automatic policy.

---

## 7. Improvement Points — Types & Interfaces

**1. Dual-sentinel pattern in `DirtyLineRangeList` is complex**
There is both a `DirtyLineRangeSentinel` object (`{ kind: "sentinel" }`) at the entry level AND the string literal `"full-rebuild-needed"` at the list level in `DirtyLineRangeList`. The two-level sentinel design requires callers to check both patterns. Consolidating to a single sentinel form would simplify switch statements.

**2. `PStack<T>` exposes internal fields through the exported type**
`PStack<T> = null | PStackCons<T>` and `PStackCons` is an unexported class, but callers can still read `.top` / `.rest` / `.size` directly on returned instances. The `private declare _brand: never` prevents construction but not read access. Making `PStack` a fully opaque branded type and exporting only the helper functions would enforce the API boundary.

**3. `QueryApi` returns raw `number` for `getLineStartOffset` / `getCharStartOffset`**
`src/api/interfaces.ts` — these should return `LogCost<ByteOffset>` and `LogCost<CharOffset>` respectively, matching the rest of the branded-type discipline.

**4. `VisibleLine.startOffset` / `endOffset` are typed as `number`, not `ByteOffset`**
`src/store/features/rendering.ts` — breaks the consistency of the rest of the API where byte positions are always `ByteOffset`.

**5. `LoadChunkAction.data: ReadonlyUint8Array` but `isDocumentAction` checks `instanceof Uint8Array`**
`src/types/actions.ts` — `ReadonlyUint8Array` is a compile-time alias; the runtime guard correctly checks `instanceof Uint8Array`. A clarifying comment would prevent future confusion for contributors who see the type mismatch.

---

## 8. Improvement Points — Implementations

**1. `simpleDiff` produces single-character edits then consolidates**
`src/store/features/diff.ts` — the DP backtrack builds edits character-by-character, then `consolidateEdits` merges consecutive same-type entries in O(n). Building runs during backtrack directly would eliminate the consolidation pass.

**2. `buildCharToByteMap` lone-surrogate edge case**
`src/store/features/diff.ts` — for a lone high surrogate at the end of the string, the map entry at `str.length` reflects the lone-surrogate byte count (3 bytes) rather than a pair. This is technically correct since `textEncoder.encode` would also produce 3 bytes for a lone surrogate, but the edge case has no dedicated test.

**3. `getVisibleLine` carries `totalLines` through the pipeline without using its value**
`src/store/features/rendering.ts` — `$andThen(() => $from(range))` computes and then discards `totalLines`, using it only to carry the cost type. A simpler `$from(range)` chain with a direct `$prove` boundary would be clearer.

**4. `charToByteOffset` double-encodes the string**
`src/store/core/piece-table.ts` — encodes `text.slice(0, clampedOffset)`, which for large `charOffset` values encodes most of the string. A scan-based approach (analogous to `byteToCharOffset`'s UTF-8 width scan) would avoid the allocation.

**5. `reconcileRangeForChanges` is in `edit.ts` but belongs closer to history**
The function bridges `HistoryChange[]` (a `history.ts` concern) and `LineIndexState` reconciliation (a `line-index.ts` concern) through `edit.ts`, which is primarily about the insert/delete pipeline. Moving it to `history.ts` or a dedicated `reconcile-history.ts` would better reflect ownership.

---

## 9. Learning Paths — Entries and Goals

### Path A: Understand the data model (beginner)

1. [src/types/branded.ts](../src/types/branded.ts) — learn why nominal types matter for byte vs. char offset safety
2. [src/types/state.ts](../src/types/state.ts) — understand `DocumentState`, `PieceTableState`, `LineIndexState`, `PStack`
3. [src/store/core/growable-buffer.ts](../src/store/core/growable-buffer.ts) — simplest structure; append-only semantics
4. [src/store/core/piece-table.ts](../src/store/core/piece-table.ts) — how text is stored non-contiguously

**Goal:** Read a `DocumentState` snapshot and mentally reconstruct the document text. Explain why `documentOffset` can be `null`.

---

### Path B: Trace a single INSERT action end-to-end (intermediate)

1. Path A
2. [src/types/actions.ts](../src/types/actions.ts) — the full action vocabulary and type guards
3. [src/store/features/edit.ts](../src/store/features/edit.ts) — validation and the edit pipeline
4. [src/store/features/reducer.ts](../src/store/features/reducer.ts) — INSERT case → `applyEdit`
5. [src/store/core/rb-tree.ts](../src/store/core/rb-tree.ts) — generic rotations and path-based fixup
6. [src/store/features/store.ts](../src/store/features/store.ts) — dispatch, transactions, notification

**Goal:** Trace a single INSERT from `store.dispatch()` through the reducer, piece-table insertion, RB-tree rebalancing, line-index update, history push, and subscriber notification.

---

### Path C: Understand lazy line indexing and reconciliation (intermediate–advanced)

1. Paths A + B
2. [src/store/core/line-index.ts](../src/store/core/line-index.ts) — `lineIndexInsertLazy`, `lineIndexDeleteLazy`, dirty-range accumulation
3. [src/store/core/reconcile.ts](../src/store/core/reconcile.ts) — `reconcileFull`, `reconcileRange`, `reconcileViewport`
4. [src/types/cost-doc.ts](../src/types/cost-doc.ts) — cost algebra, `$prove`, `$pipe`, `$andThen`

**Goal:** Explain when `documentOffset` is safe to read, how dirty ranges are merged, and what triggers a full vs. incremental rebuild.

---

### Path D: Understand the cost algebra (any level)

1. [src/types/cost-doc.ts](../src/types/cost-doc.ts) — `Costed`, `$prove`, `$proveCtx`, `$declare`, pipeline combinators
2. [src/api/interfaces.ts](../src/api/interfaces.ts) — how `satisfies` enforces the contracts on namespace exports
3. Any one namespace implementation (e.g., `src/api/query.ts`)

**Goal:** Understand what `$prove` actually verifies at compile time vs. what it leaves unchecked at runtime, and why `$declare` is a trust annotation.

---

### Path E: Understand chunk streaming (advanced)

1. Paths A + B
2. [src/types/actions.ts](../src/types/actions.ts) — `LoadChunkAction`, `EvictChunkAction`, `DeclareChunkMetadataAction`
3. [src/store/features/reducer.ts](../src/store/features/reducer.ts) — `LOAD_CHUNK` and `EVICT_CHUNK` cases
4. [src/store/features/chunk-manager.ts](../src/store/features/chunk-manager.ts) — LRU eviction, pinning, deduplication

**Goal:** Implement a streaming file loader: declare metadata, load chunks sequentially, pin the visible window, and evict out-of-view chunks without losing line counts.

---

### Path F: Understand the store and transaction model (advanced)

1. Paths A + B
2. [src/store/features/transaction.ts](../src/store/features/transaction.ts) — nested transactions, snapshot stack
3. [src/store/features/store.ts](../src/store/features/store.ts) — `withTransactionBatch`, `emergencyReset`, copy-on-write listeners
4. [src/store/features/events.ts](../src/store/features/events.ts) — depth-indexed event buffering

**Goal:** Explain nested transaction semantics, what `emergencyReset` does and when it fires, and how events are buffered and flushed correctly across transaction nesting levels.
