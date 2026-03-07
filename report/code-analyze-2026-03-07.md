# Reed Codebase Analysis Report
Date: 2026-03-07

---

## Part 1 — Code Analysis

### 1. Code Organization and Structure

The codebase is organized into three layers:

```
src/
  types/           — Pure type definitions and branded utilities (no runtime deps on store)
    state.ts       — Core document state types (PieceTable, LineIndex, History, PStack)
    actions.ts     — Discriminated-union action types + validation
    branded.ts     — Phantom-typed position types (ByteOffset, CharOffset, etc.)
    cost.ts        — Type-level complexity algebra and pipeline combinators
    store.ts       — Store interface contracts (DocumentStore, ReconcilableDocumentStore)
  store/
    core/          — Immutable data structure implementations
      rb-tree.ts   — Generic RB-tree rotations / fixup (WithNodeFn abstraction)
      piece-table.ts — Piece-table insert/delete/getText (O(log n) RB tree ops)
      line-index.ts  — Line index RB tree + lazy/eager reconciliation system
      state.ts       — Factory functions and `with*` structural-sharing helpers
      growable-buffer.ts — Append-only buffer for add-side of piece table
      encoding.ts    — Shared TextEncoder/TextDecoder singletons
    features/      — Stateful orchestration layer
      reducer.ts   — Pure documentReducer (action → state transition)
      store.ts     — createDocumentStore / createDocumentStoreWithEvents factories
      transaction.ts — Nested transaction manager (depth + snapshot stack)
      history.ts   — canUndo / canRedo / getUndoCount helpers
      events.ts    — Typed event emitter (content-change, selection-change, etc.)
      diff.ts / rendering.ts — Derived utilities
  api/             — Public-facing query namespace (read-only selectors)
    query.ts       — query.* object with O(1)/O(log n) selectors
    interfaces.ts  — QueryApi contract (satisfies-checked)
    scan.ts / position.ts / history.ts / cost.ts / diff.ts / rendering.ts
```

Layer discipline is strong: `types/` never imports from `store/`, `store/core` never imports from `store/features`, and `api/` composes from both. The boundary from lower layers up to features is clean.

---

### 2. Relations of Implementations (Types and Interfaces)

**RBNode hierarchy**

```
RBNode<T>                 — generic tree node (color, left, right)
  PieceNode               — bufferType, start, length, subtreeLength, subtreeAddLength
  LineIndexNode<M>        — documentOffset (M-parameterized), lineLength, charLength,
                             subtreeLineCount, subtreeByteLength, subtreeCharLength
```

The `F-bounded polymorphism` on `RBNode<T extends RBNode<T>>` is correctly applied. The generic RB-tree utilities in `rb-tree.ts` (`rotateLeft`, `rotateRight`, `fixInsertWithPath`) accept `WithNodeFn<N>` to remain node-type-agnostic while preserving subtree aggregates automatically.

**DocumentState hierarchy**

```
DocumentState<M>
  pieceTable: PieceTableState
  lineIndex:  LineIndexState<M>    — M propagates 'eager' | 'lazy' constraint
  selection:  SelectionState
  history:    HistoryState         — PStack<HistoryEntry> for O(1) structural sharing
  metadata:   DocumentMetadata
```

The `EvaluationMode` type parameter threads from `LineIndexState<M>` up through `DocumentState<M>`, making eager/lazy state visible at the type level. The phantom constraint ensures callers of `getLineRange` pass a `DocumentState<'eager'>` without a runtime check.

**Store interface hierarchy**

```
DocumentStore
  ReconcilableDocumentStore   — adds scheduleReconciliation, reconcileNow, setViewport, emergencyReset
    DocumentStoreWithEvents   — adds addEventListener / removeEventListener / events
ReadonlyDocumentStore         — subscribe + getSnapshot (read-only subset)
```

**Cost type system**

`Costed<Level, T>` is a phantom brand that propagates through `$pipe` / `$andThen` / `$map` combinators. `$prove` / `$proveCtx` are compile-time checked boundaries; `$declare` is an unchecked escape hatch. This gives a proof-carrying type for asymptotic cost annotations without any runtime overhead.

