# Code Analysis Reports

---

# Report 1: 2026-02-23 (Updated 2026-02-24)

## Scope and method
- Target: current `reed` codebase in `src/` and `spec/`.
- Approach: read core/store/api/type layers, trace function relationships, and validate reliability through tests.
- Verification run: `pnpm test` on 2026-02-24.
- Test result: `11` test files, `495` tests passed.

## 1. Code organization and structure
- Layering is clear and mostly consistent:
  - `src/types/*`: domain model, action/store contracts, branded types, cost algebra.
  - `src/store/core/*`: immutable data structures and algorithms (piece table, line index, RB-tree helpers, state factories).
  - `src/store/features/*`: reducer, store orchestration, diff/setValue, events, rendering, history helpers, transaction manager.
  - `src/api/*`: complexity-stratified read APIs (`query.*` vs `scan.*`).
  - `src/index.ts`: aggregated public surface.
- Strengths:
  - Good separation between pure transition logic (`documentReducer`) and side effects/orchestration (`createDocumentStore`).
  - Persistent immutable node updates via `withPieceNode` and `withLineIndexNode` centralize subtree metadata maintenance.
  - Explicit complexity branding (`Costed`, `CostFn`) is consistently applied.
- Structural risk:
  - The system combines two complexity-heavy cores (piece table + lazy/eager line index), which raises maintenance overhead for edge-case correctness.

## 2. Relations of implementations (types/interfaces)
- `DocumentState<M extends EvaluationMode>` in `src/types/state.ts` is the root model:
  - `pieceTable: PieceTableState`
  - `lineIndex: LineIndexState<M>`
  - `selection`, `history`, `metadata`
- Mode-aware line index typing is a strong design:
  - `LineIndexState<'eager'>` guarantees no dirty ranges and `rebuildPending: false`.
  - `LineIndexState<'lazy'>` allows dirty ranges and deferred reconciliation.
- `LineIndexStrategy<M>` in `src/types/store.ts` formalizes eager/lazy dual behavior and keeps reducer wiring generic.
- `DocumentAction` union in `src/types/actions.ts` is comprehensive, and runtime action guard coverage is now aligned with the union (including `HISTORY_CLEAR`).
- Branded offset types (`ByteOffset`, `CharOffset`, `ByteLength`) reduce class-of-bug mixing position units.

## 3. Relations of implementations (functions)
- Primary write pipeline:
  - `DocumentActions.*` -> `store.dispatch` -> `documentReducer` -> `pieceTable*` + `lineIndex*` updates.
- `documentReducer` in `src/store/features/reducer.ts`:
  - Uses a unified `applyEdit` path for INSERT/DELETE/REPLACE.
  - Uses lazy line-index strategy for normal edits.
  - Uses eager reconciliation for undo/redo via `reconcileFull`.
  - Handles CRLF/CR boundary cases with conditional rebuild fallback.
- Store orchestration in `src/store/features/store.ts`:
  - Transactions are managed in store layer (`createTransactionManager`) rather than reducer.
  - Background reconciliation uses `requestIdleCallback` with fallback to `setTimeout`.
- Read path separation:
  - `query.*`: intended O(1)/O(log n)/bounded linear selectors.
  - `scan.*`: full traversal O(n) operations.
- Rendering and conversion utilities in `src/store/features/rendering.ts` bridge byte-based storage and user-facing line/column or char-offset behavior.

## 4. Specific contexts and usages
- Context: normal editing throughput.
  - Lazy line index defers downstream offset reconciliation, prioritizing edit responsiveness.
- Context: correctness-sensitive operations.
  - Undo/redo forces eager line-index reconciliation before replay.
  - `setViewport` reconciles visible ranges first, then defers remaining work.
- Context: mixed line endings and Unicode.
  - Core logic explicitly handles LF/CR/CRLF and includes randomized mixed-ending tests.
  - UTF-8 byte vs UTF-16 char conversions are present across piece table and rendering APIs.
- Context: collaboration-like updates.
  - `APPLY_REMOTE` mutates content/line index without writing to local history.

## 5. Pitfalls (status as of 2026-02-24)
- Runtime guard mismatch for history clear: resolved.
  - `isDocumentAction` now accepts `HISTORY_CLEAR`.
  - Reference: `src/types/actions.ts`.
- Batch semantics mismatch: resolved by contract alignment.
  - Behavior remains per-action history entries; comments/tests now match this behavior.
  - Reference: `src/store/features/store.ts`, `src/types/store.ts`, `src/store/features/store.usecase.test.ts`.
- Reconciliation scheduling gap on transaction commit: resolved.
  - Outermost `TRANSACTION_COMMIT` now schedules background reconciliation when `rebuildPending` is true.
  - Reference: `src/store/features/store.ts`.
- Event contract mismatch for remote changes: resolved.
  - `createDocumentStoreWithEvents` now emits `content-change` for `APPLY_REMOTE`.
  - Reference: `src/store/features/store.ts`, `src/store/features/events.ts`.
- Metadata/event ambiguity for remote changes: resolved.
  - `APPLY_REMOTE` now marks document dirty on actual remote content mutation; no-op remote payloads return unchanged state.
  - Reference: `src/store/features/reducer.ts`.

## 6. Improvement points 1 (design overview)
- Make behavior contracts executable:
  - Completed: comments/tests now match batch history behavior (multi-entry).
  - Completed: remote event semantics (`content-change`) and dirty semantics are now explicit in implementation/tests.
- Tighten reconciliation lifecycle:
  - Completed: commit path schedules reconciliation when pending.
- Clarify collaboration policy:
  - Completed (current policy): remote content changes are first-class content changes, set dirty state, and do not push local undo history.
- Add a concise invariant document for core structures:
  - Piece table subtree fields, line index mode guarantees, reconciliation invariants.

## 7. Improvement points 2 (types/interfaces)
- Fix runtime action guard consistency:
  - Completed: `HISTORY_CLEAR` is included in `isDocumentAction`.
- Consider stricter remote change typing:
  - Separate `length` into branded byte length to reduce accidental unit misuse.
- Strengthen event typing around remote mutations:
  - Partially completed: remote content changes are treated as first-class in dispatch/event behavior; event payload types remain generic `DocumentAction`.
- Consider action schema-centric validation:
  - Reduce divergence between union definition, type guards, and validation logic.

