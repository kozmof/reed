# Reed Formalization Analysis — Updated

**Date:** 2026-02-16
**Previous:** formalization-2026-02-14.md
**Cross-reference:** code-analysis-2026-02-14.md

---

## Resolution Summary

| Issue | Title | Status | Phase |
|-------|-------|--------|-------|
| 1.1 | LineIndexState construction scattered | **Resolved** | Phase 2a |
| 1.2 | `documentOffset: number \| 'pending'` | **Resolved** | Phase 5a |
| 1.3 | HistoryChange overloads a single type | **Resolved** | Phase 1a |
| 1.4 | addBuffer mutable backing store | **Resolved** | Phase 5c |
| 2.1 | `withPieceNode` accepts `Partial<PieceNode>` | **Resolved** | Phase 1b |
| 2.2 | LineIndexStrategy hides eager/lazy symmetry | **Resolved** | Phase 5g |
| 2.3 | DocumentStore optional methods blur contract | **Resolved** | Phase 4a |
| 2.4 | Store events adapter `.bind()` no-op | **Resolved** | Phase 1c |
| 3.1 | INSERT/DELETE/REPLACE share unstated pipeline | **Resolved** | Phase 3a |
| 3.2 | applyChange/applyInverseChange duality | **Resolved** | Phase 2b |
| 3.3 | mergeTrees black-height imbalance | **Resolved** | Phase 5e |
| 3.4 | reconcileFull hard-coded threshold | **Resolved** | Phase 5d |
| 3.5 | History coalescing mixes policy/mechanism | **Resolved** | Phase 5b |
| 4.1 | Redundant textEncoder.encode() | **Partially resolved** | Phase 3b |
| 4.2 | insertedByteLength computed indirectly | **Resolved** | Phase 3b |
| 4.3 | getLineContent double-calls byteOffset() | **Resolved** | Phase 1d |
| 4.4 | batch() replays reducer | **Resolved** | Phase 4b |
| 4.5 | deserializeAction has no validation | **Resolved** | Phase 1e |
| 4.6 | selectionToCharOffsets reads from byte 0 | **Resolved** | Phase 5f |
| 4.7 | Eager/lazy line index parallel code paths | **Resolved** | Phase 3c |
| 4.8 | Empty-document sentinel inconsistency | **Resolved** | Phase 5a |

**Resolved:** 20 of 21 issues
**Partially resolved:** 1 issue (4.1 — line index encoding path remains)

---

## 1. Data Structures

### 1.1 LineIndexState Construction Is Scattered — RESOLVED

`withLineIndexState(state, changes)` was added to `store/state.ts` and applied across 14 construction sites in `line-index.ts`. All inline `Object.freeze({ root, lineCount, ... })` patterns were replaced with the centralized helper, making variation points (which fields change per call site) explicit in the `changes` argument.

### 1.2 `documentOffset: number | 'pending'` — RESOLVED

Changed `LineIndexNode.documentOffset` from `number | 'pending'` to `number | null` across `types/state.ts`, `store/state.ts`, and `store/line-index.ts`. All `'pending'` literals replaced with `null`; all `=== 'pending'` checks replaced with `=== null`. The `createLineIndexNode` signature updated accordingly. More idiomatic TypeScript — `null` is the standard sentinel for "not yet computed".

### 1.3 `HistoryChange` Overloads a Single Type — RESOLVED

`HistoryChange` was split into three interfaces (`HistoryInsertChange`, `HistoryDeleteChange`, `HistoryReplaceChange`) in `types/state.ts`. `oldText` is now a required field only on `HistoryReplaceChange`. TypeScript narrows automatically in existing `switch` branches. All four `change.oldText ?? ''` patterns in `reducer.ts` were removed — the discriminated union makes them unnecessary.

**Cross-reference:** This also addresses code-analysis 7.2's observation about type constraint weakness, as the union is now structurally enforced.

### 1.4 `PieceTableState.addBuffer` Is a Mutable Backing Store — RESOLVED

Extracted `GrowableBuffer` class in `store/growable-buffer.ts` to encapsulate the append-only invariant. The class owns the backing `Uint8Array` and exposes:
- `readonly bytes: Uint8Array` — the backing array
- `readonly length: number` — used length (replaces the old `addBufferLength` field)
- `append(data: Uint8Array): GrowableBuffer` — returns a new instance if capacity is exceeded, mutates-in-place if it fits (preserving the existing copy-on-growth semantics)
- `subarray(start, end): Uint8Array` — zero-copy view

