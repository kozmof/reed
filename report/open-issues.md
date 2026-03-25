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

### #004 — `SelectionState.primaryIndex` unconstrained *(fixed 2026-03-25)*

`primaryIndex: number` can exceed `ranges.length` with no type or runtime protection. `ranges[primaryIndex]` fails silently. Ideally constrained to a non-empty array with a focus indicator that guarantees validity at the type level.

**Fix:** Added `NonEmptyReadonlyArray<T> = readonly [T, ...T[]]` type alias. `SelectionState.ranges` changed from `readonly SelectionRange[]` to `NonEmptyReadonlyArray<SelectionRange>`. TypeScript now rejects empty-array construction at compile time. Full `primaryIndex < ranges.length` enforcement remains impossible at the type level; the empty-array footgun is eliminated.

**Source:** Report 2, §5 P2 + §7 T1 (same issue)

---

### #005 — `HistoryReplaceChange` asymmetric byte length tracking *(fixed 2026-03-25)*

`HistoryInsertChange` and `HistoryDeleteChange` precompute `byteLength`. `HistoryReplaceChange` carries `oldText` but its byte length must be recomputed at undo time. Undo logic for `replace` cannot follow the same pattern as `insert`/`delete`.

**Fix:** Added `oldByteLength: number` to `HistoryReplaceChange`. Populated at record-creation time in `applyEdit` (`op.deleteEnd - op.position`). `invertChange` now uses `change.oldByteLength` directly. `applyChange` uses it for `deleteEnd` instead of re-encoding `oldText`. The `textEncoder` import in `reducer.ts` was subsequently removed as unused.

**Source:** Report 2, §7 T2

---

### #006 — `DirtyLineRange.endLine` sentinel not type-enforced *(fixed 2026-03-25)*

`endLine: number` uses `Number.MAX_SAFE_INTEGER` to represent "rest of document." Any integer passes the type check; the sentinel is indistinguishable from a real line number. A type alias `type EndOfDocument = typeof Number.MAX_SAFE_INTEGER` or a tagged union would express the intent.

**Fix:** Added `END_OF_DOCUMENT = Number.MAX_SAFE_INTEGER` constant and `EndOfDocument` type alias to `src/types/state.ts`, exported from `src/types/index.ts`. All six `endLine`-sentinel usages in `line-index.ts` replaced with `END_OF_DOCUMENT`. The sentinel is now a single named reference; textual search finds every site. (A full tagged-union approach was not taken as it would have required pervasive call-site changes for no additional runtime safety.)

**Source:** Report 2, §5 P6 + §7 T3 (same issue)

---

### #007 — `RBNode<T extends RBNode<T>>` over-permissive generic bound *(fixed 2026-03-25)*

The F-bounded polymorphism is too loose: `PieceNode.left` could be assigned a `LineIndexNode` without a compile-time error in certain indirect generic contexts. Generic tree operations assume same-type children but cannot enforce it.

**Fix:** Added `readonly _nodeKind: 'piece'` to `PieceNode` and `readonly _nodeKind: 'lineIndex'` to `LineIndexNode<M>`. Both factory functions (`createPieceNode`, `createLineIndexNode`) populate the field. The literal types make the two node kinds structurally distinct in all contexts, including indirect generic ones, without threading a second type parameter through `RBNode<T>` or `rb-tree.ts`.

**Source:** Report 2, §7 T4

---

### #008 — `BufferType` is not sealed against extension *(fixed 2026-03-25)*

`BufferReference` is a discriminated union, but `getPieceBuffer()` uses an `if/else` rather than an exhaustive `switch`. Adding a third buffer type would not cause a type error; the new case would silently fall through to `addBuffer`.

**Fix:** `getBuffer`, `getBufferSlice`, and `getPieceBuffer` in `piece-table.ts` all converted to exhaustive `switch` statements. The `default` branch assigns the narrowed value to a `never`-typed variable, causing a compile error if a new `BufferType` variant is ever added without handling it.

**Source:** Report 2, §7 T5

---

### #009 — `LineIndexNode<M>` phantom type verbosity *(acknowledged — not fixing)*

All tree operations must carry `<M extends EvaluationMode>`. Since `M` only affects `documentOffset` nullability, parameterizing only `LineIndexState<M>` (not individual nodes) would simplify type signatures.

Not fixing: removing the phantom from `LineIndexNode` would weaken the type system — `documentOffset` would always be `number | null`, and `getLineRangePrecise` overloads that currently guarantee non-null offsets in eager mode would lose that guarantee.

**Source:** Report 3, §7 T1

---

### #010 — Remote change `length` field not branded as byte length *(fixed 2026-03-25)*

`APPLY_REMOTE` action carries a `length` field typed as plain `number`. Separating it into a branded `ByteLength` would reduce accidental unit misuse at call sites that operate in char offsets.