## 8. Improvement points 3 (implementations)
- Implementation fixes:
  - Completed: added `HISTORY_CLEAR` branch to `isDocumentAction`.
  - Completed: schedule reconciliation after outermost `TRANSACTION_COMMIT` when pending.
  - Completed: updated `emitEventsForAction` to include `APPLY_REMOTE` content-change.
  - Completed: reconciled store/type/docs comments vs observed batch history behavior.
  - Completed: remote apply path now marks dirty on actual mutation and no-ops on empty remote payloads.
- Regression tests to add:
  - Added: `isDocumentAction({ type: 'HISTORY_CLEAR' }) === true`.
  - Added/updated: batch semantics test now explicitly validates per-action history behavior.
  - Added: transaction commit path test that verifies reconciliation scheduling when `rebuildPending`.
  - Added: event-store tests for `APPLY_REMOTE` `content-change` and dirty-change behavior.
- Performance confidence:
  - Add benchmark harness for large doc edits, mixed line endings, and reconciliation thresholds.

## 9. Learning paths on implementations (entries and goals)
- Path A: API consumer to internal state flow
  - Entry: `src/index.ts`, `src/store/features/actions.ts`, `src/store/features/store.ts`
  - Goal: understand how public actions become immutable state snapshots.
- Path B: text editing core
  - Entry: `src/store/features/reducer.ts` -> `src/store/core/piece-table.ts`
  - Goal: understand insert/delete/replace behavior and history recording.
- Path C: line indexing and reconciliation
  - Entry: `src/store/core/line-index.ts`
  - Goal: understand eager vs lazy modes, dirty ranges, and viewport/full reconciliation.
- Path D: byte/char correctness and rendering adapters
  - Entry: `src/store/features/rendering.ts`, `src/store/core/piece-table.ts`
  - Goal: understand how byte offsets are mapped to user-visible line/column and char offsets.
- Path E: reliability harness
  - Entry: `src/store/features/store.usecase.test.ts`, `src/store/core/line-index.test.ts`
  - Goal: follow randomized and edge-case tests to reason about invariants.

## Reliability snapshot
- Overall reliability: good for core editing behavior, line-ending edge cases, immutable transition logic, and event/store contract alignment.
- Confidence basis:
  - Broad tests across core/features with `495` passing tests.
  - Randomized reconciliation tests for mixed line endings, Unicode, and remote changes.
- Main risks:
  - Core complexity remains high (piece table + lazy/eager line index); invariant drift risk remains without dedicated invariant docs/benchmarks.

---

# Report 2: 2026-02-26 — Code Analysis & Formalization

**Version:** 0.0.0
**Lines of Source:** ~2,554 TypeScript
**Tests:** 502 passing across 12 test files

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
| Bulk replace (common) | `setValue(state, text)` | Single optimized REPLACE action — O(n) |
| Bulk replace (minimal diff) | `setValueWithDiff(state, text)` | Myers diff → minimal edit actions — O(n²) |
| Viewport rendering | `query.getVisibleLines(state, start, end)` | Needs reconciled (eager) line index |
| Remote collaboration | `DocumentActions.applyRemote(changes)` | No history push, lazy line index |
| Background work | `store.scheduleReconciliation()` | `requestIdleCallback` fills null offsets |
| Streaming large files | `scan.getValueStream(state)` | Generator; O(n) allocation deferred to iteration |

---

### 5. Pitfalls

1. ~~**Silent fallback in lazy mode rendering.** `getLineContent()` returns an empty string when the line's offset is not yet computed. There is no warning or error; callers see blank content.~~ **Fixed.** Return type changed to `string | null`; out-of-range lookups now return `null`, making "line does not exist" distinguishable from "line exists with no content" (`''`).

2. **`primaryIndex` is unconstrained.** `SelectionState.primaryIndex` can exceed `ranges.length` with no type protection. `ranges[primaryIndex]` fails silently.

3. **Cost labels are phantom.** `LinearCost<T>`, `LogCost<T>`, etc. carry no runtime enforcement. A function returning `O(1)` cost may perform O(n) work; the type system will not catch it. *Partially addressed:* over-labeling of the `setValue()` common path has been resolved by splitting the API (see §4 §4.6 fix); internal trivial-branch labels in `diff()`, `rendering.ts`, and `line-index.ts` have also been corrected. The structural issue — no runtime enforcement — remains.

4. **Branded type constructors accept invalid values.** `byteOffset(-1)`, `byteOffset(NaN)`, `byteOffset(Infinity)` all compile. The `isValidOffset()` utility is not called automatically.

5. **Tree path ordering is implicit.** `bstInsert()` builds a path that is then `.reverse()`d. This ordering dependency is undocumented; if the traversal order changes, balancing silently breaks.

6. **`Number.MAX_SAFE_INTEGER` as a sentinel.** `DirtyLineRange.endLine` uses this magic constant to mean "to end of document". No type alias or constant enforces this; any integer would pass the type check.

7. **History coalescing mixes byte / char boundaries.** The contiguity check (`newChange.position === last.position + last.byteLength`) uses byte counts from UTF-8 encoding. If an editor layer uses character (UTF-16) positions, edits that feel adjacent may fail to coalesce.

8. **Generator cost deferral is invisible.** `getValueStream()` calls `collectPieces()` only during iteration, not at call time. The O(n) allocation occurs invisibly when the consumer first pulls from the generator.

---

### 6. Improvement Points — Design Overview

1. ~~**Mode propagation through the public API is implicit.** Functions in `query.*` accept `DocumentState` (union mode) without communicating whether the line index is reconciled. A caller cannot safely use `getLineRange()` without checking reconciliation state first.~~ **Fixed.** `src/api/query.ts` now exposes explicit mode contracts: `query.isReconciledState`, `query.assertReconciledState`, eager-only `query.getLineRange`, checked `query.getLineRangeChecked`, lazy-safe `query.getLineRangePrecise`, and a low-level `query.lineIndex.*` escape hatch for direct line-index access.

2. ~~**No version-gating at mode transitions.** When `reconcileNow()` returns a `DocumentState<'eager'>`, there is no mechanism to ensure stale `DocumentState<'lazy'>` snapshots held by consumers are invalidated.~~ **Fixed.** Store snapshots can now be validated via `isCurrentSnapshot(snapshot)`, and `reconcileNow(snapshot)` is snapshot-gated (returns `null` for stale snapshots).