`PieceTableState` now uses a single `addBuffer: GrowableBuffer` field instead of the separate `addBuffer: Uint8Array` + `addBufferLength: number` pair. All consumers (`pieceTableInsert`, `getPieceBuffer`, `getBufferSlice`, `getBuffer`, `compactAddBuffer`, `getBufferStats`, and state constructors) updated to use the `GrowableBuffer` API.

**Cross-reference:** Directly addresses code-analysis 5.1.

---

## 2. Interfaces

### 2.1 `withPieceNode` Accepts `Partial<PieceNode>` — RESOLVED

Introduced `PieceNodeUpdates = Partial<Pick<PieceNode, 'color' | 'left' | 'right' | 'bufferType' | 'start' | 'length'>>` in `store/state.ts`. `withPieceNode` now accepts this narrowed type, preventing callers from passing `subtreeLength` or `subtreeAddLength`. The same treatment was applied to `withLineIndexNode` via `LineIndexNodeUpdates`.

**Cross-reference:** Directly addresses code-analysis 7.2.

### 2.2 `LineIndexStrategy` Hides the Symmetry Between Eager and Lazy — RESOLVED

Redesigned `LineIndexStrategy` in `types/store.ts` so that `insert` and `delete` operate on `LineIndexState` directly instead of `DocumentState`. This makes the structural update layer explicit — the strategy handles only line index mutations, and the reducer wraps the result back into `DocumentState` via `withState`. The eager and lazy implementations in `store/reducer.ts` are now thin delegations to the corresponding `liInsert`/`liDelete` and `liInsertLazy`/`liDeleteLazy` functions, with the `computeOffset` callback (real offsets vs. `null`) parameterizing the divergence inside `line-index.ts`.

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

### 3.3 Delete Range Fixes Red Violations but Not Black-Height — RESOLVED

Replaced the naive `mergeTrees` implementation with a proper join-by-black-height algorithm in `store/piece-table.ts`. The new implementation:
1. Extracts the minimum node from the right tree via `extractMin` as the join key
2. Computes the black-height of both trees via `blackHeight`
3. Walks down the spine of the taller tree to find a node at matching black-height
4. Grafts the shorter tree + join key as a red node, then fixes violations back up the path

This preserves the R-B black-height invariant (equal black nodes on all root-to-leaf paths), preventing degenerate O(n) lookups that the old implementation could produce.

**Cross-reference:** Directly addresses code-analysis 5.4.

### 3.4 `reconcileFull` Uses Two Strategies Without a Unifying Abstraction — RESOLVED

Added `ReconciliationConfig` interface in `store/line-index.ts` with an optional `thresholdFn: (lineCount: number) => number` parameter. `reconcileFull` now accepts an optional config argument. The default threshold formula (`Math.max(64, Math.floor(lineCount / Math.log2(lineCount + 1)))`) is preserved as `defaultThresholdFn`. Callers can inject custom threshold functions for testing or different workloads. `ReconciliationConfig` is exported from `store/index.ts` and `index.ts`.

### 3.5 History Coalescing Mixes Policy with Mechanism — RESOLVED

Added optional `readonly timestamp?: number` to `InsertAction`, `DeleteAction`, and `ReplaceAction` in `types/actions.ts`. The reducer threads `action.timestamp ?? Date.now()` through `EditOperation` → `historyPush` → `canCoalesce`, which now accepts an explicit `now: number` parameter instead of calling `Date.now()` internally. History entry timestamps also use the provided value. This makes action replay fully deterministic when timestamps are supplied.

**Cross-reference:** Directly addresses code-analysis 5.2.

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

### 4.6 `selectionToCharOffsets` Reads From Document Start — RESOLVED

Replaced the monolithic `getText(state.pieceTable, byteOffset(0), byteOffset(maxByte))` call with a line-index-aware `byteOffsetToCharOffset` helper in `store/rendering.ts`. The new implementation:
1. Uses `findLineAtPosition` to locate the line containing the byte offset — O(log n)
2. Iterates preceding complete lines, reading each line's text to count characters
3. Reads only the partial current line up to the byte offset

This narrows the work from O(document_size) to O(line_count_before_cursor × avg_line_length + current_line_length), which is significantly better for cursors near the start/middle of large documents.

### 4.7 Line Index Eager vs Lazy Operations Are Parallel Code Paths — RESOLVED

