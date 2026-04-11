# Open Issues and Improvements

Updated 2026-04-11. Resolved issues removed; new issues from all reports added.
Items marked *(acknowledged — not fixing)* have a documented rationale for deferral and are included for completeness.

---

## Architecture / Design

### #001 — No invariant document for core structures

No concise invariant reference exists for piece table subtree fields, line index mode guarantees, or reconciliation invariants. Invariant drift risk grows as the codebase evolves.

**Source:** Report 1, §6 D4

---

### #002 — No benchmark harness

No benchmark harness for large-document edits, mixed line endings, or reconciliation thresholds. Performance confidence rests entirely on functional tests. The cost algebra annotations (`$prove`, `$lift`, etc.) are documentation only — no runtime or automated benchmark catches a false claim.

**Source:** Report 1, §8 Impl3; Report 4 (full), §6 I4

---

### #003 — `reconcileNow` bumps `state.version`; background reconciliation does not

`reconcileNow()` increments `state.version`; background reconciliation and `getEagerSnapshot()` leave it unchanged. Two consumers can observe equal document content but different version numbers depending on which reconciliation path ran. Any consumer diffing `state.version` will see spurious bumps from `reconcileNow`. The background path's "version-neutral" rationale is stronger (resolving offsets is content-neutral), so `reconcileNow` should stop bumping version; callers that need to re-render should compare line index state, not version.

**Source:** Report 4 (full), §5 P1, §6 I1

---

### #004 — Eager reconciliation before every undo/redo is O(n)

`historyUndo` and `historyRedo` call `reconcileFull` once before applying changes. For large files this is a performance cliff for rapid undo sequences. An incremental approach — resolving only the specific byte offsets needed for each change (O(k) where k = changed lines) — would avoid the full rebuild.

**Source:** Report 3, §6 I1

---

### #005 — Background reconciliation has no back-pressure

`scheduleReconciliation` relies on `reconcileIfCurrent` to detect staleness, but if edits arrive faster than reconciliation runs, the dirty range array grows until the sentinel kicks in at 32 entries. There is no explicit throttling or priority mechanism. Exposing a `reconcilePriority` signal or making the sentinel threshold configurable would give consumers control.

**Source:** Report 3, §6 I2

---

### #006 — `reducer.ts` and `store.ts` are large monoliths

`reducer.ts` (1168 lines) handles position validation, piece-table ops, line-index strategy dispatch, CRLF edge case detection, history coalescing, undo, redo, transaction reduction, selection computation, remote change application, and chunk loading — mostly independent concerns. Extracting `applyEdit`, `historyPush`, `applyHistoryUndo`, and `applyHistoryRedo` as pure functions into separate files would keep `reducer.ts` as an orchestrator only.

**Source:** Report 3, §6 I3

---

### #007 — `line-index.ts` is a 2000+ line monolith

`reconcileViewport`, `reconcileRange`, and `mergeDirtyRanges` are the most algorithmically complex functions in the codebase and are embedded in a 2254-line file. Extracting them into `store/core/reconcile.ts` would improve navigability and allow independent testing.

**Source:** Report 3, §8 Impl4

---

### #008 — Chunk eviction semantics are undocumented

`EVICT_CHUNK` is implemented, but what happens when caller code tries to access text from an evicted chunk is not documented at the public API layer. `getBuffer` throws `'Chunk N is not loaded'` at runtime. Using chunk mode without understanding this can produce opaque errors. The eviction contract (which operations are safe after eviction, and what the caller must do before evicting modified chunks) should be captured in JSDoc on `EvictChunkAction` and `EVICT_CHUNK`.

**Source:** Report 4 (full), §6 I5

---

### #009 — Phase 4: chunk loading infrastructure incomplete

The reducer actions for chunk loading are implemented, but the surrounding runtime is not yet built:

- **Out-of-order (random-access) loading not supported.** `nextExpectedChunk` enforces sequential arrival (0, 1, 2, …). Supporting random-access requires 'unloaded' placeholder pieces or gap tracking in the piece table.
- **No line-index pre-population from chunk metadata.** Immediate line-count queries on unloaded content are not possible without loading.
- **No configurable `totalFileSize`.** `DocumentStoreConfig` has no field for declaring the known total file size before loading begins.
- **No async chunk fetch subsystem, LRU/eviction policy manager, or background file parsing workers.**

**Source:** Report 4 (chunk), §5 Missing Infrastructure; design-dimensions §XVII Phase 4 open items

---

## Types & Interfaces

### #010 — `LineIndexNode<M>` phantom type verbosity *(acknowledged — not fixing)*

All tree operations must carry `<M extends EvaluationMode>`. Since `M` only affects `documentOffset` nullability, parameterizing only `LineIndexState<M>` (not individual nodes) would simplify type signatures.

Not fixing: removing the phantom from `LineIndexNode` would weaken the type system — `documentOffset` would always be `number | null`, and `getLineRangePrecise` overloads that currently guarantee non-null offsets in eager mode would lose that guarantee.

**Source:** Report 2, §7 T1

---

### #011 — `HistoryChange.byteLength` invariant unprotected at construction

`HistoryInsertChange` and `HistoryDeleteChange` carry both `text: string` and `byteLength: ByteLength`. These must satisfy `byteLength === utf8ByteLength(text)`. If a future construction site diverges (e.g. by passing the wrong `byteLength` value), undo/redo byte offsets will be silently wrong. A factory function that derives `byteLength` from `text` (or validates consistency) would enforce the invariant at the type level.

**Source:** Report 3, §7 T2

---

### #012 — `DocumentStoreConfig.lineEnding` not enforced on insert