3. **Chunk loading is a stub.** The `LOAD_CHUNK` / `EVICT_CHUNK` action handlers are not implemented. The `DocumentState` already holds `metadata` for these, creating a false impression of readiness.

4. ~~**Event delivery is not transactional.** If a listener throws midway through `notifyListeners()`, the state change has persisted but some listeners never received the event. There is no recovery path.~~ **Fixed.** Both store listeners and typed event handlers now iterate over a snapshot array, guaranteeing delivery to all subscribers registered at emit/notify start even when listeners unsubscribe or throw during delivery.

5. ~~**Reconciliation is never triggered by `batch()`.** After a batch of actions that sets `rebuildPending = true`, reconciliation must be scheduled manually.~~ **Fixed.** `batch()` now includes an explicit post-batch reconciliation scheduling safety check when `rebuildPending` remains true and no transaction is active.

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

4. ~~**Lazy diff cost contract overstates worst case.** `diff()` always returns `QuadCost` even though the Myers path for D-small inputs is O((n+m)D). The inflated cost label may cause callers to avoid the function for use cases where it would be inexpensive.~~ **Fixed.** See §4 §4.6.

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

#### ~~4.6 `diff()` / `setValue()` — Cost Label Overstates Worst Case~~ (Fixed)

~~The function always returns `QuadCost<DiffResult>` even for the Myers fast path, which is O((n+m)D) where D is edit distance. For near-identical texts with small D, the actual cost is closer to linear. The inflated annotation causes callers to treat the function as inherently expensive when it may not be.~~

**Root cause clarified:** `diff()` itself is correctly labeled `QuadCost` — its `simpleDiff` branch uses an O(n·m) DP table, so O(n²) worst case is genuine. The real over-labeling was in `setValue()`, which always returned `QuadCost` even though its default path (`useReplace: true`) delegates entirely to `computeSetValueActionsOptimized`, an O(n) linear scan.

**Fix applied (`diff.ts`):**
- `setValue(state, newContent)` now returns `LinearCost<DocumentState>`. The `options` parameter has been removed; the body always uses `computeSetValueActionsOptimized`.
- `setValueWithDiff(state, newContent)` is a new export returning `QuadCost<DocumentState>`, running the full Myers diff. Use when fine-grained history entries matter.
- `computeSetValueActionsFromState(pieceTable, newContent)` similarly narrowed to `LinearCost<DocumentAction[]>`.
- `computeSetValueActionsFromStateWithDiff(pieceTable, newContent)` added for the Myers path (`QuadCost<DocumentAction[]>`).
- Internal trivial-branch labels inside `diff()` corrected: the identical-strings branch now lifts at `'O(n)'` (a string comparison that already happened), and the empty-input branches lift at `'O(1)'`; all are still widened to `QuadCost` at the function boundary via `$proveCtx`.
- Same internal-label corrections applied to null/bounds early-return branches in `rendering.ts` (`getLineContent`, `getVisibleLine`, `estimateTotalHeight`) and `line-index.ts` (`getLineStartOffset`, `getCharStartOffset`).

`SetValueOptions` is retained as a deprecated exported type for any callers that reference it by name.

#### ~~4.7 `getLineContent()` — Silent Empty Return on Stale Offset~~ (Fixed)

~~When the line index is in lazy mode and the target line's offset is not yet computed, `getLineRangePrecise()` returns `null`. The fallback is `getText(state.pieceTable, byteOffset(0), byteOffset(0))`, which returns an empty string. There is no warning, error, or distinct return value that distinguishes "line is empty" from "line offset is stale."~~

**Correction on root cause:** `getLineRangePrecise()` returns `null` only when the line number is out of range — it uses `subtreeByteLength` aggregates, which are maintained in both eager and lazy modes, so stale `documentOffset` values do not cause a `null` return. The actual bug was that `null` (out of range) and `''` (empty line) were conflated via the zero-range `getText` fallback.

