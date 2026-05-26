# Open Issues

Collected from all reports in `report/`. Fixed items are excluded.

---

## From `code-analyze-2026-04-16.md`

### §5.2 / §8.1 — `deleteRange`: full double-black propagation missing

**Partial fix applied (2026-04-16):** Red-red violation from the split case is resolved and root black invariant is enforced. Full double-black propagation for black-height imbalances after arbitrary deletions remains a future work item.

### §6.1 — `query` vs `scan` boundary not enforced by types

The `query.*` namespace documents O(1)/O(log n) operations and `scan.*` documents O(n), but nothing prevents a caller from using `scan.*` inside a hot rendering loop. A lint rule or `@complexity` JSDoc tag on the `scan` namespace would help.

### §6.4 — Store conflates reconciliation scheduling and state mutation

`createDocumentStore` mixes reconciliation lifecycle (idle callbacks, viewport tracking) with state transitions. Extracting a `ReconciliationScheduler` object would make the store easier to test and allow swapping in a synchronous scheduler in tests without `reconcileMode: 'sync'` in config.

### §7.4 — No factory for `SelectionRange` in char-offset units

`store.selectionToCharOffsets` exists but `SET_SELECTION` accepts raw `SelectionRange[]` (byte offsets), which users commonly confuse with char offsets. A factory `position.selectionRange(charAnchor, charHead, state)` would guide users to the correct unit.

---

## From `code-analysis.md` (2026-05-25)

### §5.a — `deleteRange` is O(n) in pieces, not O(log n)

`src/store/core/piece-table.ts` — `pieceTableDelete` recurses the full tree when the deleted range spans many pieces, visiting every node in the overlapping subtrees. The cost annotation is correctly `LinearCost`, but callers unfamiliar with this may assume O(log n) delete parity with insert. Fixing this would require a different delete strategy (e.g. a split–join approach analogous to the join already used internally).

### §5.c — `removeChunkPiecesFromTree` red-leaf invariant is non-local

`src/store/features/reducer.ts` — the median-split rebuild colors leaf nodes red "so subsequent inserts have RB slack." This holds because a perfectly-balanced median split guarantees equal black-height on all root-to-null paths, so no consecutive reds are possible. The invariant depends on an implicit precondition (balanced input) that future maintainers may not notice when modifying the function. Consider a debug-mode assertion or a formal proof comment.

### §5.g — Background reconciliation always reads the live `state` closure

`src/store/features/store.ts` — the idle/timeout callback always reconciles `state` at the time it fires, not the state snapshot that existed when the callback was scheduled. This is deliberate (reconcile against the latest version), but a caller who schedules reconciliation and then checks `lineIndex.rebuildPending` on the snapshot they held may be surprised when the callback silently reconciles a newer state instead.

### §6.1 — Two `setValue` paths expose different performance profiles without guidance

`src/api/diff.ts` / `src/store/features/diff.ts` — `setValue` (O(n), single REPLACE) and `setValueWithDiff` (O(n²) Myers, minimal edits) are both top-level exports. No API-level guidance (docs, default parameter) steers callers to the right choice. A unified entry point with a `strategy` option would make the tradeoff explicit and discoverable.

### §6.2 — No "reconciliation ready" contract in the public API

External consumers must poll `lineIndex.rebuildPending` and call `reconcileNow()` manually to guarantee an eager `DocumentState<"eager">`. A `whenReconciled(): Promise<DocumentState<"eager">>` helper or a `"reconciled"` store event would make the lazy→eager transition ergonomic and would eliminate the polling pattern seen in tests.

### §6.4 — Chunk streaming API is imperative and easy to sequence incorrectly

Callers must dispatch `DECLARE_CHUNK_METADATA → LOAD_CHUNK → EVICT_CHUNK` in the right order, manage pinning manually, and track which chunks are currently loaded. A `StreamingDocumentLoader` class encapsulating the protocol (declare-on-start, auto-pin viewport window, auto-evict out-of-view) would drastically reduce misuse surface.

### §6.5 — No automatic add-buffer compaction

`src/store/core/piece-table.ts` — `compactAddBuffer` exists but is not wired into any automatic policy. In a long-lived document with many edits the add buffer grows unboundedly, increasing memory pressure and degrading `subtreeAddLength` statistics. A heuristic trigger (e.g. when `addLength / totalLength` exceeds a threshold) or an explicit user-facing `store.compact()` call would bound memory use.

### §8.2 — `buildCharToByteMap` lone-surrogate edge case has no test

`src/store/features/diff.ts` — for a string ending with a lone high surrogate the map entry at `str.length` records the lone-surrogate byte count (3 bytes). This matches what `textEncoder.encode` produces for the same input, so the behavior is consistent, but there is no dedicated test exercising this path. A round-trip test (`charToByteOffset` ↔ `byteToCharOffset` over a string with a lone surrogate) would prevent silent regressions.

---

## From `report/app/VimAppQuery-performance.md`

### `as unknown as` casts in `VimAppQuery.tsx`

Several Reed query results require double casts to extract values:

```ts
query.findLineAtCharPosition(state, activeCursor) as unknown as { lineNumber: number; charOffsetInLine: number } | null
query.getCharStartOffset(state, lineNum) as unknown as number
query.getLength(state.pieceTable) as unknown as number
position.rawByteOffset(head ?? position.ZERO_BYTE_OFFSET) // also used in UNDO_CURSOR_SYNC
```

These casts are needed because the Reed public API returns branded types. Providing unwrapped convenience overloads or explicit `toNumber()` accessors would eliminate the casts without removing the branded-type safety on the library side.

### `buildHtml` uses `t.split('\n')` — O(L) render pass

`buildHtml` still iterates all lines to produce HTML. This is inherently O(L) and cannot be improved without switching to a virtual/windowed renderer. Noted as a known future work item.