---

### 3. Relations of Implementations (Functions)

**Piece table write path**

```
reducer.applyEdit
  → pieceTableInsert (ptInsert)          O(log n)  — RB tree insert + add-buffer append
  → pieceTableDelete (ptDelete)          O(log n)  — RB tree split + rebuild
  → liInsertLazy / liDeleteLazy          O(log n)  — structural update + dirty-range push
  → historyPush                          O(1)      — pstackPush, optional coalesce
```

**Line index reconciliation path**

```
scheduleReconciliation (rIC / setTimeout)
  → reconcileFull
      fast path: reconcileRange (sweep-line O(K+V))  for each dirty range
      slow path: rebuildLineIndex (full O(n) scan)   when sentinel present
  reconcileNow → reconcileFull (same, version+1)
  setViewport  → reconcileViewport → reconcileRange  (priority viewport window)
```

**Undo/redo path**

```
historyUndo / historyRedo
  → reconcileFull (force eager)          — ensures offsets are valid before replay
  → applyInverseChange / applyChange
      → invertChange (insert↔delete duality)
      → liInsert / liDelete (eager)      — no lazy dirty ranges produced
```

**Event emission path (createDocumentStoreWithEvents)**

```
dispatch(action)
  → baseStore.dispatch(action)           — state transition
  → emitEventsForAction                  — content-change / selection-change / history-change / dirty-change
```

---

### 4. Specific Contexts and Usages

- **Lazy editing path**: Normal user edits (INSERT / DELETE / REPLACE) use `liInsertLazy` / `liDeleteLazy`. These update the tree structure immediately but record `DirtyLineRange` entries instead of computing byte offsets. Background `scheduleReconciliation` resolves them.
- **Eager path**: Undo / redo forces `reconcileFull` synchronously before applying inverse changes. This ensures the tree has accurate offsets for position arithmetic.
- **Viewport priority**: `setViewport(startLine, endLine)` calls `reconcileRange` for the visible window immediately, then schedules background reconciliation for the rest.
- **PStack for history**: `HistoryState.undoStack` / `redoStack` are `PStack<HistoryEntry>` (persistent cons-list). Snapshot overhead for history is O(1) per transaction instead of O(K×H) with a mutable array copy.
- **`isSentinel`**: `DirtyLineRange.isSentinel` is a flag that signals "delta information lost, must full-rebuild." Set by `mergeDirtyRanges` when range count exceeds 32. Detected in `reconcileFull` to trigger slow path.
- **Branded positions**: `ByteOffset`, `CharOffset`, `ByteLength` prevent silent confusion between byte positions and character positions at compile time. `addByteOffset`, `diffByteOffset` preserve the brand through arithmetic.

---

### 5. Pitfalls

**5.1 — `mergeDirtyRanges` decomposition accumulates output into `merged[]` then resolves `current` at the end.** The loop is non-trivial: `current` is the "in-flight" range, and `merged` accumulates fully resolved ranges. A future reader unfamiliar with this invariant may confuse `current` with an already-flushed range and introduce double-counting.

**5.2 — `applyEdit` order of operations: delete phase writes `lineIndex` before piece-table delete.** In `applyEdit`, `liDeleteLazy` is called on `newState.lineIndex` but `pieceTableDelete` is called on `newState` (which still has the old piece table at that point). The resulting line index references the old structure. This is intentional — lazy dirty-range tracking doesn't need the new piece table yet — but the temporal mismatch is easy to misread.

**5.3 — `reconcileFull` slow path invokes `rebuildLineIndex` which calls `getText` over the entire document.** The `getText` call decodes the full document to a string and re-encodes to scan for newlines. For a megabyte+ document this is O(n) per reconcile. The caller checks for the sentinel, but there is no guard against a legitimate, very large set of non-sentinel dirty ranges triggering the slow path accidentally.

**5.4 — `historyPush` trims the undo stack by converting `PStack → array → PStack`.** When `pstackSize > history.limit`, it calls `pstackToArray` (O(H)) then `pstackFromArray` (O(H)). This is intentional but breaks the O(1) benefit of PStack for that specific call. It only fires at the limit boundary, but is worth noting.