**Fix applied (`rendering.ts`):** Return type widened to `CostFn<'linear', [DocumentState, number], string | null>`. The `null` branch now lifts `null` directly within the cost algebra instead of calling `getText`. Semantics: `null` = line number out of range; `''` = line exists with no content (e.g. bare newline or empty document's single line 0). Tests updated accordingly.

---

## Summary (2026-02-26)

**Reed** is architecturally coherent: immutable trees, a clean reducer pipeline, parameterized evaluation modes, and nominal type branding demonstrate deliberate design. The issues identified fall into three recurring themes:

1. **Phantom enforcement.** Cost labels, branded type constructors, and lazy mode typing all promise constraints that runtime or compile-time checks do not actually verify. Invariants that should be structural are expressed only in documentation.

2. **Implicit ordering and context dependencies.** R-B tree path ordering, `splitPiece` leaf assumptions, and the `Number.MAX_SAFE_INTEGER` sentinel are conventions that exist outside the type system. They will be bypassed or misunderstood as the codebase grows.

3. **Boundary checks still rely on conventions in several areas.** Mode transitions and listener delivery are now guarded, but other boundary semantics (sentinel values, implicit tree assumptions, byte/char boundary coupling) still depend on discipline more than enforcement.

---

# Report 3: 2026-03-01 — Reconciliation Implementations

**Revised:** 2026-03-02 — P1, P2, P3, P6, Impl1, Impl4 fixed; P4, D1, D3, T3, Impl2 fixed (second pass)
**Scope:** Lazy/eager line index reconciliation system

---

## 1. Code Organization and Structure

The reconciliation system is spread across five layers with clear separation of concerns:

| Layer | Files | Responsibility |
|---|---|---|
| **Type** | `src/types/state.ts`, `src/types/store.ts` | Phantom-type contracts (`EvaluationMode`, `LineIndexState<M>`, `DirtyLineRange`, `ReconcilableDocumentStore`) |
| **Core** | `src/store/core/line-index.ts` | All lazy/eager ops, dirty range management, `reconcileFull`, `reconcileRange`, `reconcileViewport`, `reconcileInPlace`, `assertEagerOffsets` |
| **State factory** | `src/store/core/state.ts` | `asEagerLineIndex` runtime narrowing, `withLineIndexState` structural sharing helper |
| **Reducer** | `src/store/features/reducer.ts` | `applyEdit`, undo/redo pre-reconciliation via `reconcileFull`; calls `liInsert`/`liDelete`/`liInsertLazy`/`liDeleteLazy` directly |
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

DirtyLineRange { startLine, endLine, offsetDelta, isSentinel? }

DocumentState<M> { lineIndex: LineIndexState<M>, ... }
```

The conditional types on `dirtyRanges` and `rebuildPending` enforce **at compile time** that `'eager'` state has no dirty ranges — the key invariant. The `liInsert`/`liDelete` (eager) and `liInsertLazy`/`liDeleteLazy` (lazy) functions operate on their respective modes and cannot be mixed.

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
    → liInsertLazy / liDeleteLazy
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
    → liInsert / liDelete
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

**Background idle reconciliation** uses `requestIdleCallback` with a 1-second timeout, or `setTimeout(200ms)` fallback. It deliberately does **not** notify listeners and does not bump `state.version` — reconciliation is an invisible internal optimization.

---

## 5. Pitfalls

**P1 — ~~`mergeDirtyRanges` merges overlapping ranges with unequal deltas incorrectly when `startLine` values differ.~~ (Fixed 2026-03-02)**

~~When two ranges overlap (`next.startLine > current.startLine`) with different `offsetDelta`, the code pushes `current` and sets `current = next`. The overlap region from `next.startLine` to `current.endLine` then has only `next.offsetDelta` applied instead of the combined delta. Lines in that overlap will be under-corrected during reconciliation.~~

The merge loop was rewritten as a `while` loop. Overlapping ranges with `s1 < s2` and different deltas are now decomposed into up to three non-overlapping sub-ranges: `[s1, s2-1, d1]`, `[s2, min(e1,e2), d1+d2]`, and the tail (if any).
(`src/store/core/line-index.ts`)

**P2 — ~~The collapsed-cap sentinel `{startLine:0, endLine:MAX_SAFE_INT, delta:0}` is indistinguishable from a legitimate full-document zero-delta range.~~ (Fixed 2026-03-02)**

~~`reconcileFull` detects it by shape (`line-index.ts:1943–1947`). A net-zero edit sequence (insert then delete same range) could naturally produce the same shape, causing the slow path (`reconcileInPlace`) to always be selected even when incremental would be correct.~~

`DirtyLineRange` now carries an optional `isSentinel?: true` field. `mergeDirtyRanges` sets it on the cap sentinel; `reconcileFull` uses `range.isSentinel === true` instead of shape-matching.
(`src/types/state.ts`, `src/store/core/line-index.ts`)

**P3 — ~~`DirtyLineRange.createdAtVersion` is tracked but never read in any reconciliation logic.~~ (Fixed 2026-03-02)**

~~The field is created, merged (taking `max`), and stored in state, but no code path uses it to skip or prioritize ranges. It is effectively dead data in the current implementation.~~

`createdAtVersion` was removed from `DirtyLineRange` and all creation/merge sites. See also T2.
(`src/types/state.ts`, `src/store/core/line-index.ts`)

**P4 — ~~`asEagerLineIndex` narrows via a structural check, not an offset correctness check.~~ (Fixed 2026-03-02)**

~~If `reconcileInPlace` had a bug in offset accumulation, `toEagerLineIndexState` would still pass the check and return a `LineIndexState<'eager'>` with incorrect `documentOffset` values — corrupting all downstream line lookups silently.~~

`assertEagerOffsets(state, sampleSize?)` debug helper added to `line-index.ts`. It samples `sampleSize` line nodes at even intervals, computes the expected `documentOffset` via `getLineStartOffset`, and throws if any mismatch is found. Intended for tests and dev builds; not called on production paths.
(`src/store/core/line-index.ts`)

**P5 — `deleteLineRangeLazy` still calls `rebuildWithDeletedRange` (an O(n) tree rebuild) even in lazy mode. (Acknowledged — not fixing)**

For multi-line deletions, the structural tree rebuild cannot be deferred because the resulting tree shape changes. This means lazy delete with newlines has the same O(n) cost as eager delete, negating the lazy optimization for this case.
(`src/store/core/line-index.ts`)

Not fixing: the Red-Black tree must be rebalanced after removing each line node (O(log n) per deleted line). "Lazy" defers only offset recalculation, not structural rebalancing. The current approach is correct.

**P6 — ~~`scheduleReconciliation`'s `setTimeout(16ms)` fallback runs at near-frame-rate frequency in non-browser environments.~~ (Fixed 2026-03-02)**

~~In Node.js (no `requestIdleCallback`), every edit with newlines schedules a 16ms timeout. For high-throughput batch edits, this creates a continuous storm of 16ms-interval reconciliations regardless of system load.~~

Fallback delay changed from 16ms to 200ms.
(`src/store/features/store.ts`)

---

## 6. Improvement Points — Design Overview

**D1: ~~The eager/lazy duality at the `LineIndexStrategy` level is over-engineered for two concrete implementations.~~ (Fixed 2026-03-02)**

~~`eagerLineIndex` and `lazyLineIndex` are the only two instances and they are not user-extensible. The interface adds indirection without extensibility value. The two implementation paths could be plain conditional branches in the reducer.~~

`LineIndexStrategy<M>` interface removed from `src/types/store.ts`. `eagerLineIndex` and `lazyLineIndex` strategy objects removed from `src/store/features/reducer.ts`. The 8 dispatch call sites in `applyEdit`, `applyChange`, and `APPLY_REMOTE` now call `liInsert`, `liDelete`, `liInsertLazy`, `liDeleteLazy` directly.
(`src/types/store.ts`, `src/store/features/reducer.ts`)

**D2: ~~Viewport reconciliation does not track that the viewport window has already been reconciled.~~ (Non-issue)**

~~After `setViewport(0, 50)`, the dirty ranges for lines 0–50 are removed. But `lineIndex.rebuildPending` remains `true` (off-screen dirty ranges still exist), and `scheduleReconciliation` is called again. There is no mechanism to skip re-reconciling the viewport on the next background pass.~~

`reconcileRange` removes the reconciled dirty ranges from `state.dirtyRanges`. The subsequent background pass only processes the remaining (off-screen) ranges. Viewport lines are not re-reconciled.

**D3: ~~The reconciliation threshold function `defaultThresholdFn` is not adaptive to document structure.~~ (Fixed 2026-03-02)**

~~It scales by `lineCount / log2(lineCount)` — roughly O(n/log n) dirty lines trigger the slow path. The threshold does not account for whether the dirty ranges are contiguous (cheap to reconcile incrementally) or scattered (expensive).~~

With Impl1 making `reconcileRange` O(K+V), the incremental path total across K ≤ 32 ranges is O(K² + totalDirty) ≈ O(1024 + totalDirty). Incremental beats O(n) whenever `totalDirty ≤ n − 1024 ≈ 0.75n`. `defaultThresholdFn` updated to `max(256, floor(lineCount × 0.75))`.
(`src/store/core/line-index.ts`)

---

## 7. Improvement Points — Types & Interfaces

**T1: `LineIndexNode<M>` propagates the phantom type through the entire tree, making node-level functions verbose. (Acknowledged — not fixing)**

All tree operations must carry `<M extends EvaluationMode>`. Since `M` only affects `documentOffset` nullability, keeping nodes unparameterized and parameterizing only `LineIndexState<M>` would simplify type signatures significantly.

Not fixing: removing the phantom from `LineIndexNode` would weaken the type system — `documentOffset` would always be `number | null`, and `getLineRangePrecise` overloads that currently guarantee non-null offsets in eager mode would lose that guarantee.

**T2: ~~`DirtyLineRange.createdAtVersion` should either be used or removed.~~ (Fixed 2026-03-02 — see P3)**

~~If intended for future use (e.g., per-range reconciliation priority), this should be documented with the intended semantic. If unused, it should be removed to avoid confusion.~~

Field removed. `DirtyLineRange` now carries `isSentinel?: true` instead (see P2).

**T3: ~~`getLineRange` and `getLineRangeChecked` expose the same semantic but with different type contracts.~~ (Fixed 2026-03-02)**

~~`getLineRange` requires `LineIndexState<'eager'>` at compile time; `getLineRangeChecked` accepts any state and calls `asEagerLineIndex` at runtime. There is no third option for "reconcile on demand if needed," which creates API confusion for consumers.~~

Extended JSDoc on all three functions (`getLineRange`, `getLineRangeChecked`, `getLineRangePrecise`) with a decision guide:
- `getLineRange` — compile-time safe; caller has already guaranteed eager state (e.g. post-`reconcileNow`, undo/redo result)
- `getLineRangeChecked` — runtime-checked; accepts any state, throws via `asEagerLineIndex` if precondition violated
- `getLineRangePrecise` — best-effort; returns `null` for unresolved offsets; no reconciliation overhead
- Note: "reconcile on demand" requires calling `store.reconcileNow()` first
(`src/api/query.ts`)

---

## 8. Improvement Points — Implementations

**Impl1: ~~`reconcileRange` applies `getOffsetDeltaForLine` (O(k)) per line in a loop of `(endLine - startLine)` lines.~~ (Fixed 2026-03-02)**

~~For a viewport of V lines with K dirty ranges, this is O(V × K). A single pass over dirty ranges to build a prefix-sum array, then O(1) delta lookup per line, would reduce this to O(K + V).~~

`reconcileRange` now builds sweep-line events from the sorted dirty ranges (O(K)), then sweeps `[clampedStart, clampedEnd]` with a running cumulative delta (O(K + V) total). `getOffsetDeltaForLine` is retained as a public utility but no longer called in the hot path.
(`src/store/core/line-index.ts`)

**Impl2: ~~`mergeDirtyRanges` sorts on every call (O(k log k)), even when ranges are appended in order.~~ (Fixed 2026-03-02)**

~~Since `createDirtyRange` always uses `Number.MAX_SAFE_INTEGER` as `endLine` and ranges are appended sequentially, ranges are nearly always already sorted by `startLine`. An insertion-order assumption with a fallback sort would be faster in practice.~~

`mergeDirtyRanges` now performs an O(K) scan for existing sort order before sorting. If ranges are already ordered (the common case), the sort is skipped entirely.
(`src/store/core/line-index.ts`)

**Impl3: `reconcileInPlace` visits all nodes even when they already have correct offsets. (Acknowledged — not fixing)**

The short-circuit `node.documentOffset !== correctOffset` avoids node allocation but not subtree traversal. A subtree-level correctness flag (analogous to `rebuildPending` at the state level) would allow pruning entire subtrees known to be clean.

Not fixing: a subtree-level flag requires coordinated invalidation across every lazy tree mutation (`insertLinesAtPositionLazy`, `rbDeleteLineByNumber`, rotations). With Impl1 done, `reconcileInPlace` is already the last resort and runs infrequently — the complexity cost outweighs the benefit.

**Impl4: ~~`reconcileNow` and the background `scheduleReconciliation` callback both increment `state.version + 1`.~~ (Partially fixed 2026-03-02)**

~~Both produce a version bump for what is semantically the same state mutation (reconciling dirty ranges). Callers comparing versions would see unexpected increments. Reconciliation could be treated as version-neutral since it does not change visible content.~~

The background `scheduleReconciliation` callback now passes `state.version` (not `state.version + 1`) to `reconcileFull` and omits the version increment from `setState`. `reconcileNow` continues to increment the version — it is a user-visible synchronous operation that undo/redo depends on.
(`src/store/features/store.ts`)

---

## 9. Learning Paths

**Path 1 — Phantom type invariants (data model)**
1. `src/types/state.ts` — `EvaluationMode`, `LineIndexState<M>`, `DirtyLineRange`, `LineIndexNode<M>`
2. `src/store/core/state.ts` — `asEagerLineIndex`, `withLineIndexState`, `createEmptyLineIndexState`
3. **Goal:** understand how conditional types on `dirtyRanges` and `rebuildPending` enforce the eager/lazy invariant at compile time

**Path 2 — Lazy mutation tracking**
1. `src/store/features/reducer.ts` — `applyEdit`, calls to `liInsertLazy` / `liDeleteLazy`
2. `src/store/core/line-index.ts` — `lineIndexInsertLazy`, `insertLinesAtPositionLazy`, `deleteLineRangeLazy`
3. `src/store/core/line-index.ts` — `mergeDirtyRanges`, `createDirtyRange`
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

---

# Report 4: 2026-03-01 — Transaction and Batch Implementations

**Updated:** 2026-03-02 — 14 issues resolved (P1, P2/D2, P4, P5\*, T1, T3, Impl1, D1, D3, D4, Impl3, Impl5, Impl2, Impl4)
**Updated:** 2026-03-07 — P6 fixed; T2 fixed (`LoadChunkAction.data` → `ReadonlyUint8Array`)
**Scope:** Transaction management, batch dispatch, and their integration with the store and event system

---

## 1. Code Organization and Structure

The transaction and batch systems are composed across four distinct layers:

| Layer | Files | Responsibility |
|---|---|---|
| **Action types** | `src/types/actions.ts` | `TransactionStartAction`, `TransactionCommitAction`, `TransactionRollbackAction`; type guard `isTransactionAction`; `validateAction` for all action types |
| **Action creators** | `src/store/features/actions.ts` | `DocumentActions.transactionStart/Commit/Rollback()`, `serializeAction`, `deserializeAction` |
| **Transaction manager** | `src/store/features/transaction.ts` | `TransactionManager` interface, `createTransactionManager` factory — depth tracking, snapshot stack, pending actions, `emergencyReset` |
| **Store integration** | `src/store/features/store.ts` | `dispatch` (intercepts transaction actions), `batch` in both `createDocumentStore` and `createDocumentStoreWithEvents` |

The reducer (`src/store/features/reducer.ts`) treats all three transaction action types as no-ops — they return `state` unchanged. All transaction coordination is entirely in the store layer, not in the reducer.

---

## 2. Relations of Implementations — Types & Interfaces

```
DocumentAction (union)
  ├─ TransactionStartAction    { type: 'TRANSACTION_START' }
  ├─ TransactionCommitAction   { type: 'TRANSACTION_COMMIT' }
  └─ TransactionRollbackAction { type: 'TRANSACTION_ROLLBACK' }

CommitResult {                         // returned by commit()
  kind: 'commit'
  isOutermost: boolean
  pendingActions: readonly DocumentAction[]
}

RollbackResult {                       // returned by rollback()
  kind: 'rollback'
  isOutermost: boolean
  snapshot: DocumentState | null
}

TransactionResult = CommitResult | RollbackResult   // discriminated union

TransactionManager {
  begin(currentState): void
  commit(): CommitResult
  rollback(): RollbackResult
  trackAction(action): void       // no-op when depth === 0
  readonly depth: number
  readonly isActive: boolean
  readonly pendingActions: readonly DocumentAction[]
  emergencyReset(): DocumentState | null
}
```

`DocumentStore.batch` is defined on the base interface accepting `readonly DocumentAction[]`. `ReconcilableDocumentStore` inherits it unchanged and additionally exposes `emergencyReset()`. `DocumentStoreWithEvents` overrides `batch` to emit per-action events with intermediate states.

---

## 3. Relations of Implementations — Functions

**`batch` (base store) call graph:**
```
createDocumentStore.batch(actions)
  → dispatch({ type: 'TRANSACTION_START' })
      → transaction.begin(state)
  → for each action:
      dispatch(action)
        → documentReducer(state, action)     // mutates state
        → transaction.trackAction(action)
        // listeners NOT notified (transaction.isActive)
  → dispatch({ type: 'TRANSACTION_COMMIT' })
      → transaction.commit()
        → returns { kind: 'commit', isOutermost: true, pendingActions: [...] }
      → notifyListeners()                    // single notification
      → if rebuildPending: scheduleReconciliation()
  // on exception:
  → dispatch({ type: 'TRANSACTION_ROLLBACK' })
      → transaction.rollback()
        → returns { kind: 'rollback', snapshot, isOutermost: true }
      → setState(snapshot)
      → notifyListeners()                    // only on isOutermost
  // if rollback itself throws:
  → emergencyReset()
      → transaction.emergencyReset()
      → setState(earliest snapshot)
      → notifyListeners()
```

**`batch` (events store) call graph:**
```
createDocumentStoreWithEvents.batch(actions)
  → baseStore.dispatch({ type: 'TRANSACTION_START' })
  → for each action:
      dispatch(action)                       // ENHANCED dispatch
        → baseStore.dispatch(action)         // mutates state
        → emitEventsForAction(prevState, nextState)  // events fire per-action
  → baseStore.dispatch({ type: 'TRANSACTION_COMMIT' })
      → notifyListeners()  (single)
      → if rebuildPending: scheduleReconciliation()
  // on exception:
  → try: baseStore.dispatch({ type: 'TRANSACTION_ROLLBACK' })
  // if rollback dispatch throws:
  → baseStore.emergencyReset()              // parity with base store
```

**Manual transaction protocol (via `dispatch`):**
```
dispatch(TRANSACTION_START)    → transaction.begin(state)
dispatch(any action)           → reducer runs; trackAction; no listener notify
dispatch(TRANSACTION_COMMIT)   → transaction.commit(); notifyListeners once (outermost)
dispatch(TRANSACTION_ROLLBACK) → transaction.rollback(); setState(snapshot);
                                  notifyListeners only when isOutermost
```

---

## 4. Specific Contexts and Usages

**Notification batching:** The primary purpose of `batch` / transactions is collapsing N dispatch-notifications into one. Each action still runs through the reducer independently and produces its own history entry.

**History behavior:** `batch` does NOT create a single compound history entry. Three inserts batched together create three separate undo entries (as confirmed by the test at `store.usecase.test.ts:285`). This is intentional and documented, but may surprise callers expecting Redux-style batching.

**Nested transactions:** `TRANSACTION_START` is nestable. Inner commits and inner rollbacks are silent (no notification). Only the outermost commit/rollback notifies listeners. This allows library code to wrap operations in a transaction without worrying about nesting with caller-provided transactions.

**Reconciliation scheduling:** `scheduleReconciliation` is called on outermost commit (inside `TRANSACTION_COMMIT` dispatch) when `rebuildPending` is true. Inside an active transaction, `scheduleReconciliation` is intentionally skipped — dirty line ranges accumulate and are scheduled only once at the boundary.

**`emergencyReset`:** Exposed on `ReconcilableDocumentStore` and `DocumentStoreWithEvents`. Called when a `TRANSACTION_ROLLBACK` dispatch itself throws (extremely rare). Invokes `transaction.emergencyReset()` to clear all transaction state, restores the earliest (outermost) snapshot, and notifies listeners. Both `batch` implementations now call this fallback with equal resilience.

**`pendingActions` accumulation:** `trackAction` accumulates all actions dispatched inside an active transaction into a single flat array (calls at depth 0 are now silently ignored). The array is exposed on `CommitResult.pendingActions` at outermost commit but is **not currently used** by any caller — it is available for external consumers who construct transactions manually and want to replay or audit the action log.

---

## 5. Pitfalls

**~~P1~~ — ~~`pendingActions` on `CommitResult` are accumulated and returned but never consumed internally.~~**
**Fixed (2026-03-02)** as part of D3. See D3 below.

**~~P2~~ — ~~`createDocumentStoreWithEvents.batch` has no `emergencyReset` fallback when rollback fails.~~**
**Fixed (2026-03-02).** Events store `batch` now wraps the rollback dispatch in a nested try/catch and calls `baseStore.emergencyReset()` on failure, matching the resilience of the base store. `emergencyReset` is exposed on `ReconcilableDocumentStore` and passed through on the events store return object.

**P3 — Inner rollback only restores the snapshot passed to the matching `begin`, not the outermost state.**

```ts
// Outer begin with stateA
dispatch(TRANSACTION_START)   // begin(stateA), depth=1
dispatch(INSERT 'X')          // state now stateA+X
// Inner begin with stateA+X
dispatch(TRANSACTION_START)   // begin(stateA+X), depth=2
dispatch(INSERT 'Y')          // state now stateA+X+Y
dispatch(TRANSACTION_ROLLBACK) // rollback → restores stateA+X, depth=1
// stateA+X remains — inner rollback does NOT undo outer changes
dispatch(TRANSACTION_COMMIT)   // commits stateA+X, notifies
```

This is correct semantically but is a common source of confusion: inner rollback does not provide full abort semantics unless the outer transaction also rolls back.

**~~P4~~ — ~~`trackAction` outside a transaction silently accumulates actions in `pending`.~~**
**Fixed (2026-03-02).** `trackAction` now returns early when `depth === 0`. Calling it outside a transaction is a safe no-op.

**~~P5~~ — ~~`dispatch(TRANSACTION_ROLLBACK)` unconditionally calls `notifyListeners()`, including for inner rollbacks.~~**
**Fixed (2026-03-02).** `notifyListeners()` in the rollback path is now guarded by `result.isOutermost`. Inner rollbacks restore the snapshot but do not notify listeners, preserving the notification-suppression contract for the duration of the outer transaction.

*Note: the related concern — outermost rollback notifying when state is unchanged — is not addressed. Listeners still cannot distinguish "state changed" from "state was rolled back to what it already was."*

**~~P6~~ — ~~`snapshotStack` in `TransactionManager` stores full `DocumentState` references per nesting level.~~ (Fixed 2026-03-07)**

~~For deeply nested transactions with large documents, the snapshot stack can hold many references to immutable-but-still-referenced state trees. Structural sharing in the piece table limits memory impact, but the line index and history stacks are duplicated across snapshots per nesting level.~~

`HistoryState.undoStack` and `redoStack` are now `PStack<HistoryEntry>` — a persistent singly-linked stack defined in `src/types/state.ts`. Each push creates a new cons node pointing to the previous tail; all snapshot levels sharing history entries up to their `begin()` point share those nodes automatically. Snapshot overhead for history drops from O(K × H) pointer slots to O(K) cons-node allocations. The piece table and line index already use structural sharing; history is now consistent with that pattern.
(`src/types/state.ts`, `src/store/features/reducer.ts`, `src/store/features/history.ts`, `src/store/core/state.ts`)

---

## 6. Improvement Points — Design Overview

**~~D1~~ — ~~`batch` and manual `TRANSACTION_START/COMMIT/ROLLBACK` dispatch provide two separate APIs for the same mechanism, with different guarantees.~~**
**Fixed (2026-03-02).** `withTransaction<T>(store, fn)` is now exported from `src/store/features/store.ts` and `src/api/store.ts`. It wraps the callback in a transaction with the same error-handling resilience as `batch` (rollback → `emergencyReset` fallback) and returns the value produced by the callback. It nests correctly with existing transactions.

**~~D2~~ — ~~The events-aware `batch` deviates from the base `batch` in resilience.~~**
**Fixed (2026-03-02)** as part of P2. Both `batch` implementations now have equivalent error-handling with `emergencyReset` fallback.

**~~D3~~ — ~~`pendingActions` is a `TransactionManager` feature with no current consumer.~~**
**Fixed (2026-03-02).** `pending` array, `trackAction`, `pendingActions` getter, and `CommitResult.pendingActions` are all removed. The corresponding `transaction.trackAction(action)` call in `store.ts` `dispatch` is also removed. `CommitResult` now carries only `kind` and `isOutermost`. The `DocumentAction` import in `transaction.ts` is removed as it is no longer referenced.

**~~D4~~ — ~~Notification suppression during transactions is implicit, not explicit.~~**
**Fixed (2026-03-02).** The `dispatch` JSDoc now documents the notification contract explicitly: *"During an active transaction notifications are suppressed and delivered as a single call on outermost commit or outermost rollback."* The control-flow invariant is now expressed as a named guarantee rather than an implicit consequence of `transaction.isActive` checks.

---

## 7. Improvement Points — Types & Interfaces

**~~T1~~ — ~~`TransactionResult` carries three fields, but commit and rollback never use all three simultaneously.~~**
**Fixed (2026-03-02).** `TransactionResult` is now a discriminated union of `CommitResult` (`kind: 'commit'`, `isOutermost`, `pendingActions`) and `RollbackResult` (`kind: 'rollback'`, `isOutermost`, `snapshot`). `commit()` returns `CommitResult`; `rollback()` returns `RollbackResult`. The `kind` field enables exhaustive narrowing at call sites.

**~~T2~~ — ~~`TransactionManager.pendingActions` is a `readonly DocumentAction[]` getter, but its elements are mutable actions.~~**
**Fixed (2026-03-07).** `pendingActions` itself was removed by D3. The remaining live instance of the same class of issue was `LoadChunkAction.data: Uint8Array` — the field was `readonly` (preventing reference reassignment) but the buffer contents were mutable. `data` is now typed as `ReadonlyUint8Array` (defined in `src/types/branded.ts` as `Readonly<Uint8Array> & { readonly [index: number]: number }`), which blocks both named-method writes (`set`, `fill`, `copyWithin`, …) and indexed assignment (`data[0] = 5`) at the type level. Runtime behaviour is unchanged: all instances are still plain `Uint8Array` so `instanceof Uint8Array` checks and `new Uint8Array(action.data)` in `serializeAction` continue to work. The `loadChunk` action creator parameter type was updated to match. `ReadonlyUint8Array` is exported from `src/types/index.ts` alongside the other branded types.

**~~T3~~ — ~~`DocumentStore.batch` is typed as accepting `DocumentAction[]` (mutable array) rather than `readonly DocumentAction[]`.~~**
**Fixed (2026-03-02).** `DocumentStore.batch` and both store implementations now accept `readonly DocumentAction[]`. Callers with a `readonly` array no longer need to cast.

---

## 8. Improvement Points — Implementations

**~~Impl1~~ — ~~`createDocumentStore.batch` has a subtle double-scheduling opportunity.~~**
**Fixed (2026-03-02).** The redundant `scheduleReconciliation` check after the `finally` block has been removed. Reconciliation is scheduled once inside `dispatch(TRANSACTION_COMMIT)` when `rebuildPending` is true; the post-batch repeat was dead code.

**~~Impl2~~ — ~~`TRANSACTION_COMMIT` is placed inside the `try` block, so a COMMIT-throw causes the `finally` block to attempt `TRANSACTION_ROLLBACK` on a half-committed transaction.~~**
**Fixed (2026-03-02).** In all three sites — `createDocumentStore.batch`, `createDocumentStoreWithEvents.batch`, and `withTransaction` — `success = true` is now set immediately before `dispatch({ type: 'TRANSACTION_COMMIT' })`. If `TRANSACTION_COMMIT` throws (e.g. `assertInvariant` detects a `depth`/`snapshotStack` drift), `success` is already `true` so the `finally` block skips the rollback attempt. The error propagates cleanly rather than triggering a no-op rollback on state with `depth` already decremented and the snapshot already popped.
(`src/store/features/store.ts`)

**~~Impl3~~ — ~~No assertion to detect `snapshotStack`/`depth` drift.~~**
**Fixed (2026-03-02).** `createTransactionManager` now has a private `assertInvariant(op)` helper that throws if `snapshotStack.length !== depth`. It is called at the end of `begin`, `commit`, and `rollback`. Any future bug that causes a begin/commit/rollback imbalance will surface immediately with a descriptive error rather than silently corrupting state.

**~~Impl4~~ — ~~`createDocumentStore.batch` duplicates the `emergencyReset()` logic inline rather than calling the store's own function.~~**
**Fixed (2026-03-02).** The three-line inline block in `createDocumentStore.batch`'s rollback-failure catch (`transaction.emergencyReset()` + `setState` + `notifyListeners()`) is replaced with a single `emergencyReset()` call. The base store's `batch` now mirrors the events store, which already called `baseStore.emergencyReset()`. Future changes to the emergency recovery path only need to be applied once.
(`src/store/features/store.ts`)

**~~Impl5~~ — ~~No round-trip test for transaction action serialization.~~**
**Fixed (2026-03-02).** A new dedicated test file `src/store/features/actions.test.ts` covers `serializeAction` / `deserializeAction` for all 12 action types, including all three transaction actions, plus `LOAD_CHUNK` Uint8Array preservation, unicode text, and error cases (unknown type, invalid JSON, missing fields). The tests confirm that transaction actions serialize to plain `{ type }` JSON objects and round-trip without data loss.

---

## 9. Learning Paths

**Path 1 — Core transaction state machine**
1. `src/types/actions.ts:96–119` — `TransactionStartAction`, `TransactionCommitAction`, `TransactionRollbackAction`
2. `src/store/features/transaction.ts` — `TransactionManager`, `CommitResult`, `RollbackResult`, `createTransactionManager`, depth/snapshot/pending mechanics
3. `src/store/features/transaction.test.ts` — full test suite covering lifecycle, nesting, pending actions, emergency reset, `kind` discriminant
4. **Goal:** understand depth tracking, snapshot stack, `isOutermost` flag semantics, and the discriminated result types

**Path 2 — Store integration and notification suppression**
1. `src/store/features/store.ts:120–175` — `dispatch` function (with notification contract JSDoc), transaction intercept branches
2. `src/store/features/store.ts:178–213` — `batch` in base store (transaction wrapping, rollback, emergency reset)
3. `src/store/features/store.ts` (`withTransaction`) — high-level transaction helper consolidating the manual dispatch protocol
4. `src/store/features/store.usecase.test.ts:273–467` — integration tests for transactions, batching, and `withTransaction`
5. **Goal:** understand how notifications are suppressed during transactions (including inner rollbacks), how `batch` and `withTransaction` differ from manual `dispatch` sequences, and the notification suppression contract

**Path 3 — Events-aware batch divergence**
1. `src/store/features/store.ts:367–463` — `createDocumentStoreWithEvents`, enhanced `dispatch`, events-aware `batch`
2. `src/store/features/events.test.ts:328–355` — batch intermediate-state event test
3. **Goal:** understand why the events-aware `batch` emits per-action events with intermediate states, and how error handling now matches the base store

**Path 4 — Reconciliation interaction with transactions**
1. `src/store/features/store.ts:131–133` — reconciliation scheduling on outermost commit
2. `src/store/features/store.usecase.test.ts:352–383` — test: reconciliation scheduled only after outermost commit
3. **Goal:** understand why dirty line ranges are not reconciled mid-transaction and where scheduling occurs

**Path 5 — Action serialization and type guards**
1. `src/types/actions.ts:199–236` — `isTextEditAction`, `isHistoryAction`, `isTransactionAction`
2. `src/types/actions.ts:242–287` — `isDocumentAction` runtime validator
3. `src/store/features/actions.ts:141–170` — `serializeAction`, `deserializeAction`
4. **Goal:** understand the full action type system and the validation/serialization boundary for external action sources