Extracted `insertLinesStructural` and `appendLinesStructural` shared functions in `store/line-index.ts`. Both eager and lazy insert paths call the shared structural function with a `computeOffset` callback that parameterizes the only divergence point: eager provides real offsets, lazy provides `null`. Similarly for delete operations. Bug fixes to line-splitting logic now need to be applied only once.

### 4.8 Empty-Document Sentinel: `lineCount: 1` vs `root: null` — RESOLVED

`createEmptyLineIndexState()` in `store/state.ts` now creates a real zero-length `LineIndexNode` (`documentOffset: 0, lineLength: 0`) instead of `root: null`. This eliminates the inconsistency where `lineCount: 1` but `findLineByNumber(root, 0)` returned `null`. The special-case `root === null` guards in `rendering.ts` (`getVisibleLines` and `positionToLineColumn`) were removed — the sentinel node handles the empty-document case naturally through the normal code path.

---

## Cross-Reference: code-analysis-2026-02-14.md

Issues from the code analysis report that overlap with formalization findings:

| Code Analysis | Formalization | Status |
|---------------|---------------|--------|
| 5.1 Add buffer mutation | 1.4 | **Resolved** |
| 5.2 History coalescing uses Date.now() | 3.5 | **Resolved** |
| 5.4 Delete rebuilds sub-trees | 3.3 | **Resolved** |
| 5.5 deserializeAction trusts input | 4.5 | **Resolved** |
| 6.4 Batch replays reducer twice | 4.4 | **Resolved** |
| 7.1 documentOffset: number \| 'pending' | 1.2 | **Resolved** |
| 7.2 Partial<PieceNode> too wide | 2.1 | **Resolved** |
| 8.3 Redundant textEncoder.encode() | 4.1 | Partially resolved |

Code analysis items **not** covered by the formalization report (no action taken):

| Item | Notes |
|------|-------|
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

- **20 resolved** across 5 implementation phases
- **1 partially resolved** (4.1 — redundant encoding in line index path)

### Phase 5 resolutions (2026-02-16)

The 8 previously deferred issues were resolved in four sub-phases:

**Phase 5a — Type/sentinel fixes:**
- `documentOffset: number | 'pending'` → `number | null` (1.2)
- Empty-document sentinel uses a real zero-length node instead of `root: null` (4.8)

**Phase 5b — Deterministic coalescing:**
- Edit actions accept optional `timestamp` field; `canCoalesce` uses explicit `now` parameter (3.5)

**Phase 5c — Buffer encapsulation:**
- `GrowableBuffer` class encapsulates the append-only `addBuffer` invariant (1.4)

**Phase 5d — Configurable reconciliation:**
- `ReconciliationConfig.thresholdFn` makes the incremental/full decision injectable (3.4)

**Phase 5e — R-B tree correctness:**
- `mergeTrees` uses proper join-by-black-height algorithm preserving the R-B invariant (3.3)

**Phase 5f — Selection offset optimization:**
- `selectionToCharOffsets` uses line index for narrowed reads instead of from byte 0 (4.6)

**Phase 5g — Interface separation:**
- `LineIndexStrategy` operates on `LineIndexState` directly, separating structural updates from `DocumentState` wrapping (2.2)

### Cumulative formalization improvements

The type system is now fully formalized:
- `HistoryChange` is a proper discriminated union
- `withPieceNode`/`withLineIndexNode` accept narrowed update types
- `getLineRange` returns branded `ByteOffset`/`ByteLength`
- `DocumentStore` vs `ReconcilableDocumentStore` separates the interface contract
- `documentOffset` uses idiomatic `number | null` instead of string literal union
- `PieceTableState.addBuffer` is an encapsulated `GrowableBuffer`
- `LineIndexStrategy` operates at the `LineIndexState` level

The pipeline regularity is complete:
- INSERT/DELETE/REPLACE flow through `applyEdit`
- Eager/lazy line index paths share structural logic via `insertLinesStructural`
- `applyInverseChange` = `applyChange(invertChange(change))`
- `pieceTableInsert` returns byte length directly
- History coalescing is deterministic when timestamps are provided

Algorithm correctness:
- `mergeTrees` preserves R-B black-height invariant via join-by-rank
- Empty-document sentinel eliminates null-root special cases
- `selectionToCharOffsets` uses line index for O(k log n) instead of O(n)
- Reconciliation threshold is injectable for testing and tuning

All 447 tests pass. No type errors.