**5.4 — `LOAD_CHUNK` / `EVICT_CHUNK` are no-ops with a "Phase 3" comment.** These are in the action union, included in `isDocumentAction` validation, and dispatched through the reducer — but silently return `state`. They are easy to miss as stubs during code review.

**5.5 — `createDocumentStoreWithEvents.batch` re-implements the transaction try/finally from `createDocumentStore.batch`.** The logic is duplicated verbatim rather than delegating to the base implementation. If the base `batch` error-handling changes, the events variant may drift.

---

### 6. Improvement Points 1 — Design Overview

**6.1 — `applyEdit` function combines too many responsibilities.** It performs delete, insert, line-index update, history push, dirty-marking, and version increment — all in a single ~80-line function with a `forceLineIndexRebuild` flag that controls branching throughout. The phases are not composable; extracting them into a pipeline (`deletePhase → insertPhase → historyPhase → versionPhase`) would make each testable independently and remove the flag-based branching.

**6.2 — Eager vs. lazy duality is partially formalized.** The `EvaluationMode` type parameter captures the distinction at the type level, but the functions that perform eager updates (`liInsert`, `liDelete`) vs. lazy updates (`liInsertLazy`, `liDeleteLazy`) are chosen by the reducer based on context (undo/redo vs. normal edit) with ad-hoc `if`-branches. Formalizing this as a strategy (e.g., an `UpdateStrategy` type with `insert` / `delete` methods) would make the duality structural rather than conditional.

**6.3 — `scheduleReconciliation` does not notify listeners after background reconciliation.** Background reconciliation changes the line index (nulls become real offsets) but does not call `notifyListeners()`. Consumers that rely on `getSnapshot()` for accurate offsets will silently see stale null offsets until the next user action. The `reconcileNow` path correctly notifies, but the idle-callback path does not. If a component caches `getSnapshot()` between events, this can produce invisible inconsistency.

**6.4 — `emergencyReset` is a catch-all with observable effects (notifyListeners).** It is called inside `finally` blocks of `batch`, and it unconditionally calls `notifyListeners()`. If emergency reset itself is invoked from within a listener callback, this creates a re-entrancy scenario.

---

### 7. Improvement Points 2 — Types and Interfaces

**7.1 — `LineIndexNode<M>` uses a conditional type on `documentOffset` but the constraint is not enforced at mutation sites.** `withLineIndexNode` accepts `LineIndexNodeUpdates` which includes `documentOffset: number | null`. The `M` parameter is not threaded through `LineIndexNodeUpdates`, so it is possible to set `documentOffset = null` on an eager node without a type error.

**7.2 — `LineIndexState<M>` constrains `dirtyRanges` and `rebuildPending` conditionally, but `withLineIndexState<M>` accepts `Partial<LineIndexState<M>>`.** Writing `{ rebuildPending: true }` into an eager `LineIndexState<'eager'>` would be a type error — but the `Partial<>` wrapper means TypeScript may not always catch narrowing violations when `M` is inferred as the union `EvaluationMode`.

**7.3 — `ReadTextFn` and `DeleteBoundaryContext` are declared in `types/store.ts`.** These are operational callback types, not store interface types. Placing them in `store.ts` (which otherwise defines `DocumentStore`, `ReconcilableDocumentStore`, etc.) is semantically mismatched. They are internal helpers for `line-index.ts` and could live in `types/state.ts` or a dedicated `types/line-index.ts`.

**7.4 — `RemoteChange` uses optional `text?: string` and `length?: number` instead of a discriminated union.** `change.type === 'insert'` requires `text` and `change.type === 'delete'` requires `length`, but the type allows either field to be absent on either variant. The reducer handles this with runtime `if (change.text)` guards. A proper discriminated union would eliminate those guards.

**7.5 — `PStack<T>` is a type alias (not an opaque/branded type), so callers can accidentally destructure or mutate `{ top, rest, size }` directly.** The helpers `pstackPush/Pop/Peek/Size` are the intended API, but nothing prevents bypassing them. An opaque brand would close this.

