# Reed Formalization Analysis

**Date:** 2026-02-14

---

## 1. Data Structures

### 1.1 LineIndexState Construction Is Scattered

`LineIndexState` is constructed via inline `Object.freeze({ root, lineCount, dirtyRanges, ... })` in at least 18 locations across `line-index.ts`. Each construction site manually assembles the same 5-field object with subtly different values for `dirtyRanges`, `lastReconciledVersion`, and `rebuildPending`. This pattern invites inconsistency: some sites reset `lastReconciledVersion` to `0`, others preserve the existing value, others set it to `currentVersion` — with no structural enforcement of which is correct.

Contrast with `DocumentState`, which has `withState()` — a single point of construction that preserves structural sharing. `LineIndexState` lacks an equivalent. A `withLineIndexState(state, changes)` function would centralize this and make the variation points explicit.

### 1.2 `documentOffset: number | 'pending'`

`LineIndexNode.documentOffset` uses a union with a string literal. Every consumer must check `!== 'pending'` before arithmetic. This bleeds a lazy-evaluation concern into the data structure itself. A cleaner formalization would separate the "known offset" from the "pending" state — either via a boolean sentinel or by having reconciliation always produce concrete offsets and using the dirty-range system (which already exists) to indicate staleness.

### 1.3 `HistoryChange` Overloads a Single Type

`HistoryChange` uses `type: 'insert' | 'delete' | 'replace'` with an optional `oldText` field. The `oldText` field is only meaningful for `'replace'`, but TypeScript does not enforce this — it's a discriminated union in name but not in structure. A proper discriminated union (three interfaces with a shared base) would eliminate the `change.oldText ?? ''` pattern that appears in 4 call sites in `reducer.ts`.

### 1.4 `PieceTableState.addBuffer` Is a Mutable Backing Store

`PieceTableState` is declared `readonly` and frozen, but `addBuffer: Uint8Array` is a reference to a mutable typed array. `pieceTableInsert` writes to it in-place (`addBuffer.set(textBytes, addBufferLength)`). The correctness depends on `addBufferLength` in older snapshots acting as a boundary — bytes beyond it are "invisible." This is an implicit invariant with no structural enforcement. Anyone reading the `PieceTableState` interface at face value would assume immutability.

---

## 2. Interfaces

### 2.1 `withPieceNode` Accepts `Partial<PieceNode>` But Recomputes Aggregates

`withPieceNode(node, changes: Partial<PieceNode>)` accepts all fields including `subtreeLength` and `subtreeAddLength`, which are always recomputed from children. This means:
- A caller can pass `subtreeLength: 999` and it will be silently overwritten.
- The `'length' in changes` check controls recomputation, so passing `{ length: node.length }` (same value) triggers recomputation unnecessarily.

The update type should be narrowed to the fields that are actually settable: `color`, `left`, `right`, `start`, `length`, `bufferType`. The same issue applies to `withLineIndexNode`.

### 2.2 `LineIndexStrategy` Hides the Symmetry Between Eager and Lazy

`LineIndexStrategy` defines `insert` and `delete` as separate methods. But the eager and lazy implementations share a deeper structure: both perform (1) structural update (add/remove line nodes) and (2) offset maintenance (eager: immediate, lazy: deferred). This two-phase structure is implicit. If offset maintenance were a separate concern (e.g., a callback or a second strategy), the eager/lazy distinction would be localized to a single axis rather than duplicated across the full insert/delete surface.

### 2.3 `DocumentStore` Optional Methods Blur the Contract

`scheduleReconciliation`, `reconcileNow`, and `setViewport` are optional (`?`) on `DocumentStore`. Every consumer must null-check before calling. Since these methods are always present on the actual implementation (returned by `createDocumentStore`), the optionality is a lie at the implementation level. This suggests the interface is trying to serve two roles: the full store contract and a minimal external-facing API. These should be separate interfaces.

### 2.4 Store Events Adapter Binds Methods Incorrectly

In `createDocumentStoreWithEvents` (store.ts:432):

```ts
addEventListener: emitter.addEventListener.bind(emitter),
removeEventListener: emitter.removeEventListener.bind(emitter),
```

