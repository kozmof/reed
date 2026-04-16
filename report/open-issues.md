# Open Issues and Improvements

Updated 2026-04-16. Resolved issues removed; new issues from all reports added.
Items marked _(acknowledged — not fixing)_ have a documented rationale for deferral and are included for completeness.

---

## Architecture / Design

### #001 — No invariant document for core structures _(resolved 2026-04-16)_

Created `docs/invariants.md` capturing:

- Piece table subtree field invariants (`subtreeLength`, `subtreeAddLength`, RB invariants, immutability, chunk ordering)
- Line index mode guarantees (`'eager'` vs `'lazy'` `documentOffset` nullability, `subtreeByteLength` accuracy, `lineCount` accuracy)
- Reconciliation lifecycle invariants (`rebuildPending` ↔ `dirtyRanges.length > 0`, `lastReconciledVersion` monotonicity, dirty range merge rules, sentinel semantics, `rebuildLineIndex` `maxDirtyRanges` preservation)
- `HistoryChange` byte-length invariant and version invariants

**Source:** Report 1, §6 D4

---

### #002 — No benchmark harness _(resolved 2026-04-16)_

Created `src/benchmarks/bench.ts` — a standalone Node.js benchmark harness runnable via `npm run bench`. Covers:

- Large-document initial load (10 k lines)
- 1 000 sequential single-char inserts into a 5 k-line document
- 200 CRLF inserts into an LF document (exercises the rebuild-on-CRLF path)
- 500 inserts + 500 consecutive undos
- `reconcileNow` after 200 lazy inserts (2 k-line doc)
- 10 000 `getLineStartOffset` lookups on a 50 k-line document

Each benchmark reports median wall-clock time and fails with `process.exit(1)` if it exceeds a soft threshold (10× expected baseline).

**Source:** Report 1, §8 Impl3; Report 4 (full), §6 I4

---

### #003 — `reconcileNow` bumps `state.version`; background reconciliation does not _(resolved 2026-04-16)_

`reconcileNow()` no longer increments `state.version`. It passes `state.version` (unchanged) to `reconcileFull` and returns the reconciled state without bumping the version counter. Version semantics are now consistent: only content-modifying actions increment the version. (`src/store/features/store.ts`)

**Source:** Report 4 (full), §5 P1, §6 I1

---

### #004 — Eager reconciliation before every undo/redo is O(n) _(resolved 2026-04-16)_

`historyUndo` and `historyRedo` now call `reconcileRangeForChanges` instead of `reconcileFull`. The helper computes the union of line ranges touched by the history entry's changes (via `findLineAtPosition`, O(log n)) and reconciles only that window. Falls back to `reconcileFull` only when a sentinel dirty range is present. (`src/store/features/history.ts`, `src/store/features/edit.ts`)

**Source:** Report 3, §6 I1

---

### #005 — Background reconciliation has no back-pressure _(resolved 2026-04-16)_

Added `maxDirtyRanges?: number` to `DocumentStoreConfig` (default `32`). The value is stored on `LineIndexState.maxDirtyRanges` and threaded through all three internal `mergeDirtyRanges` call sites in `lineIndexInsertLazy` and `lineIndexDeleteLazy`. Callers can now lower the threshold for memory-constrained environments or raise it to defer reconciliation longer before collapsing to a sentinel. (`src/types/state.ts`, `src/store/core/line-index.ts`, `src/store/core/state.ts`)

**Source:** Report 3, §6 I2

---

### #006 — `reducer.ts` and `store.ts` are large monoliths _(resolved 2026-04-16)_

`reducer.ts` reduced from 1318 lines to 614 lines. Extracted:

- `src/store/features/edit.ts` (675 lines) — exports `applyEdit`, `applyChange`, `applyInverseChange`, `reconcileRangeForChanges`, and all edit-pipeline helpers (`validatePosition`, `validateRange`, `pieceTableInsert`, `pieceTableDelete`, `getTextRange`, `historyPush`, `makeInsertChange`, `makeDeleteChange`, `makeReplaceChange`, etc.)
- `src/store/features/history.ts` extended — exports `historyUndo`, `historyRedo` (imports `applyChange`/`applyInverseChange` from `edit.ts` to avoid circular dependency)

