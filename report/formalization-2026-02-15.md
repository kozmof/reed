# Reed Formalization Analysis — Updated

**Date:** 2026-02-15
**Previous:** formalization-2026-02-14.md
**Cross-reference:** code-analysis-2026-02-14.md

---

## Resolution Summary

| Issue | Title | Status | Phase |
|-------|-------|--------|-------|
| 1.1 | LineIndexState construction scattered | **Resolved** | Phase 2a |
| 1.2 | `documentOffset: number \| 'pending'` | Deferred | — |
| 1.3 | HistoryChange overloads a single type | **Resolved** | Phase 1a |
| 1.4 | addBuffer mutable backing store | Deferred | — |
| 2.1 | `withPieceNode` accepts `Partial<PieceNode>` | **Resolved** | Phase 1b |
| 2.2 | LineIndexStrategy hides eager/lazy symmetry | Deferred | — |
| 2.3 | DocumentStore optional methods blur contract | **Resolved** | Phase 4a |
| 2.4 | Store events adapter `.bind()` no-op | **Resolved** | Phase 1c |
| 3.1 | INSERT/DELETE/REPLACE share unstated pipeline | **Resolved** | Phase 3a |
| 3.2 | applyChange/applyInverseChange duality | **Resolved** | Phase 2b |
| 3.3 | mergeTrees black-height imbalance | Deferred | — |
| 3.4 | reconcileFull hard-coded threshold | Deferred | — |
| 3.5 | History coalescing mixes policy/mechanism | Deferred | — |
| 4.1 | Redundant textEncoder.encode() | **Partially resolved** | Phase 3b |
| 4.2 | insertedByteLength computed indirectly | **Resolved** | Phase 3b |
| 4.3 | getLineContent double-calls byteOffset() | **Resolved** | Phase 1d |
| 4.4 | batch() replays reducer | **Resolved** | Phase 4b |
| 4.5 | deserializeAction has no validation | **Resolved** | Phase 1e |
| 4.6 | selectionToCharOffsets reads from byte 0 | Deferred | — |
| 4.7 | Eager/lazy line index parallel code paths | **Resolved** | Phase 3c |
| 4.8 | Empty-document sentinel inconsistency | Deferred | — |

**Resolved:** 13 of 21 issues
**Deferred:** 8 issues (tracked as TODO comments in source)

---

## 1. Data Structures

### 1.1 LineIndexState Construction Is Scattered — RESOLVED

`withLineIndexState(state, changes)` was added to `store/state.ts` and applied across 14 construction sites in `line-index.ts`. All inline `Object.freeze({ root, lineCount, ... })` patterns were replaced with the centralized helper, making variation points (which fields change per call site) explicit in the `changes` argument.

### 1.2 `documentOffset: number | 'pending'` — DEFERRED

Tracked as `TODO(formalization-1.2)` in `types/state.ts`. Changing to `number | null` would be more idiomatic but carries the same checking burden. A deeper fix (removing the union entirely by using only the dirty-range system for staleness) requires design work on the reconciliation contract.

### 1.3 `HistoryChange` Overloads a Single Type — RESOLVED

`HistoryChange` was split into three interfaces (`HistoryInsertChange`, `HistoryDeleteChange`, `HistoryReplaceChange`) in `types/state.ts`. `oldText` is now a required field only on `HistoryReplaceChange`. TypeScript narrows automatically in existing `switch` branches. All four `change.oldText ?? ''` patterns in `reducer.ts` were removed — the discriminated union makes them unnecessary.

**Cross-reference:** This also addresses code-analysis 7.2's observation about type constraint weakness, as the union is now structurally enforced.

### 1.4 `PieceTableState.addBuffer` Is a Mutable Backing Store — DEFERRED

Tracked as `TODO(formalization-1.4)` in `types/state.ts`. Recommendation: extract a `GrowableBuffer` class to encapsulate the append-only invariant. The current implicit boundary (`addBufferLength` in old snapshots) is correct but undocumented.

---

## 2. Interfaces

### 2.1 `withPieceNode` Accepts `Partial<PieceNode>` — RESOLVED

Introduced `PieceNodeUpdates = Partial<Pick<PieceNode, 'color' | 'left' | 'right' | 'bufferType' | 'start' | 'length'>>` in `store/state.ts`. `withPieceNode` now accepts this narrowed type, preventing callers from passing `subtreeLength` or `subtreeAddLength`. The same treatment was applied to `withLineIndexNode` via `LineIndexNodeUpdates`.

**Cross-reference:** Directly addresses code-analysis 7.2.

### 2.2 `LineIndexStrategy` Hides the Symmetry Between Eager and Lazy — DEFERRED