`createEventEmitter` returns an object literal — the methods are closures, not class methods. `.bind(emitter)` is a no-op (closures don't use `this`). It's harmless but signals a misunderstanding of the closure pattern, which could confuse readers into thinking `this` matters here.

---

## 3. Algorithms

### 3.1 Reducer `INSERT`/`DELETE`/`REPLACE` Share an Unstated Pipeline

The three text-editing cases in `documentReducer` follow the same implicit pipeline:

1. Validate position/range
2. Compute `nextVersion`
3. Capture text for undo (DELETE/REPLACE only)
4. Apply piece table mutation
5. Compute `insertedByteLength` (INSERT/REPLACE only)
6. Apply lazy line index update
7. Push to history
8. Mark dirty + bump version

This 8-step pipeline is repeated three times with slight variations, making it easy for a future edit to break symmetry. A formalized approach would extract the pipeline into a single function parameterized by the operation type, with the variations (step 3: capture text, step 5: compute byte length) as conditional branches within it, or decompose it into composable middleware-like transforms.

### 3.2 `applyChange` and `applyInverseChange` Are Duals but Not Formalized as Such

`applyChange` maps `insert → insert, delete → delete, replace → delete+insert`. `applyInverseChange` maps `insert → delete, delete → insert, replace → delete+insert (swapped)`. The duality is structural: `applyInverseChange(change)` is equivalent to `applyChange(invertChange(change))`. But `invertChange` doesn't exist as a function — the inversion is inlined into the switch cases. Extracting `invertChange: HistoryChange → HistoryChange` would eliminate `applyInverseChange` entirely and make the symmetry explicit.

### 3.3 Delete Range Fixes Red Violations but Not Black-Height

`mergeTrees` in piece-table.ts attaches the right tree as the right child of the leftmost node, then calls `fixRedViolations` walking up. This fixes red-red violations but does not address black-height imbalance. If the left tree has black-height 5 and the right tree has black-height 2, the result violates R-B invariants. The tree still functions as a BST, but degenerate cases could cause O(n) lookups over time.

### 3.4 `reconcileFull` Uses Two Strategies Without a Unifying Abstraction

`reconcileFull` checks `totalDirty <= threshold` to choose between:
- Incremental path: `reconcileRange` per dirty range (O(k log n))
- Full path: `reconcileInPlace` tree walk (O(n))

The threshold formula (`max(64, lineCount / log2(lineCount))`) is ad-hoc. More importantly, the two strategies have different structural effects: incremental updates individual nodes by line number, while the full path recomputes all offsets from accumulated lengths. They converge on the same result but via fundamentally different means. The "which path" decision is a policy concern that should be injectable or at least configurable, rather than hard-coded.

### 3.5 History Coalescing Mixes Policy with Mechanism

`canCoalesce` in `reducer.ts` combines three orthogonal checks: (1) timeout-based grouping (`Date.now() - lastEntry.timestamp > timeout`), (2) structural compatibility (`lastEntry.changes.length !== 1`), and (3) spatial contiguity (`newChange.position === last.position + last.byteLength`). These are distinct policies that could change independently. The `Date.now()` call makes the reducer non-deterministic, which breaks replay-ability — a concern explicitly mentioned in the action system's design ("serializable for debugging, time-travel, and collaboration").

---

## 4. Specific Implementations

### 4.1 `textEncoder.encode()` Is Called Redundantly Across the Pipeline

A single `INSERT` dispatch triggers:
1. `pieceTableInsert` → `textEncoder.encode(text)` for buffer append
2. `lineIndexInsertLazy` → `findNewlineBytePositions` → `textEncoder.encode(text)` for newline scanning
3. `historyPush` → stores `byteLength` (computed from `totalLength` diff, not from encoding, which is fine)
4. Event emission → `getAffectedRange` → `textEncoder.encode(action.text)` again

The same text is encoded at least twice, sometimes three times. This is not a "nice to have optimization" — for large pastes (e.g., 1MB), this doubles encoding work. A formalized data flow would encode once at the boundary (dispatch entry) and thread the result through.

### 4.2 Reducer Computes `insertedByteLength` Indirectly

For `INSERT` and `REPLACE`, the reducer computes byte length as `newState.pieceTable.totalLength - totalLengthBefore`. This works but is fragile — it depends on no other operation modifying `totalLength` between measurement points. The byte length is already known from `textEncoder.encode(text).length` (computed inside `pieceTableInsert`), but that value is not returned. The indirection obscures the data flow.

### 4.3 `getLineContent` Double-Calls `byteOffset()`

In rendering.ts:109:
```ts
const raw = getText(state.pieceTable, byteOffset(range.start) as ByteOffset, byteOffset(range.start + range.length) as ByteOffset);
```

`byteOffset()` already returns `ByteOffset`, so the `as ByteOffset` cast is redundant. More importantly, `range.start` is already a `number` from `getLineRange`, which lost its branding. The real issue is that `getLineRange` returns `{ start: number; length: number }` — unbranded. If it returned `{ start: ByteOffset; length: ByteLength }`, the downstream casts would be unnecessary and the type system would enforce correctness through the chain.

### 4.4 `createDocumentStoreWithEvents.batch()` Replays the Reducer

```ts
function batch(actions: DocumentAction[]): DocumentState {
  const prevState = baseStore.getSnapshot();
  const nextState = baseStore.batch(actions);
  if (nextState !== prevState) {
    let intermediateState = prevState;
    for (const action of actions) {
      const afterAction = documentReducer(intermediateState, action);
      // ...
      intermediateState = afterAction;
    }
  }
  return nextState;
}
```

The reducer is applied twice: once by `baseStore.batch()` and once by the event emission replay. The replay also uses `documentReducer` directly, bypassing the store's dispatch logic (no transaction handling, no reconciliation scheduling). If the reducer's behavior depends on store-level state (currently it doesn't, but it's a latent coupling), the replay would diverge from the actual execution.

### 4.5 `deserializeAction` Has No Validation Gate

```ts
export function deserializeAction(json: string): DocumentAction {
  const parsed = JSON.parse(json) as DocumentAction & { data?: string };
  // ...
  return parsed as DocumentAction;
}
```

The function uses `as` casts with no runtime validation, while `validateAction` and `isDocumentAction` exist specifically for this purpose. These were designed together but are not composed. A formalized pipeline would be: `parse → validate → return`, with `deserializeAction` calling `validateAction` internally and throwing on invalid input.

### 4.6 `selectionToCharOffsets` Reads From Document Start

```ts
export function selectionToCharOffsets(state: DocumentState, range: SelectionRange): CharSelectionRange {
  const maxByte = Math.max(range.anchor as number, range.head as number);
  const text = getText(state.pieceTable, byteOffset(0), byteOffset(maxByte));
  return Object.freeze({
    anchor: charOffset(byteToCharOffset(text, range.anchor)),
    head: charOffset(byteToCharOffset(text, range.head)),
  });
}
```

This reads from byte 0 to `maxByte` to convert two byte offsets to char offsets. For a selection at byte offset 50MB in a 100MB file, it reads 50MB of text into a string. The conversion only needs byte boundaries — it doesn't need the actual text content between them. A streaming byte-counting approach would avoid the allocation.

### 4.7 Line Index Eager vs Lazy Operations Are Parallel Code Paths

`lineIndexInsert` and `lineIndexInsertLazy` share ~80% of their logic (find affected line, split, insert new lines). The difference is:
- Eager: calls `updateOffsetsAfterLine` (O(n) offset update)
- Lazy: creates a `DirtyLineRange` and skips offset update

Similarly for delete. The shared logic is not factored out — it's duplicated across the two paths. This means any bug fix to the line-splitting logic must be applied twice, and the two paths can silently diverge.

### 4.8 Empty-Document Sentinel: `lineCount: 1` vs `root: null`

When the document is empty, `LineIndexState` has `lineCount: 1` but `root: null`. An empty document has one line (the empty line), but the tree has no nodes representing it. This means `findLineByNumber(root, 0)` returns `null` for an empty document, even though line 0 exists. Consumer code must special-case this (e.g., `getVisibleLines` checks `root === null` before iteration). The sentinel state is inconsistent — either `lineCount` should be `0` with no root, or `root` should contain a single zero-length node.

---

## Summary

The codebase's primary formalization gap is **pipeline regularity**. The same conceptual operation (text edit) flows through multiple subsystems (piece table, line index, history, metadata), but each subsystem is called ad-hoc in the reducer rather than through a composable pipeline. This creates:

- Duplicated code across `INSERT`/`DELETE`/`REPLACE` cases
- Duplicated code across eager/lazy line index paths
- Duplicated code across `applyChange`/`applyInverseChange`
- Redundant `textEncoder.encode()` calls across subsystems

The type system is well-used for branded types and discriminated unions but underused for:
- Constraining update types (`Partial<PieceNode>` is too wide)
- Branding return types from line index queries (`{ start: number }` loses brand)
- Enforcing the `HistoryChange` discriminated union structurally

The R-B tree formalization is strong (generic `RBNode<T>`, shared rotation/fix-up logic). The lazy reconciliation system is architecturally sound but has an inconsistent sentinel state for empty documents.