`reducer.ts` is now an orchestrator that maps `DocumentAction` variants to the correct pipeline function.

**Source:** Report 3, §6 I3

---

### #007 — `line-index.ts` is a 2000+ line monolith _(resolved 2026-04-16)_

`line-index.ts` reduced from 2291 lines to 1875 lines. Created `src/store/core/reconcile.ts` (471 lines) containing `mergeDirtyRanges`, `reconcileRange`, `reconcileFull`, `reconcileViewport`, and `ReconciliationConfig`. `line-index.ts` imports all five from `reconcile.ts` and re-exports them to preserve its public API unchanged.

**Source:** Report 3, §8 Impl4

---

### #008 — Chunk eviction semantics are undocumented _(resolved 2026-04-16)_

Added comprehensive JSDoc to `EvictChunkAction` in `src/types/actions.ts` and `evictChunk()` in `src/store/features/actions.ts`. The documentation covers: which operations are safe after eviction, what the caller must do before evicting modified chunks (check `hasAddPiecesInRange`), the runtime error thrown by `getBuffer('Chunk N is not loaded')`, and the line-index side-cache restoration behaviour for pre-declared chunk metadata.

**Source:** Report 4 (full), §6 I5

---

### #009 — Phase 4: chunk loading infrastructure incomplete _(resolved 2026-04-13)_

All four sub-items addressed:

- **Out-of-order (random-access) loading** — `nextExpectedChunk` is now a high-water mark rather than a strict gate. `loadedChunks: ReadonlySet<number>` (added to `PieceTableState`) tracks first-time loads across evictions. Gap-then-fill sequences (e.g. chunk 0, 2, 1) are accepted; out-of-order first loads use the existing `findReloadInsertionPos` helper while sequential loads retain the O(log n) `appendChunkPiece` fast path. (`src/store/features/reducer.ts`, `src/types/state.ts`)

- **Line-index pre-population from chunk metadata** — New `DECLARE_CHUNK_METADATA` action registers `ChunkMetadata` (chunkIndex, byteLength, lineCount) before chunks are loaded. A `unloadedLineCountsByChunk: ReadonlyMap<number, number>` side-cache on `LineIndexState` feeds `getLineCountFromIndex`, which now sums tree line count and all declared-but-unloaded chunk counts. Entries are removed on `LOAD_CHUNK` and restored on `EVICT_CHUNK` when metadata is known. Does not bump `state.version` or emit `content-change`. (`src/types/state.ts`, `src/types/actions.ts`, `src/store/features/reducer.ts`, `src/store/core/line-index.ts`)

- **Configurable `totalFileSize`** — `DocumentStoreConfig.totalFileSize?: number` added; stored as `PieceTableState.totalFileSize` (0 = unknown). (`src/types/state.ts`, `src/store/core/state.ts`)

- **Async chunk fetch subsystem** — New `ChunkManager` module (`src/store/features/chunk-manager.ts`) provides `ChunkLoader` / `ChunkManagerConfig` / `ChunkManager` interfaces and a `createChunkManager(store, loader, config?)` factory. Features: in-flight deduplication, LRU eviction (`maxLoadedChunks`, default 8), chunk pinning via `setActiveChunks`, background `prefetch`, and graceful `dispose`. Exported from `src/store/index.ts` and `src/index.ts`.

**Source:** Report 4 (chunk), §5 Missing Infrastructure; design-dimensions §XVII Phase 4 open items

---

## Types & Interfaces

### #010 — `LineIndexNode<M>` phantom type verbosity _(acknowledged — not fixing)_

All tree operations must carry `<M extends EvaluationMode>`. Since `M` only affects `documentOffset` nullability, parameterizing only `LineIndexState<M>` (not individual nodes) would simplify type signatures.