The Phase 3c deduplication (extracting `insertLinesStructural` and `appendLinesStructural`) partially addresses this by factoring out the shared structural logic with a `computeOffset` callback that parameterizes the eager/lazy divergence. However, the `LineIndexStrategy` interface itself was not changed. Further formalization would separate structural updates from offset maintenance at the interface level.

### 2.3 `DocumentStore` Optional Methods Blur the Contract — RESOLVED

Split into two interfaces in `types/store.ts`:
- `DocumentStore`: core contract (subscribe, getSnapshot, dispatch, batch) — no optional methods
- `ReconcilableDocumentStore extends DocumentStore`: adds `scheduleReconciliation()`, `reconcileNow()`, `setViewport()` — all required

`createDocumentStore` now returns `ReconcilableDocumentStore`. `DocumentStoreWithEvents` extends `ReconcilableDocumentStore`. Consumers that only need subscribe/dispatch use `DocumentStore`; consumers needing reconciliation use the extended interface.

### 2.4 Store Events Adapter Binds Methods Incorrectly — RESOLVED

Removed the misleading `.bind(emitter)` calls in `store/store.ts`. The closure-based methods are now referenced directly: `addEventListener: emitter.addEventListener`.

---

## 3. Algorithms

### 3.1 Reducer `INSERT`/`DELETE`/`REPLACE` Share an Unstated Pipeline — RESOLVED

Extracted `applyEdit(state, op: EditOperation): DocumentState` in `store/reducer.ts`. The function runs the unified pipeline: delete phase (if applicable) → insert phase → compute byte length → lazy line index update → history push → version bump. The three reducer cases are now thin wrappers: validate → build `EditOperation` → call `applyEdit`.

### 3.2 `applyChange` and `applyInverseChange` Are Duals — RESOLVED

Extracted `invertChange(change: HistoryChange): HistoryChange` in `store/reducer.ts`. `applyInverseChange` is now implemented as `applyChange(state, invertChange(change), version)`, eliminating the duplicate switch logic. The duality is explicit: `invertChange` maps insert↔delete and swaps text/oldText for replace.

### 3.3 Delete Range Fixes Red Violations but Not Black-Height — DEFERRED

Tracked as `TODO(formalization-3.3)` in `store/piece-table.ts`. This is a non-trivial R-B algorithm change. The current implementation produces a valid BST but can violate black-height invariants in edge cases. Deferred until a test case demonstrates measurable performance degradation.

**Cross-reference:** code-analysis 5.4 also notes this concern.

### 3.4 `reconcileFull` Uses Two Strategies Without a Unifying Abstraction — DEFERRED

Tracked as `TODO(formalization-3.4)` in `store/line-index.ts`. Recommendation: add a `thresholdFn` to reconciliation configuration, making the incremental/full decision injectable rather than hard-coded.

### 3.5 History Coalescing Mixes Policy with Mechanism — DEFERRED

Tracked as `TODO(formalization-3.5)` in `store/reducer.ts`. The `Date.now()` call in the reducer breaks deterministic replay. Recommendation: add an optional `timestamp` field to edit actions so the reducer can use `action.timestamp ?? Date.now()`, making replay deterministic when timestamps are provided.

**Cross-reference:** code-analysis 5.2 identifies the same non-determinism concern.

---

## 4. Specific Implementations

### 4.1 Redundant `textEncoder.encode()` Calls — PARTIALLY RESOLVED

`pieceTableInsert` now returns `PieceTableInsertResult { state, insertedByteLength }`, eliminating the need for downstream code to re-derive byte length. The reducer's `applyEdit` uses this directly instead of the `totalLength` diff. However, the line index still calls `findNewlineBytePositions` which encodes independently. Full resolution would thread the encoded bytes through the entire pipeline.

**Cross-reference:** code-analysis 8.3 identifies the same issue. The `pieceTableInsert` → reducer path is resolved; the line index path remains.

### 4.2 Reducer Computes `insertedByteLength` Indirectly — RESOLVED

`pieceTableInsert` now returns `{ state, insertedByteLength }` where `insertedByteLength` is `textBytes.length` from the encoding already performed inside the function. The reducer uses this directly — no more `totalLength` diff.

### 4.3 `getLineContent` Double-Calls `byteOffset()` — RESOLVED

`getLineRange` and `getLineRangePrecise` in `store/line-index.ts` now return `{ start: ByteOffset; length: ByteLength }` (branded types). Downstream consumers in `rendering.ts` use the branded values directly — the redundant `byteOffset()` wrapping and `as ByteOffset` casts were removed.

### 4.4 `createDocumentStoreWithEvents.batch()` Replays the Reducer — RESOLVED

Rewrote `batch()` in `store/store.ts` to route actions through the event-emitting `dispatch` wrapper within a transaction (TRANSACTION_START → dispatch each action → TRANSACTION_COMMIT). This gives both transaction semantics and per-action event emission in a single pass, eliminating the reducer replay entirely.

