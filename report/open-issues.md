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

---

## From `code-analysis.md` (2026-05-25)

### §5.a — `deleteRange` is O(n) in pieces, not O(log n)

`src/store/core/piece-table.ts` — `pieceTableDelete` recurses the full tree when the deleted range spans many pieces, visiting every node in the overlapping subtrees. The cost annotation is correctly `LinearCost`, but callers unfamiliar with this may assume O(log n) delete parity with insert. Fixing this would require a different delete strategy (e.g. a split–join approach analogous to the join already used internally).

### §6.4 — Chunk streaming API is imperative and easy to sequence incorrectly

Callers must dispatch `DECLARE_CHUNK_METADATA → LOAD_CHUNK → EVICT_CHUNK` in the right order, manage pinning manually, and track which chunks are currently loaded. A `StreamingDocumentLoader` class encapsulating the protocol (declare-on-start, auto-pin viewport window, auto-evict out-of-view) would drastically reduce misuse surface.

### §6.5 — No automatic add-buffer compaction

`src/store/core/piece-table.ts` — `compactAddBuffer` exists but is not wired into any automatic policy. In a long-lived document with many edits the add buffer grows unboundedly, increasing memory pressure and degrading `subtreeAddLength` statistics. A heuristic trigger (e.g. when `addLength / totalLength` exceeds a threshold) or an explicit user-facing `store.compact()` call would bound memory use.

---

## Fixed (2026-05-26)

| Issue | Fix |
|-------|-----|
| §8.2 — `buildCharToByteMap` lone-surrogate edge case has no test | Added two tests in `diff.test.ts`: a `setValue` smoke test documenting the `\uD800 → �` normalisation, and a `charToByteOffset ↔ byteToCharOffset` round-trip test over a lone-surrogate string. |
| §5.c — `removeChunkPiecesFromTree` red-leaf invariant is non-local | Strengthened the `buildTree` comment in `reducer.ts` with an explicit `PRECONDITION` note: the invariant holds only for a perfectly-balanced median split of the full survivor array; callers who filter or slice must re-verify. |
| §5.g — Background reconciliation always reads the live `state` closure | Added a block comment on the idle/timeout callback in `store.ts` explaining that `state` is the live closure variable and that callers must not check `lineIndex.rebuildPending` on a held snapshot after the callback fires. |
| §6.1 — Two `setValue` paths expose different performance profiles without guidance | Added `diff.setValueAuto(state, content, { strategy? })` as a unified entry point routing to `setValue` (O(n), default) or `setValueWithDiff` (O(n²)) via `options.strategy`. `SetValueOptions` type exported from `reed`. |
| §6.2 — No "reconciliation ready" contract in the public API | Added `whenReconciled(): Promise<DocumentState<"eager">>` to `ReconcilableDocumentStore` (interface + both store implementations). Resolves immediately when clean; otherwise subscribes and resolves on the next clean notification. |
| §7.4 — No factory for `SelectionRange` in char-offset units | Added `position.selectionRange(charAnchor, charHead, state)` factory in `api/position.ts`. Wraps `charOffsetsToSelection`; returns a byte-offset `SelectionRange` ready for `SET_SELECTION`. |
| `as unknown as` casts in `VimAppQuery.tsx` | Added `cost.$value<T>(costed)` helper to `types/cost-doc.ts` and `api/cost-doc.ts` (exported from `reed`). Replaced all Reed-related `as unknown as` casts in `VimAppQuery.tsx` with `cost.$value(...)`. |