**Fix:** `RemoteChange.length` changed from `number` to `ByteLength` in `src/types/actions.ts`. Arithmetic call sites in `reducer.ts` and `events.ts` required no change — both pass through `byteOffset(change.start + change.length)` where the `+` widens to `number` before `byteOffset()` re-brands it. Three test sites (`events.test.ts`, `store.logic.test.ts` ×2, `store.usecase.test.ts`) updated to use `byteLength(n)`.

**Source:** Report 1, §7 T2

---

### #011 — Event payload types remain generic `DocumentAction` *(fixed 2026-03-25)*

Remote content changes are now treated as first-class in dispatch and event behavior, but typed event handler payloads remain generic `DocumentAction` rather than narrowed per-event types.

**Fix:** Added `ContentChangeAction = InsertAction | DeleteAction | ReplaceAction | ApplyRemoteAction` to `src/types/actions.ts` and exported from `src/types/index.ts`. `ContentChangeEvent.action` and `createContentChangeEvent`'s parameter narrowed to `ContentChangeAction`. No cast needed in `store.ts` — the existing `isTextEditAction(action) || action.type === 'APPLY_REMOTE'` guard already narrows `action` to exactly `ContentChangeAction` before the `emit` call.

**Source:** Report 1, §7 T3

---

### #012 — Action schema-centric validation not enforced *(fixed 2026-03-25)*

The `DocumentAction` union definition, the `isDocumentAction` type guard, and the `validateAction` logic can diverge. A schema-centric approach (e.g. a single source of truth that generates guards and validators) would reduce this class of drift.

**Fix:** Added `src/types/str-enum.ts` with a `strEnum` utility. `DocumentActionTypes = strEnum([...13 type strings...])` is now the single source of truth; `DocumentActionType` is derived as `keyof typeof DocumentActionTypes`. Both `isDocumentAction` and `validateAction` use `action.type in DocumentActionTypes` for membership, then cast to `DocumentActionType` and switch on it. The `default` branch in each switch uses an IIFE `((_: never) => ...)(type)` — if a new key is added to `strEnum([...])` but its `case` is omitted, TypeScript errors at the `never` argument. Additionally filled the concrete validation gap: `validateAction`'s `APPLY_REMOTE` case now validates each `RemoteChange` element's `type`, `start`, `text` (insert), and `length` (delete); `isDocumentAction`'s `APPLY_REMOTE` case brought to parity.

**Source:** Report 1, §7 T4

---

## Algorithms

### #013 — `bstInsert()` path ordering contract is implicit *(fixed 2026-03-25)*

`bstInsert()` builds a path in leaf-to-root order, then `.reverse()` is called before balancing. This ordering dependency is not expressed in any type, comment, or assertion. Changing traversal order in `bstInsert()` silently breaks balancing.

**Fix:** Added `RootToLeafInsertPath<N extends RBNode<N>>` branded type to `rb-tree.ts` — an intersection of `InsertionPathEntry<N>[]` with `{ readonly _pathOrder: 'root-to-leaf' }`. `fixInsertWithPath` now requires this branded type. In `piece-table.ts`, `bstInsert` return type changed to `RootToLeafInsertPath<PieceNode>`; the existing `insertPath.reverse()` call is followed by `return insertPath as RootToLeafInsertPath<PieceNode>` — the cast is the explicit acknowledgment that `.reverse()` has run. Passing an unreversed path to `fixInsertWithPath` is now a compile error.

**Source:** Report 2, §5 P5

---

### #014 — `splitPiece()` assumes the split target is a leaf *(fixed 2026-03-25)*

When splitting, the left piece inherits `piece.left` and the right piece inherits `piece.right`. If the piece being split is an interior node, its original children are relocated without re-linking. The invariant "only split near-leaf nodes" is undocumented and unenforced.

**Fix:** Added a JSDoc `@pre` comment to `splitPiece` stating the near-leaf precondition. Added a runtime guard at the top of the function: `if (piece.left !== null && piece.right !== null) throw new Error('splitPiece: target must be a near-leaf node (at most one child)')`. This fails loudly at the point of violation rather than silently producing a structurally corrupt tree.

**Source:** Report 2, §8 Impl1

---

### #015 — `deleteRange()` has three inconsistent boundary check styles *(fixed 2026-03-25)*

The early-exit check, the left-child recurse guard, and the right-child recurse guard use different orderings of `deleteStart`, `deleteEnd`, `pieceStart`, `pieceEnd`, and `subtreeEnd`. Whether boundaries are inclusive or exclusive varies with no unifying convention.

**Fix:** Added a header comment to `deleteRange` establishing the canonical half-open interval convention: `[a, aEnd)` overlaps `[b, bEnd)` iff `a < bEnd && b < aEnd`. All four boundary checks were audited and rewritten in a uniform form using this convention: left-guard `offset < deleteEnd && deleteStart < pieceStart`, right-guard `pieceEnd < deleteEnd && deleteStart < subtreeEnd`. The early-exit and piece-skip checks were already canonical and left unchanged.