Not fixing: removing the phantom from `LineIndexNode` would weaken the type system — `documentOffset` would always be `number | null`, and `getLineRangePrecise` overloads that currently guarantee non-null offsets in eager mode would lose that guarantee.

**Source:** Report 2, §7 T1

---

### #011 — `HistoryChange.byteLength` invariant unprotected at construction _(resolved 2026-04-16)_

All `HistoryInsertChange`, `HistoryDeleteChange`, and `HistoryReplaceChange` objects are now created exclusively through `makeInsertChange`, `makeDeleteChange`, and `makeReplaceChange` factory functions in `src/store/features/edit.ts`. Each factory derives `byteLength` from `textEncoder.encode(text).byteLength` rather than accepting it as a parameter, making divergence impossible. All inline object literals in `applyEdit` and `coalesceChanges` have been replaced with factory calls.

**Source:** Report 3, §7 T2

---

### #012 — `DocumentStoreConfig.lineEnding` not enforced on insert _(resolved 2026-04-16)_

Added opt-in line-ending normalization via `normalizeInsertedLineEndings?: boolean` in `DocumentStoreConfig` (default `false`). When enabled, the INSERT and REPLACE handlers in `documentReducer` call `normalizeLineEndings(text, state.metadata.lineEnding)` before passing text to `applyEdit`. Normalization handles all three modes: `'lf'` (CRLF → LF, lone CR → LF), `'crlf'` (lone CR → LF then lone LF → CRLF), `'cr'` (CRLF → CR, lone LF → CR). Defaults to `false` to avoid breaking existing callers that intentionally insert mixed line endings. (`src/types/state.ts`, `src/store/core/state.ts`, `src/store/features/reducer.ts`)

**Source:** Report 3, §6 I4

---

## Algorithms

### #013 — `deleteLineRangeLazy` calls O(n) tree rebuild even in lazy mode _(acknowledged — not fixing)_

For multi-line deletions, `rebuildWithDeletedRange` is called even in lazy mode because the resulting tree shape changes. Lazy delete with newlines has the same O(n) cost as eager delete, negating the lazy optimization for this case.

Not fixing: the Red-Black tree must be rebalanced after removing each line node (O(log n) per deleted line). "Lazy" defers only offset recalculation, not structural rebalancing. The current approach is correct.

**Source:** Report 2, §5 P5 (`src/store/core/line-index.ts`)

---

### #014 — `reconcileInPlace` visits all nodes even when offsets are already correct _(acknowledged — not fixing)_

The short-circuit `node.documentOffset !== correctOffset` avoids node allocation but not subtree traversal. A subtree-level correctness flag (analogous to `rebuildPending` at the state level) would allow pruning entire subtrees known to be clean.

Not fixing: coordinating invalidation across every lazy tree mutation (`insertLinesAtPositionLazy`, `rbDeleteLineByNumber`, rotations) carries high complexity. With `reconcileRange` now O(K+V), `reconcileInPlace` is already the last resort and runs infrequently.

**Source:** Report 2, §8 Impl3 (`src/store/core/line-index.ts`)

---

## Implementations

### #015 — `findNewlineBytePositions` allocates `Uint8Array` on every call (hot path) _(resolved 2026-04-16)_

Replaced `textEncoder.encode(text)` scan with a direct `charCodeAt` loop. The loop accumulates UTF-8 byte widths using the standard 1/2/3/4-byte rules (with surrogate-pair detection for code points > U+FFFF) and records newline byte positions inline — no `Uint8Array` allocation. Total byte length is returned as a by-product of the same pass. (`src/store/core/line-index.ts`)

**Source:** Report 3, §8 Impl1 (`src/store/core/line-index.ts:56`)

---

### #016 — `fixInsert` is O(n) and still exported _(resolved 2026-04-16)_

