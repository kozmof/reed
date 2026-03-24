# Open Issues and Improvements

Extracted from `code-analyze.md` on 2026-03-25.
Items marked *(acknowledged — not fixing)* have a documented rationale for deferral and are included for completeness.

---

## Architecture / Design

### #001 — Chunk loading handlers are stubs

The `LOAD_CHUNK` / `EVICT_CHUNK` action handlers are not implemented. The `DocumentState` already holds `metadata` fields for these, creating a false impression of readiness.

**Source:** Report 2, §6 D3

---

### #002 — No invariant document for core structures

No concise invariant reference exists for piece table subtree fields, line index mode guarantees, or reconciliation invariants. Invariant drift risk grows as the codebase evolves.

**Source:** Report 1, §6 D4

---

### #003 — No benchmark harness

No benchmark harness for large-document edits, mixed line endings, or reconciliation thresholds. Performance confidence rests entirely on functional tests.

**Source:** Report 1, §8 Impl3

---

## Types & Interfaces

### #004 — `SelectionState.primaryIndex` unconstrained

`primaryIndex: number` can exceed `ranges.length` with no type or runtime protection. `ranges[primaryIndex]` fails silently. Ideally constrained to a non-empty array with a focus indicator that guarantees validity at the type level.

**Source:** Report 2, §5 P2 + §7 T1 (same issue)

---

### #005 — `HistoryReplaceChange` asymmetric byte length tracking

`HistoryInsertChange` and `HistoryDeleteChange` precompute `byteLength`. `HistoryReplaceChange` carries `oldText` but its byte length must be recomputed at undo time. Undo logic for `replace` cannot follow the same pattern as `insert`/`delete`.

**Source:** Report 2, §7 T2

---

### #006 — `DirtyLineRange.endLine` sentinel not type-enforced

`endLine: number` uses `Number.MAX_SAFE_INTEGER` to represent "rest of document." Any integer passes the type check; the sentinel is indistinguishable from a real line number. A type alias `type EndOfDocument = typeof Number.MAX_SAFE_INTEGER` or a tagged union would express the intent.

**Source:** Report 2, §5 P6 + §7 T3 (same issue)

---

### #007 — `RBNode<T extends RBNode<T>>` over-permissive generic bound

The F-bounded polymorphism is too loose: `PieceNode.left` could be assigned a `LineIndexNode` without a compile-time error in certain indirect generic contexts. Generic tree operations assume same-type children but cannot enforce it.

**Source:** Report 2, §7 T4

---

### #008 — `BufferType` is not sealed against extension

`BufferReference` is a discriminated union, but `getPieceBuffer()` uses an `if/else` rather than an exhaustive `switch`. Adding a third buffer type would not cause a type error; the new case would silently fall through to `addBuffer`.

**Source:** Report 2, §7 T5

---

### #009 — `LineIndexNode<M>` phantom type verbosity *(acknowledged — not fixing)*

All tree operations must carry `<M extends EvaluationMode>`. Since `M` only affects `documentOffset` nullability, parameterizing only `LineIndexState<M>` (not individual nodes) would simplify type signatures.

Not fixing: removing the phantom from `LineIndexNode` would weaken the type system — `documentOffset` would always be `number | null`, and `getLineRangePrecise` overloads that currently guarantee non-null offsets in eager mode would lose that guarantee.

**Source:** Report 3, §7 T1

---

### #010 — Remote change `length` field not branded as byte length

`APPLY_REMOTE` action carries a `length` field typed as plain `number`. Separating it into a branded `ByteLength` would reduce accidental unit misuse at call sites that operate in char offsets.

**Source:** Report 1, §7 T2

---

### #011 — Event payload types remain generic `DocumentAction`

Remote content changes are now treated as first-class in dispatch and event behavior, but typed event handler payloads remain generic `DocumentAction` rather than narrowed per-event types.

**Source:** Report 1, §7 T3

---

### #012 — Action schema-centric validation not enforced

The `DocumentAction` union definition, the `isDocumentAction` type guard, and the `validateAction` logic can diverge. A schema-centric approach (e.g. a single source of truth that generates guards and validators) would reduce this class of drift.

**Source:** Report 1, §7 T4

---

## Algorithms

### #013 — `bstInsert()` path ordering contract is implicit

`bstInsert()` builds a path in leaf-to-root order, then `.reverse()` is called before balancing. This ordering dependency is not expressed in any type, comment, or assertion. Changing traversal order in `bstInsert()` silently breaks balancing.

**Source:** Report 2, §5 P5

---

### #014 — `splitPiece()` assumes the split target is a leaf

