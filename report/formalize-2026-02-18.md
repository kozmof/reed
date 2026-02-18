# Formalization Report — Reed

Date: 2026-02-18

---

## 1. Data Structures

### 1.1 Branded types escape through `as number` casts

[branded.ts](src/types/branded.ts) establishes `ByteOffset`, `ByteLength`, `CharOffset` etc. as compile-time brands. However, 16+ call sites strip the brand with `as number`:

- [rendering.ts:109](src/store/features/rendering.ts#L109) — `range.length as number`
- [rendering.ts:365](src/store/features/rendering.ts#L365) — `position as number`
- [rendering.ts:445-446](src/store/features/rendering.ts#L445-L446) — `range.anchor as number`, `range.head as number`
- [reducer.ts:526](src/store/features/reducer.ts#L526) — `op.deleteEnd as number` - `op.position as number`
- [line-index.ts:415](src/store/core/line-index.ts#L415) — `position as number`
- [piece-table.ts:1018](src/store/core/piece-table.ts#L1018) — `piece.start as number`

This systematically defeats the branded type contract. When `ByteLength` is routinely cast away to pass into `addByteOffset`, the brand provides no safety beyond the original constructor call. Consider:

- Adding `addByteOffset(offset, length: ByteLength)` overloads so the caller never needs to cast.
- Introducing a `byteEnd(start: ByteOffset, length: ByteLength): ByteOffset` helper for the recurring `start + length` pattern, eliminating the five identical `addByteOffset(range.start, range.length as number)` sites in rendering.ts.
- Replacing `ByteLength` with a type whose arithmetic is defined against `ByteOffset` rather than `number`.

### 1.2 `LineIndexNode.documentOffset: number | null` conflates two modes

The nullable `documentOffset` field serves double duty: `null` means "lazy/pending" and a `number` means "known". This is the mechanism that `EvaluationMode` is supposed to formalize at the *state* level, but the node-level type doesn't participate:

```typescript
// Every node has the same type regardless of mode
readonly documentOffset: number | null;
```

A first-time reader might not realize that `null` is a semantic invariant (lazy mode) rather than an error state. The `LineIndexState<M>` generic narrows `dirtyRanges` and `rebuildPending` but leaves nodes unparameterized, so the modal guarantee cannot be enforced structurally.

### 1.3 `PieceNode.subtreeLength` is `number`, not `ByteLength`

`PieceNode.length` is branded `ByteLength`, but `subtreeLength` and `subtreeAddLength` are plain `number`. This creates an asymmetry: leaf data is branded, aggregate data is not. Since `subtreeLength` is used directly in position arithmetic (e.g., `findPieceAtPosition`), the brand boundary is inconsistent.

### 1.4 `GrowableBuffer.append` mutates the shared backing array

[growable-buffer.ts:41](src/store/core/growable-buffer.ts#L41) — `bytes.set(data, this.length)` writes into the same `Uint8Array` that earlier snapshots reference. The comment says "old snapshots safely ignore bytes beyond their own `length` boundary", but this relies on a caller convention (never read past `length`) that no type enforces. A new `GrowableBuffer` after `append` shares the backing array with the previous instance when capacity suffices — if any consumer reads `bytes.length` instead of `length`, they see uncommitted data. This is correct by discipline but fragile by construction.

---

## 2. Interfaces

### 2.1 `LineIndexStrategy` accepts `LineIndexState` (union) but returns `LineIndexState<M>`

```typescript
export interface LineIndexStrategy<M extends EvaluationMode = EvaluationMode> {
  insert(state: LineIndexState, ...): LineIndexState<M>;
  delete(state: LineIndexState, ...): LineIndexState<M>;
}
```

The input is the *unparameterized* union, so a caller can pass lazy state into an eager strategy or vice versa. The strategy then returns `LineIndexState<M>`, creating a mode transition that is invisible at the call site. The input should be `LineIndexState<M>` or explicitly `LineIndexState<EvaluationMode>` with documented semantics for cross-mode calls.

### 2.2 `ReadTextFn` is optional but silently degrades charLength computation

`readText?: ReadTextFn` is threaded through `lineIndexInsert`, `insertLinesAtPosition`, and lazy variants. When absent, `charsBefore` is `undefined` and `charLength` falls back to `0`:

```typescript
// line-index.ts:572
const firstLineCharLength = hasCharInfo ? charsBefore! + charPositions[0] + 1 : undefined;
```

This means the `subtreeCharLength` aggregates silently accumulate zeros when `readText` is not provided, making `getCharStartOffset` and `findLineAtCharPosition` return wrong answers without any error signal.

### 2.3 `DocumentStore.batch` and `DocumentStoreWithEvents.batch` have different semantics

`DocumentStore.batch` (from `createDocumentStore`) wraps actions in a single transaction using `dispatch({ type: 'TRANSACTION_START' })`.
`DocumentStoreWithEvents.batch` does the same but calls the event-emitting `dispatch` for each inner action, so events fire *during* the transaction for each action. There is no interface-level indication that `batch` in the event store fires per-action events while the base store fires none.

---

## 3. Algorithms

### 3.1 `deleteRange` rebuilds without R-B rebalancing

[piece-table.ts:493-581](src/store/core/piece-table.ts#L493-L581) — The `deleteRange` function recursively rebuilds the tree for deletion by modifying nodes in-place (structurally), calling `withPieceNode` with adjusted children. When a piece is fully deleted, `mergeTrees` is invoked. However, the rebuilt tree after `deleteRange` is *not* R-B balanced: pieces are trimmed or removed, new nodes are introduced with `'red'` color (line 555), and `splitPiece`-style constructions attach right children directly without rotation. After multiple deletes, the tree's balance degrades.

Compare this with line-index's `rbDeleteLineByNumber` which does proper R-B deletion with `fixDeleteViolations`. The piece table lacks an equivalent, relying on `mergeTrees`/`joinByBlackHeight` for the merge-after-removal case but not for the trim case.

### 3.2 `reconcileRange` is O(k * log n) per dirty line but iterates dirty ranges linearly

```typescript
// line-index.ts:1548
for (let line = startLine; line <= endLine && line < state.lineCount; line++) {
  const delta = getOffsetDeltaForLine(state.dirtyRanges, line);
  ...
}
```

`getOffsetDeltaForLine` scans all dirty ranges for each line. For `k` dirty lines and `r` dirty ranges, this is O(k * r) rather than O(k * log r) or O(k + r). With the 32-range safety cap, `r` is bounded, but the linear scan per line is unnecessary when ranges are sorted.

### 3.3 `diff` operates on UTF-16 code units, actions operate on bytes

`diff()` and `simpleDiff()` compare characters (UTF-16 code units), producing `DiffEdit` with `oldPos`/`newPos` in character indices. `computeSetValueActions` then converts these to byte offsets via `stringIndexToByteIndex`. The separation works but means the diff is computed in one coordinate system and results are translated into another, with `stringIndexToByteIndex` re-encoding the prefix for every operation — O(n) per conversion, O(n * d) total for d diff operations.

### 3.4 History coalescing uses strict contiguity check

```typescript
// reducer.ts:194
case 'insert':
  return newChange.position === last.position + last.byteLength;
```

The contiguity check compares byte positions, but `position` is `ByteOffset` (branded). The comparison `newChange.position === last.position + last.byteLength` mixes `ByteOffset + number` arithmetic without going through `addByteOffset`. This happens to work because branded types are erased at runtime, but it contradicts the branded type contract established in branded.ts.

---

## 4. Specific Implementations

### 4.1 `updateLineAtNumber` uses `any` to conditionally set `charLength`

[line-index.ts:677](src/store/core/line-index.ts#L677):

```typescript
const updates: any = { lineLength: newLength };
if (newCharLength !== undefined) updates.charLength = newCharLength;
return withLineIndexNode(node, updates);
```

`withLineIndexNode` accepts `LineIndexNodeUpdates` (a `Partial<Pick<...>>`). The `any` cast bypasses the type-safe update contract. This can be replaced with a conditional spread:

```typescript
return withLineIndexNode(node, {
  lineLength: newLength,
  ...(newCharLength !== undefined && { charLength: newCharLength }),
});
```

### 4.2 `compactAddBuffer` uses `piece.start as number` and `piece.length as number`

[piece-table.ts:1018](src/store/core/piece-table.ts#L1018):

```typescript
state.addBuffer.subarray(piece.start as number, (piece.start as number) + (piece.length as number))
```

`GrowableBuffer.subarray` accepts `number`, but `piece.start` is `ByteOffset` and `piece.length` is `ByteLength`. The casts are needed because `GrowableBuffer` doesn't accept branded types. Either `GrowableBuffer.subarray` should accept `ByteOffset`/`ByteLength`, or a dedicated accessor should exist for branded access.

### 4.3 `createDocumentStoreWithEvents.batch` duplicates transaction logic

[store.ts:404-425](src/store/features/store.ts#L404-L425) reimplements the try/finally transaction pattern that already exists in the base store's `batch`. The event store calls `baseStore.dispatch({ type: 'TRANSACTION_START' })` directly, then loops with its own `dispatch`, then commits/rollbacks. If the base store's `batch` logic changes (e.g., adding retry or validation), the event store's copy diverges silently. This should delegate to a shared transaction-scoping primitive.

### 4.4 `reconcileNow` bumps `version` for a non-content-changing operation

[store.ts:267-276](src/store/features/store.ts#L267-L276):

```typescript
const nextVersion = state.version + 1;
const newLineIndex = reconcileFull(state.lineIndex, nextVersion);
state = Object.freeze({ ...state, lineIndex: newLineIndex, version: nextVersion });
```

Reconciliation corrects internal bookkeeping (line offsets) without changing document content, yet it increments `version`. Any subscriber using `version` for content-change detection (e.g., collaboration or save-dirty tracking) will see a phantom change. The comment says "don't notify listeners", acknowledging this is not a user-visible change, but the version increment contradicts that intent.

### 4.5 Reducer's `APPLY_REMOTE` duplicates the edit pipeline

[reducer.ts:626-648](src/store/features/reducer.ts#L626-L648) — The remote change handler manually calls `pieceTableInsert`, `getText`, `pieceTableDelete`, and `lazyLineIndex.insert/delete` in sequence. This duplicates the logic in `applyEdit` (which handles the same insert/delete/history pipeline for local edits). The difference is that remote changes skip history. A cleaner factoring would let `applyEdit` accept an option to skip history rather than duplicating the pipeline.

### 4.6 `withState` and `withLineIndexState` don't enforce narrowing

```typescript
export function withState(state: DocumentState, changes: Partial<DocumentState>): DocumentState { ... }
export function withLineIndexState(state: LineIndexState, changes: Partial<LineIndexState>): LineIndexState { ... }
```

These accept `Partial<T>` which includes *any* field of the state, including computed/derived ones like `version` or `lineCount`. A misspelled or wrong-typed field in `changes` will silently override. Consider constraining the `changes` parameter to only settable fields (similar to how `PieceNodeUpdates` restricts `withPieceNode`).

---

## Summary of Areas Most Likely to Become Fragile

1. **Branded type erosion** — The `as number` casts throughout rendering.ts and reducer.ts will proliferate as new code is added, gradually making the brand system decorative rather than protective.

2. **Lazy/eager mode boundary** — The `LineIndexState<M>` parameterization is well-designed at the state level but not enforced at the node level or the strategy interface input, creating a gap where mode violations can slip through.

3. **Piece table delete rebalancing** — The `deleteRange` function produces structurally correct but potentially unbalanced trees. For documents with heavy edit-delete cycles, tree height may grow beyond O(log n).

4. **Event store batch duplication** — The parallel transaction implementation in `createDocumentStoreWithEvents.batch` is a maintenance risk that will diverge from the base store over time.

5. **Version semantics** — Using a single monotonic counter for both content changes and internal bookkeeping conflates two concerns, which will become problematic when features depend on "content version" vs "state version".
