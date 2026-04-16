# Reed Document Store — Core Invariants

This document captures the key invariants that must hold across the three main
data structures: the **piece table**, the **line index**, and the
**reconciliation lifecycle**. Violating any of these invariants can produce
silent data corruption, incorrect line-number lookups, or assertion failures at
mode boundaries (e.g., `asEagerLineIndex`).

---

## 1. Piece Table Invariants

The piece table is an immutable persistent Red-Black tree whose leaves
(`PieceNode`) reference contiguous byte ranges in one of three backing buffers:
`originalBuffer`, `addBuffer`, or a chunk map entry.

### 1.1 Subtree Aggregate Fields

Every `PieceNode` must satisfy:

```
node.subtreeLength === node.length
                     + (node.left?.subtreeLength  ?? 0)
                     + (node.right?.subtreeLength ?? 0)

node.subtreeAddLength === (node.bufferType === 'add' ? node.length : 0)
                        + (node.left?.subtreeAddLength  ?? 0)
                        + (node.right?.subtreeAddLength ?? 0)
```

These fields are recomputed automatically by `withPieceNode` whenever `left`,
`right`, or `length` changes. **Never mutate them directly.**

### 1.2 Red-Black Invariants

Standard RB-tree invariants hold after every structural operation:

- The root is always black.
- No red node has a red parent.
- Every path from root to null has the same number of black nodes
  (the *black-height* invariant).

`fixInsertWithPath` restores invariants after insertion.  
`fixRedViolations` restores the red-property after a right-spine graft (chunk
loading).

### 1.3 Immutability

All `PieceNode` values are frozen (`Object.freeze`). Tree operations return new
nodes with structural sharing; they never mutate existing nodes.

### 1.4 Chunk Piece Ordering

Chunk pieces are ordered by `chunkIndex` in in-order traversal. This ensures
that `findReloadInsertionPos` (an O(n) walk) can locate the correct insertion
point for re-loaded chunks.

---

## 2. Line Index Invariants

The line index is an immutable Red-Black tree of `LineIndexNode` values.  
It can be in one of two evaluation modes:

| Mode | `documentOffset` | `dirtyRanges` | `rebuildPending` |
|------|-----------------|---------------|-----------------|
| `'eager'` | Always `number` (accurate byte offset) | Empty array `[]` | `false` |
| `'lazy'`  | May be `null` (offset not yet computed) | Non-empty; describes pending corrections | `true` |

### 2.1 `subtreeByteLength` Is Always Accurate

`node.subtreeByteLength` is the sum of `lineLength` for all nodes in the
subtree. It is updated by `withLineIndexNode` on every structural change and
is **never** marked dirty. Callers may rely on it for O(log n) byte-offset
arithmetic even in lazy mode.

### 2.2 `subtreeLineCount` Is Always Accurate

`node.subtreeLineCount` equals `1 + left.subtreeLineCount + right.subtreeLineCount`.
Accurate in both modes; used for O(log n) line-number lookups.

### 2.3 `documentOffset` in Eager Mode

In eager mode every node's `documentOffset` equals the byte offset of the
first byte of that line in the document. Specifically:

```
node.documentOffset === sum of lineLength for all lines before this line
```

`asEagerLineIndex` throws if `dirtyRanges.length !== 0 || rebuildPending`.
Call it only after reconciliation is complete.

### 2.4 `documentOffset` in Lazy Mode

After an insert or delete, lines downstream of the edit have stale
`documentOffset` values. The correct offset for line `L` is:

```
correct_offset(L) = node.documentOffset + sum of offsetDelta for all dirty
                    ranges that contain line L
```

`getOffsetDeltaForLine` computes this delta in O(K) time (K = number of dirty
ranges, ≤ 32 by default).

### 2.5 `lineLength` Is Always Accurate

`node.lineLength` is the byte length of the line **including** its trailing
newline (if any). It is updated eagerly by `lineIndexInsert` / `lineIndexDelete`
and never requires reconciliation.

### 2.6 `lineCount` Is Always Accurate

`state.lineCount` equals the number of logical lines in the document (always
≥ 1, since an empty document has one empty line). Updated eagerly on every
insert/delete.

---

## 3. Reconciliation Lifecycle Invariants

### 3.1 `rebuildPending` → Dirty Ranges Exist

`rebuildPending === true` if and only if `dirtyRanges.length > 0`.  
Both are reset to `false` / `[]` together by `toEagerLineIndexState`.

### 3.2 `lastReconciledVersion` Monotonicity

`state.lastReconciledVersion` is set to `state.version` at the time of
reconciliation. It never decreases. A stale version indicates that subsequent
edits have made the line index dirty again.

### 3.3 Dirty Range Merge Rules

`mergeDirtyRanges` maintains the following post-conditions:

- Result contains no overlapping ranges.
- Ranges are sorted by `startLine` ascending.
- If the number of merged ranges exceeds `maxDirtyRanges` (default 32), the
  entire result is collapsed to a single sentinel `{ kind: 'sentinel' }`.
- A sentinel input propagates to a sentinel output (no partial merging).

### 3.4 Sentinel Means Full Rebuild Required

When `dirtyRanges` contains a sentinel, the individual `offsetDelta` values
have been discarded. Only `reconcileFull` (slow path: `reconcileInPlace`) can
recover from this state. `reconcileRange` skips sentinel entries.

### 3.5 `reconcileRange` Is Idempotent on Non-Overlapping Windows

Calling `reconcileRange(state, a, b)` twice on the same state is equivalent to
calling it once, because the second call finds no dirty ranges in `[a, b]`.

### 3.6 `reconcileFull` Always Produces Eager State

`reconcileFull` always returns a `LineIndexState<'eager'>` regardless of its
input mode. After the call `dirtyRanges === []` and `rebuildPending === false`.

### 3.7 `rebuildLineIndex` Preserves `maxDirtyRanges`

`rebuildLineIndex(content)` creates a fresh state with default
`maxDirtyRanges: 32`. Any caller that rebuilds the tree must restore the
configured value from the previous state:

```ts
const rebuiltWithConfig = withLineIndexState(rebuilt, {
  maxDirtyRanges: state.lineIndex.maxDirtyRanges,
});
```

See `rebuildLineIndexFromPieceTableState` in `edit.ts`.

---

## 4. HistoryChange Byte-Length Invariant

Every `HistoryInsertChange`, `HistoryDeleteChange`, and `HistoryReplaceChange`
must satisfy:

```
change.byteLength === textEncoder.encode(change.text).byteLength
change.oldByteLength === textEncoder.encode(change.oldText).byteLength  // replace only
```

This invariant is enforced at construction time by `makeInsertChange`,
`makeDeleteChange`, and `makeReplaceChange` in `edit.ts`. Do not construct
`HistoryChange` objects with inline object literals.

---

## 5. Version Invariants

`state.version` increments by exactly 1 on every action that modifies document
content or selection. `reconcileNow` does **not** bump the version — it only
reconciles the line index in place, leaving the rest of the state unchanged.

The `lineIndex.lastReconciledVersion` field is set to the state version at
reconciliation time, not to the version after reconciliation. Callers should
compare `lineIndex.lastReconciledVersion < state.version` to detect whether
the index is stale.
