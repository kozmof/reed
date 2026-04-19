# Open Issues

Collected from all reports in `report/`. Fixed items are excluded.

---

## From `code-analyze-2026-04-16.md`

### §5.1-a — `APPLY_REMOTE` `affectedRanges` correctness unverified

The event emitter in `store.ts:createDocumentStoreWithEvents` emits for `APPLY_REMOTE`, but SPEC.md flags that the `affectedRanges` field may be incorrect for a full multi-change batch. No test covers this case.

### §5.1-b — `batch()` reconciliation scheduling needs re-verification

The spec warns that `TRANSACTION_COMMIT` may not schedule reconciliation when `rebuildPending` remains true. The code at `store.ts:191` appears to handle this, but the warning may refer to older code. A test is needed.

### §5.1-c — Lazy line-index precision before reconciliation

`documentOffset` can be `null` for lines updated in lazy mode. Any caller that passes a lazy `DocumentState` (not `DocumentState<'eager'>`) to functions requiring precise offsets (e.g. `getLineRange`) will get a runtime error or silently wrong data. No guard or type-level enforcement exists.

### §5.2 / §8.1 — `deleteRange`: full double-black propagation missing

**Partial fix applied (2026-04-16):** Red-red violation from the split case is resolved and root black invariant is enforced. Full double-black propagation for black-height imbalances after arbitrary deletions remains a future work item.

### §6.1 — `query` vs `scan` boundary not enforced by types

The `query.*` namespace documents O(1)/O(log n) operations and `scan.*` documents O(n), but nothing prevents a caller from using `scan.*` inside a hot rendering loop. A lint rule or `@complexity` JSDoc tag on the `scan` namespace would help.

### §6.4 — Store conflates reconciliation scheduling and state mutation

`createDocumentStore` mixes reconciliation lifecycle (idle callbacks, viewport tracking) with state transitions. Extracting a `ReconciliationScheduler` object would make the store easier to test and allow swapping in a synchronous scheduler in tests without `reconcileMode: 'sync'` in config.

### §7.3 — `reconcileMode` default undocumented in the interface

`DocumentStoreConfig` declares `reconcileMode?: 'idle' | 'sync' | 'none'` without a `@default` tag. The actual default is applied in `createDocumentStore` at `config.reconcileMode ?? 'idle'`. Adding `@default 'idle'` to the interface would surface the default in IDE hover.

### §7.4 — No factory for `SelectionRange` in char-offset units

`store.selectionToCharOffsets` exists but `SET_SELECTION` accepts raw `SelectionRange[]` (byte offsets), which users commonly confuse with char offsets. A factory `position.selectionRange(charAnchor, charHead, state)` would guide users to the correct unit.

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