`fixInsert` changed from `export function` to `function` (unexported). Added a `@deprecated` JSDoc noting that callers should use `fixInsertWithPath` instead. Added `void fixInsert;` to suppress the unused-symbol warning. The `rb-tree.test.ts` import of `fixInsert` was removed; the relevant test now exercises `rebalanceAfterInsert` + `ensureBlackRoot` directly. (`src/store/core/rb-tree.ts`, `src/store/core/rb-tree.test.ts`)

**Source:** Report 4 (full), §5 P2 (`src/store/core/rb-tree.ts:201`)

---

### #017 — `getAffectedRange` for `APPLY_REMOTE` spans the full change extent _(resolved 2026-04-16)_

Renamed `getAffectedRange` → `getAffectedRanges`. Return type changed from `readonly [ByteOffset, ByteOffset]` to `readonly (readonly [ByteOffset, ByteOffset])[]`. For single-change actions (INSERT, DELETE, REPLACE) a single-element array is returned. For `APPLY_REMOTE`, one `[start, end)` range is returned per change — no bounding-box merge. `ContentChangeEvent.affectedRange` → `affectedRanges`. Updated all consumers: `src/store/features/events.ts`, `src/store/features/store.ts`, `src/api/events.ts`, `src/store/index.ts`, `src/types/store.ts`, `src/store/features/events.test.ts`.

**Source:** Report 4 (full), §5 P5 (`src/store/features/events.ts`)

---

### #018 — `notifyListeners` allocates `Array.from(listeners)` on every notification _(resolved 2026-04-16)_

Replaced `Set<StoreListener>` with `StoreListener[]` and a copy-on-write pattern. `subscribe` and `unsubscribe` clone the array (new reference) only when called during an active notification (`notifying === true`); otherwise they mutate in place. `notifyListeners` iterates the array directly — no `Array.from()` allocation. (`src/store/features/store.ts`)

**Source:** Report 4 (full), §5 P6; Report 1, §8 Impl (`src/store/features/store.ts:116`)

---

### #019 — `scheduleReconciliation` 200ms `setTimeout` fallback accumulates in Node.js _(resolved 2026-04-16)_

Added `reconcileMode?: 'idle' | 'sync' | 'none'` to `DocumentStoreConfig` (default `'idle'`). In `scheduleReconciliation`: `'none'` returns immediately (no scheduling), `'sync'` calls `reconcileFull` inline before returning, `'idle'` preserves the existing `requestIdleCallback` + 200ms `setTimeout` path. The mode is stored in the store closure and checked on every `scheduleReconciliation` call. (`src/types/state.ts`, `src/store/core/state.ts`, `src/store/features/store.ts`)

**Source:** Report 4 (full), §8 I14 (`src/store/features/store.ts`)

---

### #020 — `GrowableBuffer` shared-mutation contract needs a dev-mode assertion _(resolved 2026-04-16)_

Added a `process.env.NODE_ENV !== 'production'` guard at the top of `subarray()` that throws `GrowableBuffer: out-of-bounds read [${start}, ${end}) exceeds valid length ${this.length}` when `start < 0` or `end > this.length`. No impact on production bundles (tree-shaken by Vite). (`src/store/core/growable-buffer.ts`)

**Source:** Report 4 (full), §8 I15 (`src/store/core/growable-buffer.ts`)

---

### #021 — `$declare` escape hatch is unchecked _(acknowledged — by design)_

`$declare` allows any value to be annotated with an arbitrary cost level without compile-time or runtime verification. Unlike `$prove`, which validates that the inner annotation does not exceed the declared maximum, `$declare` is a pure assertion with no backing check. A contributor can annotate an O(n) function as O(1) using `$declare` and the type system will not object.

By design: `$declare` exists for contexts where cost is provable by reasoning but not expressible through the `$pipe`/`$andThen` combinator algebra. The explicit disclaimer in `cost-doc.ts` makes this trade-off visible.

**Source:** Report 1, summary table (`src/types/cost-doc.ts`)

---

### #022 — Inner rollback restores only the matching snapshot, not outermost state _(acknowledged — not fixing)_

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