The `lineEnding` metadata field records the document's intended line ending, but the insert path applies no normalization. Text with mismatched line endings can be inserted without any warning or coercion. A normalization layer (or at least a validation warning) in the insert path would prevent silent line-ending drift.

**Source:** Report 3, §6 I4

---

## Algorithms

### #013 — `deleteLineRangeLazy` calls O(n) tree rebuild even in lazy mode *(acknowledged — not fixing)*

For multi-line deletions, `rebuildWithDeletedRange` is called even in lazy mode because the resulting tree shape changes. Lazy delete with newlines has the same O(n) cost as eager delete, negating the lazy optimization for this case.

Not fixing: the Red-Black tree must be rebalanced after removing each line node (O(log n) per deleted line). "Lazy" defers only offset recalculation, not structural rebalancing. The current approach is correct.

**Source:** Report 2, §5 P5 (`src/store/core/line-index.ts`)

---

### #014 — `reconcileInPlace` visits all nodes even when offsets are already correct *(acknowledged — not fixing)*

The short-circuit `node.documentOffset !== correctOffset` avoids node allocation but not subtree traversal. A subtree-level correctness flag (analogous to `rebuildPending` at the state level) would allow pruning entire subtrees known to be clean.

Not fixing: coordinating invalidation across every lazy tree mutation (`insertLinesAtPositionLazy`, `rbDeleteLineByNumber`, rotations) carries high complexity. With `reconcileRange` now O(K+V), `reconcileInPlace` is already the last resort and runs infrequently.

**Source:** Report 2, §8 Impl3 (`src/store/core/line-index.ts`)

---

## Implementations

### #015 — `findNewlineBytePositions` allocates `Uint8Array` on every call (hot path)

```ts
const bytes = textEncoder.encode(text);  // allocation on every insert
```

`\r` (0x0D) and `\n` (0x0A) are single-byte ASCII and never appear in UTF-8 continuation bytes, so positions can be found via a direct `charCodeAt` scan, avoiding the allocation entirely. Computing `byteLength` still requires a UTF-8 encode but can be separated from the newline scan (or computed from `text.length` + surrogate-pair count for ASCII-heavy documents).

**Source:** Report 3, §8 Impl1 (`src/store/core/line-index.ts:56`)

---

### #016 — `fixInsert` is O(n) and still exported

`rb-tree.ts` exports both `fixInsert` (O(n), full-tree traversal) and `fixInsertWithPath` (O(log n), path-only). Any caller that imports `fixInsert` silently gets O(n) per insert, making inserts into large documents O(n log n) total. `fixInsert` should be deprecated (or its export removed) with callers migrated to `fixInsertWithPath`.

**Source:** Report 4 (full), §5 P2 (`src/store/core/rb-tree.ts:201`)

---

### #017 — `getAffectedRange` for `APPLY_REMOTE` spans the full change extent

If remote changes are non-contiguous (e.g. insert at byte 0 and insert at byte 10000), `getAffectedRange` reports `[0, 10000+]` — a single range covering the full extent. This makes the `content-change` event imprecise for consumers trying targeted re-renders. Emitting per-change ranges, or a list of disjoint ranges, would allow consumers to skip unaffected regions.

**Source:** Report 4 (full), §5 P5 (`src/store/features/events.ts`)

---

### #018 — `notifyListeners` allocates `Array.from(listeners)` on every notification

```ts
const currentListeners = Array.from(listeners);
```

This is O(L) per notification and allocates a new array on every state change. For high-frequency dispatch (key-per-character edits) this creates GC pressure. The snapshot is needed to handle mid-notify unsubscription; the `notifying` re-entrancy guard handles recursive calls separately. A copy-on-write listeners set (duplicated only when a subscription change occurs mid-notify) would eliminate the per-notification allocation for the common case.

**Source:** Report 4 (full), §5 P6; Report 1, §8 Impl (partial fix 2026-03-26) (`src/store/features/store.ts:116`)

---

### #019 — `scheduleReconciliation` 200ms `setTimeout` fallback accumulates in Node.js

For test environments and SSR, the 200ms timer can fire after the test has asserted, causing unexpected async activity and affecting teardown timing. A `reconcileMode: 'idle' | 'sync' | 'none'` option in `DocumentStoreConfig` would give consumers control without patching the global.

**Source:** Report 4 (full), §8 I14 (`src/store/features/store.ts`)

---

### #020 — `GrowableBuffer` shared-mutation contract needs a dev-mode assertion

The class JSDoc describes the invariant (old snapshots are safe only if access stays within their own `length` field), but there is no runtime check to catch misuse in development. A debug-mode bounds check in `subarray()` would catch callers reading `buffer.bytes.length` instead of `buffer.length`:

```ts
// Development only:
if (start >= this.length || end > this.length) {
  throw new Error('GrowableBuffer: out-of-bounds read');
}
```

**Source:** Report 4 (full), §8 I15 (`src/store/core/growable-buffer.ts`)

---

### #021 — `$declare` escape hatch is unchecked *(acknowledged — by design)*

`$declare` allows any value to be annotated with an arbitrary cost level without compile-time or runtime verification. Unlike `$prove`, which validates that the inner annotation does not exceed the declared maximum, `$declare` is a pure assertion with no backing check. A contributor can annotate an O(n) function as O(1) using `$declare` and the type system will not object.

By design: `$declare` exists for contexts where cost is provable by reasoning but not expressible through the `$pipe`/`$andThen` combinator algebra. The explicit disclaimer in `cost-doc.ts` makes this trade-off visible.

**Source:** Report 1, summary table (`src/types/cost-doc.ts`)

---

### #022 — Inner rollback restores only the matching snapshot, not outermost state *(acknowledged — not fixing)*

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