**Cross-reference:** Directly addresses code-analysis 6.4.

### 4.5 `deserializeAction` Has No Validation Gate — RESOLVED

`deserializeAction` in `store/actions.ts` now calls `isDocumentAction(parsed)` after `JSON.parse`, throwing `Error('Invalid deserialized action: ...')` on invalid input. The `as` casts were removed.

**Cross-reference:** Directly addresses code-analysis 5.5.

### 4.6 `selectionToCharOffsets` Reads From Document Start — DEFERRED

Tracked as `TODO(formalization-4.6)` in `store/rendering.ts`. Recommendation: use the line index to narrow the read range to the relevant line(s) instead of reading from byte 0.

### 4.7 Line Index Eager vs Lazy Operations Are Parallel Code Paths — RESOLVED

Extracted `insertLinesStructural` and `appendLinesStructural` shared functions in `store/line-index.ts`. Both eager and lazy insert paths call the shared structural function with a `computeOffset` callback that parameterizes the only divergence point: eager provides real offsets, lazy provides `'pending'`. Similarly for delete operations. Bug fixes to line-splitting logic now need to be applied only once.

### 4.8 Empty-Document Sentinel: `lineCount: 1` vs `root: null` — DEFERRED

Tracked as `TODO(formalization-4.8)` in `store/state.ts`. Recommendation: create a single zero-length `LineIndexNode` for empty documents instead of `root: null, lineCount: 1`. This would eliminate the special-case checks in `getVisibleLines` and other consumers.

---

## Cross-Reference: code-analysis-2026-02-14.md

Issues from the code analysis report that overlap with formalization findings:

| Code Analysis | Formalization | Status |
|---------------|---------------|--------|
| 5.2 History coalescing uses Date.now() | 3.5 | Deferred (TODO) |
| 5.4 Delete rebuilds sub-trees | 3.3 | Deferred (TODO) |
| 5.5 deserializeAction trusts input | 4.5 | **Resolved** |
| 6.4 Batch replays reducer twice | 4.4 | **Resolved** |
| 7.1 documentOffset: number \| 'pending' | 1.2 | Deferred (TODO) |
| 7.2 Partial<PieceNode> too wide | 2.1 | **Resolved** |
| 8.3 Redundant textEncoder.encode() | 4.1 | Partially resolved |

Code analysis items **not** covered by the formalization report (no action taken):

| Item | Notes |
|------|-------|
| 5.1 Add buffer mutation | Same as formalization 1.4, deferred |
| 5.3 getLine() is O(n) | Public API concern; consider deprecation or documentation |
| 5.6 Reconciliation during transaction | Minor scheduling waste; not actionable |
| 6.1 Missing SAVE action | Feature gap, not formalization issue |
| 6.2 LOAD_CHUNK/EVICT_CHUNK are no-ops | Planned for future phase |
| 6.3 No dispose/cleanup on store | New issue — should be addressed |
| 6.5 No error recovery for corrupted trees | Defensive measure — consider tree validation |
| 7.3 BufferReference vs inline fields | Minor duplication, low priority |
| 7.4 Readonly arrays spread-copied | Performance concern for large histories |
| 8.1 collectPieces materializes entire tree | Iterator approach would reduce allocation |
| 8.2 byteToCharOffset encodes entire string | Similar to 4.6, streaming approach needed |
| 8.4 simpleDiff DP table can be large | Edge case; computeSetValueActionsOptimized is preferred path |
| 8.5 Object.freeze() overhead | Consider dev-only freeze for production perf |
| 8.6 Line index delete falls back to O(n) | Incremental approach preferred |

---

## Summary

Of the 21 formalization issues identified on 2026-02-14:

- **13 resolved** across 4 implementation phases (type narrowing, state helpers, pipeline dedup, store fixes)
- **8 deferred** with tracked TODO comments in source code

The primary formalization gap — **pipeline regularity** — has been substantially addressed:
- INSERT/DELETE/REPLACE now flow through a single `applyEdit` pipeline
- Eager/lazy line index paths share structural logic via `insertLinesStructural`
- `applyInverseChange` is expressed as `applyChange(invertChange(change))`
- `pieceTableInsert` returns byte length directly, reducing redundant encoding

The type system improvements are complete:
- `HistoryChange` is a proper discriminated union
- `withPieceNode`/`withLineIndexNode` accept narrowed update types
- `getLineRange` returns branded `ByteOffset`/`ByteLength`
- `DocumentStore` vs `ReconcilableDocumentStore` separates the interface contract

Remaining deferred items are either higher-risk algorithm changes (3.3 black-height, 4.8 sentinel) or require broader design decisions (1.2 pending offsets, 3.5 deterministic timestamps).

All 447 tests pass. No type errors.