**Source:** Report 2, §8 Impl2

---

### #016 — History coalescing uses byte boundaries; char-offset callers may see drift *(fixed 2026-03-25)*

The contiguity check `newChange.position === last.position + last.byteLength` compares byte offsets against a byte length derived from `textEncoder.encode()`. If an editor layer uses character (UTF-16) positions, adjacent edits may fail to coalesce, or non-adjacent edits may coalesce incorrectly. Additionally, `HistoryInsertChange.byteLength` and `HistoryDeleteChange.byteLength` were unbranded `number`, allowing silent unit confusion.

**Fix:** `HistoryInsertChange.byteLength` and `HistoryDeleteChange.byteLength` changed from `number` to `ByteLength` in `src/types/state.ts`. In `reducer.ts`, all construction sites now call `byteLength()` to brand the value: `byteLength(insertedByteLength)` for inserts, `byteLength(op.deleteEnd - op.position)` for deletes; `coalesceChanges` wraps the summed byte lengths with `byteLength()`. Six `byteLength: 1` literals in `history.test.ts` updated to `byteLength: byteLength(1)`.

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

### #019 — Cost labels are phantom — no runtime enforcement *(fixed 2026-03-25)*

`$lift('O(1)', value)` and `$prove` accept any value without measuring cost. Any contributor can annotate an O(n) operation as `O(1)` and the type system will not object. The cost algebra is documentation, not a contract.

**Fix:** Added an explicit module-level `@remarks` block to `src/types/cost.ts` stating that cost labels are documentation annotations, not runtime or compile-time contracts. Added matching `@remarks` to `$prove`, `$proveCtx`, and `$lift` clarifying that the `max`/`_level` parameters are consumed only by the type system and do not constrain or measure actual runtime performance. The false promise is now an honest disclaimer; contributors reading the API surface will encounter the caveat at every boundary function.

**Source:** Report 2, §5 P3

---

### #020 — Branded type constructors accept invalid values *(fixed 2026-03-25)*

`byteOffset(-1)`, `byteOffset(NaN)`, `byteOffset(Infinity)` all compile and produce valid-looking `ByteOffset` values. `isValidOffset()` exists but is not called by any constructor. The branded types promise nominal safety that the constructors do not provide.

**Fix:** Added `RangeError` guards to all five constructors in `src/types/branded.ts`: `byteOffset`, `charOffset`, `byteLength` call `isValidOffset` (non-negative integer check); `lineNumber` and `columnNumber` call `isValidLineNumber` (same check). All throw `RangeError` with a descriptive message if given a negative, non-integer, NaN, or infinite value. Two tests that used `byteOffset(-1)` / `charOffset(-5)` to test downstream graceful handling were updated: the `piece-table.test.ts` "return null for negative position" test was changed to `toThrow(RangeError)`, the `byteOffset(-1)` case in the `getText` invalid-range test was removed (that scenario is now rejected at the constructor), and the `charOffset(-5)` assertion in the clamp test was removed (a negative `CharOffset` is no longer constructable).

**Source:** Report 2, §5 P4

---

### #021 — `getValueStream()` defers O(n) allocation to first iteration, invisibly *(fixed 2026-03-25)*

`collectPieces()` is called inside the generator body, so the O(n) allocation happens during the first `next()` call, not at generator creation time. The function signature gives no indication of when this work occurs. Callers that hold the generator and iterate later trigger allocation at an unpredictable point in the call stack.

**Fix:** `getValueStream` converted from a `function*` to a regular function. It now calls `collectPieces(state.root)` (and evaluates the guard conditions) eagerly before returning a generator. The actual yield logic is moved to a private `streamChunks` inner generator that closes over the already-collected pieces array. Callers see the same `Generator<DocumentChunk, void, undefined>` return type; allocation now occurs at `getValueStream()` call time. A `@remarks` annotation documents when the O(n) collection happens.

**Source:** Report 2, §5 P8 + §8 Impl5 (same issue)

---

### #022 — `TransactionManager.rollback()` does not guard against unmatched calls *(fixed 2026-03-25)*

`rollback()` pops from `snapshotStack` and decrements `depth` without verifying that a corresponding `begin()` was called. An extra `rollback()` produces `depth = -1`; subsequent dispatches may notify listeners prematurely or skip notifications. `assertInvariant` (added by Report 4 Impl3) will throw after the fact, but does not prevent the decrement.

**Fix:** The silent early-return in `rollback()` (which returned `snapshot: null` when `depth === 0`) was changed to `throw new Error('TransactionManager: rollback() called with no active transaction (depth is already 0)')`. A `@throws` annotation was added to the `TransactionManager` interface JSDoc. Two tests in `transaction.test.ts` that previously asserted the no-op behavior were updated to `expect(() => tm.rollback()).toThrow('no active transaction')`.

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