---

### 8. Improvement Points 3 — Implementations

**8.1 — `getAffectedRange` in `events.ts` calls `textEncoder.encode(action.text).length` to compute affected range end.** This allocates a `Uint8Array` purely to measure byte length. The reducer already computes `insertedByteLength` — if that value were surfaced (e.g., on the new state's version diff) the allocation could be avoided.

**8.2 — `historyPush` trims by array round-trip.** As noted in pitfalls: when the limit is hit, `pstackToArray` + `slice` + `pstackFromArray` runs in O(H). The trim could be bounded by keeping a secondary counter and trimming incrementally (drop the oldest on every push once at limit), keeping each push O(1).

**8.3 — `buildLineIndexTree` in `state.ts` creates nodes with color `'black'` throughout.** The recursively-built tree is not a proper red-black tree — all nodes are black. This satisfies the black-height invariant only if the tree is perfectly balanced (which the median-split approach approximately achieves for initial content). For follow-on insert operations the fixup rebalancer must handle arbitrary topologies. A comment explaining why this is safe would help readers who know RB invariants.

**8.4 — `countDeletedLineBreaks` reconstructs a virtual "before/after" string with string concatenation.** The function computes `countNewlines(before) - countNewlines(after)` by creating `${prevChar}${deletedText}${nextChar}` strings. For the common case (`prevChar`/`nextChar` are undefined), this is equivalent to `countNewlines(deletedText)`, but the function still takes the slower path if only one boundary is defined. The early-exit at line 100-101 only triggers when both are undefined.

**8.5 — `reconcileRange` export is in the `store/index.ts` and `api/store.ts` public surfaces.** This is a fairly low-level operation that requires callers to understand dirty-range semantics (version parameter, line bounds). Exposing it in the public API without guard documentation increases the risk of misuse compared to the higher-level `reconcileNow` / `setViewport` entry points.

---

### 9. Learning Paths (Entries and Goals)

| Goal | Entry point |
|------|------------|
| Understand the data model | `types/state.ts` — read `PieceNode`, `LineIndexNode<M>`, `DocumentState<M>` top-to-bottom |
| Follow an edit end-to-end | `store/features/reducer.ts` `applyEdit` → `piece-table.ts` `pieceTableInsert` → `line-index.ts` `lineIndexInsertLazy` |
| Understand lazy reconciliation | `types/state.ts` `DirtyLineRange` + `line-index.ts` `mergeDirtyRanges` + `reconcileFull` |
| Understand undo/redo | `reducer.ts` `historyUndo` / `historyRedo` + `invertChange` + `applyChange` |
| Understand cost branding | `types/cost.ts` `$prove` / `$declare` / `$pipe` / `Ctx<C, T>` |
| Understand the store contract | `types/store.ts` `DocumentStore` → `ReconcilableDocumentStore` → `DocumentStoreWithEvents` |
| Understand the public API | `api/query.ts` `query.*` satisfying `QueryApi` |

---

## Part 2 — Formalize Analysis

### Data Structures

**DirtyLineRange — sentinel encoding is fragile**

`DirtyLineRange.isSentinel?: true` is an optional boolean on a value-level struct. The sentinel is distinguished from a legitimate zero-delta full-range range only by this flag. Because the field is optional (absent = `false`), code that constructs a `DirtyLineRange` by spreading and omitting `isSentinel` will silently produce a non-sentinel — even if the original was a sentinel. A dedicated variant type would make this structural:

```ts
type DirtyLineRange =
  | { readonly kind: 'range'; readonly startLine: number; readonly endLine: number; readonly offsetDelta: number }
  | { readonly kind: 'sentinel' }
```

This eliminates the optional-flag ambiguity and makes exhaustiveness checking possible at usage sites.

**PStack — size field lives on the node, not the stack**

`PStack<T>` embeds `size` on every cons cell. This is correct but means `pstackToArray` (O(H)) and `pstackFromArray` (O(H)) are the only way to trim the stack. The size is only needed for the limit check in `historyPush`. An alternative is a thin wrapper `{ top: PStack<T>; size: number }` at the stack level, keeping cons cells minimal.

**LineIndexNode subtree aggregates are recomputed in `withLineIndexNode` only when changed fields are detected by key presence**

The condition `'left' in changes || 'right' in changes || 'lineLength' in changes || 'charLength' in changes` uses `in` operator on the `changes` object. This means passing `{ lineLength: node.lineLength }` (same value, field present) will trigger recomputation, while omitting the field skips it even if it was set elsewhere. The invariant is: "aggregates are consistent with the node's current children and lengths." The implementation satisfies it, but the trigger condition is syntactic (key presence) rather than semantic (value change), which is a potential confusion point.

**`EditOperation` is an internal struct with optional fields encoding three variants**

```ts
interface EditOperation {
  position: ByteOffset;
  deleteEnd?: ByteOffset;
  deletedText?: string;
  insertText: string;
}
```

The three variants (insert, delete, replace) are encoded by the presence/absence of `deleteEnd`. A discriminated union would express the semantics explicitly and eliminate the need for `op.deleteEnd !== undefined` guards at three points in `applyEdit`.

---

### Interfaces

**`DocumentStore.dispatch` returns `DocumentState` but callers can observe state changes without using the return value**

The store contract exposes both `dispatch() → DocumentState` and `getSnapshot() → DocumentState`. These return the same object after a non-transaction dispatch, but during a transaction `dispatch` returns the pre-commit state while `getSnapshot` returns the in-progress state. The asymmetry is documented in comments but not type-encoded. A transaction-aware state type (e.g., `{ committed: DocumentState; inFlight: DocumentState }`) would make the distinction structural.

**`ReconcilableDocumentStore.reconcileNow` has two overloads sharing one name**

```ts
reconcileNow(): DocumentState<'eager'>;
reconcileNow(snapshot: DocumentState): DocumentState<'eager'> | null;
```

The two overloads encode different semantics: unconditional vs. snapshot-gated. The snapshot parameter could be a named option (`reconcileNow({ ifCurrentSnapshot?: DocumentState })`) to avoid overload ambiguity, or the gated form could be a separate method (`reconcileIfCurrent`).

**`QueryApi` (interfaces.ts) and `query` (query.ts) use `satisfies QueryApi`**

This is a sound pattern: `satisfies` catches missing or mistyped entries without widening the object type. The `lineIndex` sub-namespace on `query` is not present on `QueryApi`, which means it is accessible on `query` but not part of the contract. This is intentional (internal low-level access) but should be explicit in the interface.

---

### Algorithms

**`mergeDirtyRanges` — the overlap decomposition loop is asymmetric**

When two ranges overlap with `s1 < s2 <= e1` and different deltas, the loop decomposes the overlap into sub-ranges and reassigns `current`. The code handles `current.endLine < next.endLine`, `current.endLine === next.endLine`, and `current.endLine > next.endLine` in separate branches. The `exhausted` flag is set in the last branch to signal that `current` was already flushed into `merged` — but `exhausted` is only checked after the loop. This is correct but the single-pass invariant ("current is always the active range") is broken mid-loop when exhausted.

**`reconcileFull` threshold (32 ranges) is an uncalibrated magic number**

```ts
// calibrated for the former O(V×K) reconcileRange; the sweep-line O(K+V) implementation
// makes incremental reconciliation faster by ~V/K on average.
```

The comment acknowledges this, but the threshold is now pessimistic for the sweep-line implementation. The comment says the number should be re-calibrated but has not been. The threshold directly determines when `rebuildLineIndex` (O(n)) is triggered instead of incremental reconciliation, so the value has a direct performance impact on large documents with many edits.

**`countDeletedLineBreaks` — string concatenation for boundary checking**

For the CRLF boundary case, the function builds `${prevChar}${deletedText}${nextChar}` and counts newlines in it. This is semantically clear but allocates two strings per call. A character-level scan of `prevChar`, `deletedText[0]`, `deletedText[last]`, `nextChar` directly would avoid the allocation.

**`applyChange` reconciles lazily before applying each change in an undo/redo multi-change entry**

```ts
const reconciledLI = reconcileFull(state.lineIndex, version);
```

This is called once per `change` in the entry's `changes` array. For multi-change history entries, this means `reconcileFull` is invoked for every change even though after the first call the index is already eager. The result of the first call should be threaded through subsequent calls in the loop.

---

### Specific Implementations

**`applyEdit` — `forceLineIndexRebuild` flag breaks the monotone pipeline pattern**

```ts
let forceLineIndexRebuild = false;
// ... delete phase sets forceLineIndexRebuild = true ...
// ... insert phase skips line-index update if forceLineIndexRebuild ...
// ... after both phases: if (forceLineIndexRebuild) rebuildLineIndexFromPieceTableState(newState)
```

The flag introduces non-local control flow: a decision made in the delete phase affects the insert phase's behavior and the post-insert phase. This is the primary fragility point of the pipeline. The rebuild decision should be made once, before the pipeline begins, based on the delete text analysis — then the appropriate code path chosen upfront.

**`batch` in `createDocumentStoreWithEvents` duplicates the try/finally from `createDocumentStore.batch`**

Both `batch` implementations share the same structure:
```ts
dispatch(TRANSACTION_START)
try {
  for (action of actions) dispatch(action)
  success = true
  dispatch(TRANSACTION_COMMIT)
} finally {
  if (!success) try { dispatch(TRANSACTION_ROLLBACK) } catch { emergencyReset() }
}
```

The events variant cannot delegate to the base `batch` because it needs event-emitting dispatch, but the duplication means the two implementations can diverge. A `withTransactionBatch(dispatch, emergencyReset, actions)` helper extracted from both would consolidate the pattern and already exists as `withTransaction` (which handles single callbacks but not arrays).

**`notifyListeners` snapshots the Set into an Array on every call**

```ts
const currentListeners = Array.from(listeners);
```

This is O(L) per notification and allocates a new array. For editor workloads with high-frequency edits this adds GC pressure. A common pattern is to iterate the Set directly with a re-entrancy guard flag instead:

```ts
let notifying = false;
// ...
if (notifying) return; // re-entrancy guard
notifying = true;
try { for (const l of listeners) { try { l() } catch (e) { ... } } }
finally { notifying = false; }
```

This avoids the allocation for the common case and still handles subscription mutations (by not acting on mid-iteration additions).

**`validateAction` in `actions.ts` and `isDocumentAction` duplicate the `switch(action.type)` structure**

Both functions enumerate all action types. `isDocumentAction` is a fast-path guard (boolean), `validateAction` is a detailed checker (errors array). The `LOAD_CHUNK` case in `isDocumentAction` checks `instanceof Uint8Array`, while `validateAction` checks it separately. Any new action type requires updating both functions. A single source-of-truth validator with a boolean-projection wrapper would eliminate the duplication.

**`createLineIndexState` decodes UTF-8 substrings with `textDecoder.decode(bytes.subarray(...))` in a loop**

For each line in the initial content, a `textDecoder.decode` call is made to compute `charLength`. For a document with N lines this is O(N) decode calls. Since the input is a JavaScript string, `charLength` could be computed directly on the string segments using string slicing (which already knows code-unit positions) instead of re-decoding from bytes.

---

## Summary Table

| Area | Reliability | Key Gap |
|------|-------------|---------|
| Type-level cost algebra | High | `$declare` escape hatch is unchecked by design; misuse undetectable |
| Lazy/eager duality | High | Mode constraint leaks at `withLineIndexNode` mutation site |
| Piece table ops | High | No issues found |
| `mergeDirtyRanges` | Medium | Sentinel encoding fragile; `exhausted` flag breaks invariant clarity |
| `applyEdit` pipeline | Medium | `forceLineIndexRebuild` flag, non-composable phases |
| Transaction management | High | `emergencyReset` unconditional listener notify could re-enter |
| History (PStack) | High | Trim O(H) round-trip at limit boundary |
| Event system | Medium | `batch` duplication; background reconcile skips `notifyListeners` |
| Public API (query) | High | `lineIndex` sub-namespace outside `QueryApi` contract |