When splitting, the left piece inherits `piece.left` and the right piece inherits `piece.right`. If the piece being split is an interior node, its original children are relocated without re-linking. The invariant "only split near-leaf nodes" is undocumented and unenforced.

**Source:** Report 2, §8 Impl1

---

### #015 — `deleteRange()` has three inconsistent boundary check styles

The early-exit check, the left-child recurse guard, and the right-child recurse guard use different orderings of `deleteStart`, `deleteEnd`, `pieceStart`, `pieceEnd`, and `subtreeEnd`. Whether boundaries are inclusive or exclusive varies with no unifying convention.

**Source:** Report 2, §8 Impl2

---

### #016 — History coalescing uses byte boundaries; char-offset callers may see drift

The contiguity check `newChange.position === last.position + last.byteLength` compares byte offsets against a byte length derived from `textEncoder.encode()`. If an editor layer uses character (UTF-16) positions, adjacent edits may fail to coalesce, or non-adjacent edits may coalesce incorrectly.

**Source:** Report 2, §5 P7

---

### #017 — `deleteLineRangeLazy` calls O(n) tree rebuild even in lazy mode *(acknowledged — not fixing)*

For multi-line deletions, `rebuildWithDeletedRange` is called even in lazy mode because the resulting tree shape changes. Lazy delete with newlines has the same O(n) cost as eager delete, negating the lazy optimization for this case.

Not fixing: the Red-Black tree must be rebalanced after removing each line node (O(log n) per deleted line). "Lazy" defers only offset recalculation, not structural rebalancing. The current approach is correct.

**Source:** Report 3, §5 P5 (`src/store/core/line-index.ts`)

---

### #018 — `reconcileInPlace` visits all nodes even when offsets are already correct *(acknowledged — not fixing)*

The short-circuit `node.documentOffset !== correctOffset` avoids node allocation but not subtree traversal. A subtree-level correctness flag (analogous to `rebuildPending` at the state level) would allow pruning entire subtrees known to be clean.

Not fixing: coordinating invalidation across every lazy tree mutation (`insertLinesAtPositionLazy`, `rbDeleteLineByNumber`, rotations) carries high complexity. With `reconcileRange` now O(K+V), `reconcileInPlace` is already the last resort and runs infrequently.

**Source:** Report 3, §8 Impl3 (`src/store/core/line-index.ts`)

---

## Implementations

### #019 — Cost labels are phantom — no runtime enforcement

`$lift('O(1)', value)` and `$prove` accept any value without measuring cost. Any contributor can annotate an O(n) operation as `O(1)` and the type system will not object. The cost algebra is documentation, not a contract.

**Source:** Report 2, §5 P3

---

### #020 — Branded type constructors accept invalid values

`byteOffset(-1)`, `byteOffset(NaN)`, `byteOffset(Infinity)` all compile and produce valid-looking `ByteOffset` values. `isValidOffset()` exists but is not called by any constructor. The branded types promise nominal safety that the constructors do not provide.

**Source:** Report 2, §5 P4

---

### #021 — `getValueStream()` defers O(n) allocation to first iteration, invisibly

`collectPieces()` is called inside the generator body, so the O(n) allocation happens during the first `next()` call, not at generator creation time. The function signature gives no indication of when this work occurs. Callers that hold the generator and iterate later trigger allocation at an unpredictable point in the call stack.

**Source:** Report 2, §5 P8 + §8 Impl5 (same issue)

---

### #022 — `TransactionManager.rollback()` does not guard against unmatched calls

`rollback()` pops from `snapshotStack` and decrements `depth` without verifying that a corresponding `begin()` was called. An extra `rollback()` produces `depth = -1`; subsequent dispatches may notify listeners prematurely or skip notifications. `assertInvariant` (added by Report 4 Impl3) will throw after the fact, but does not prevent the decrement.

**Source:** Report 2, §8 Impl3

---

### #023 — Inner rollback restores only the matching snapshot, not outermost state *(acknowledged — not fixing)*

```ts
dispatch(TRANSACTION_START)    // begin(stateA), depth=1
dispatch(INSERT 'X')           // state now stateA+X
dispatch(TRANSACTION_START)    // begin(stateA+X), depth=2
dispatch(INSERT 'Y')           // state now stateA+X+Y
dispatch(TRANSACTION_ROLLBACK) // → restores stateA+X, depth=1
dispatch(TRANSACTION_COMMIT)   // → commits stateA+X, notifies
```

Inner rollback does not provide full abort semantics unless the outer transaction also rolls back. This is correct by design but is a common source of confusion.

**Source:** Report 4, §5 P3
