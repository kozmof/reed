# Reed document store invariants

These invariants keep the piece table, line index, and reconciliation lifecycle
consistent. A violation can corrupt data, break line-number lookups, or trigger
an assertion at a mode boundary such as `asEagerLineIndex`.

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
`right`, or `length` changes. Never mutate them directly.

### 1.2 Red-Black Invariants

Standard RB-tree invariants hold after every structural operation:

- The root is always black.
- No red node has a red parent.
- Every path from root to null has the same number of black nodes
  (the black-height invariant).

`fixInsertWithPath` restores invariants after insertion.  
`fixRedViolations` restores the red-property after a right-spine graft (chunk
loading).

### 1.3 Immutability

All `PieceNode` values are frozen (`Object.freeze`). Tree operations return new
nodes with structural sharing and never mutate existing nodes.

### 1.4 Chunk Piece Ordering

Chunk pieces are ordered by `chunkIndex` in in-order traversal. This ensures
that `findReloadInsertionPos` (an O(n) walk) can locate the correct insertion
point for re-loaded chunks.

### 1.5 UTF-8 boundaries

Every edit range, stored selection, and store-managed attention endpoint must fall on a UTF-8 code-point boundary. The reducer checks these positions before changing state. `query.getText` applies the same rule to bounded public reads.

Use `query.isUtf8Boundary` when a byte position comes from an external source. Rendering conversions return `null` or throw `RangeError` when a byte position splits an encoded code point.

Low-level piece-table and caller-owned attention helpers operate on trusted positions. Validate their offsets at the public boundary before calling them.

---

## 2. Line Index Invariants

The line index is an immutable Red-Black tree of `LineIndexNode` values.  
It can be in one of two evaluation modes:

| Mode      | `documentOffset`                        | `dirtyRanges`                            | `rebuildPending` |
| --------- | --------------------------------------- | ---------------------------------------- | ---------------- |
| `'eager'` | Always `number` (accurate byte offset)  | Empty array `[]`                         | `false`          |
| `'lazy'`  | May be `null` (offset not yet computed) | Non-empty; describes pending corrections | `true`           |

### 2.1 `subtreeByteLength` Is Always Accurate

`node.subtreeByteLength` is the sum of `lineLength` for all nodes in the
subtree. It is updated by `withLineIndexNode` on every structural change and
is never marked dirty. Callers may rely on it for O(log n) byte-offset
arithmetic even in lazy mode.

### 2.2 `subtreeLineCount` Is Always Accurate

`node.subtreeLineCount` equals `1 + left.subtreeLineCount + right.subtreeLineCount`.
It is accurate in both modes and is used for O(log n) line-number lookups.

#### Tree height

Small multiline deletions use persistent red-black deletion, while large range
removals rebuild the retained lines once. Both paths preserve red-black
invariants. Insertion does the same, so line-index navigation is O(log n).

#### Unloaded line-count cache

`lineIndex.unloadedLineCount` equals the sum of
`unloadedLineCountsByChunk.values()`. Only `withLineIndexState` may replace the
per-chunk map, and it recomputes this aggregate so `getLineCountFromIndex`
remains O(1).

### 2.3 `documentOffset` in Eager Mode

In eager mode every node's `documentOffset` equals the byte offset of the
first byte of that line in the document. Specifically:

```
node.documentOffset === sum of lineLength for all lines before this line
```

`asEagerLineIndex` throws if `dirtyRanges.length !== 0 || rebuildPending`.
Call it only after reconciliation is complete.

`documentOffset` is a cache, not the source of truth. Reads derive offsets from
`subtreeByteLength` through `getLineStartOffset`, which is exact in both modes
(2.1). Reconciliation maintains the cache by deriving each repaired line's offset
from the same aggregates, so a repair does not depend on the recorded delta being
right, and a line inserted with a null offset gets a real one.

Maintaining the cache requires that every edit which moves later lines either
updates their offsets or records a dirty range describing the move. An edit that
does neither strands them, because reconciliation only visits lines a dirty range
covers.

#### Eager offset maintenance

`eagerStrategy` is used by undo and redo. Newline-free changes update the edited
line and shift every later cached offset in the same transition. This costs O(n)
in the number of downstream lines and preserves the eager-state contract.

### 2.4 `documentOffset` in Lazy Mode

After an insert or delete, lines downstream of the edit have stale
`documentOffset` values, and a dirty range records the move. This holds for
newline-free edits too, which change no line count and so are easy to mistake for
pure length updates. The correct offset for line `L` is:

```
correct_offset(L) = node.documentOffset + sum of offsetDelta for all dirty
                    ranges that contain line L
```

`getOffsetDeltaForLine` computes this delta in O(K) time (K = number of dirty
ranges, ≤ 32 by default).

### 2.5 `lineLength` Is Always Accurate

`node.lineLength` is the byte length of the line, including its trailing
newline (if any). It is updated eagerly by `lineIndexInsert` / `lineIndexDelete`
and never requires reconciliation.

### 2.6 `lineCount` Is Always Accurate

`state.lineCount` equals the number of logical lines in the document (always
≥ 1, since an empty document has one empty line). Updated eagerly on every
insert/delete.

---

## 3. Reconciliation Lifecycle Invariants

### 3.1 `rebuildPending` → Dirty Ranges Exist

`rebuildPending === true` if and only if `dirtyRanges` is
`"full-rebuild-needed"` or is a non-empty array. Both are reset to `false` /
`[]` together by `toEagerLineIndexState`.

### 3.2 `lastReconciledRevision` Monotonicity

`state.lastReconciledRevision` is set to `state.revision` at the time of
reconciliation. It never decreases. A stale revision indicates that subsequent
edits have made the line index dirty again.

### 3.3 Dirty Range Merge Rules

`mergeDirtyRanges` maintains the following post-conditions:

- Result contains no overlapping ranges.
- Ranges are sorted by `startLine` ascending.
- If the number of merged ranges exceeds `maxDirtyRanges` (default 32), the
  entire result is collapsed to the list-level sentinel
  `"full-rebuild-needed"`.
- A sentinel input propagates to a sentinel output (no partial merging).

### 3.4 Sentinel Means Full Rebuild Required

When `dirtyRanges === "full-rebuild-needed"`, the individual `offsetDelta`
values have been discarded. Only `reconcileFull` (slow path:
`reconcileInPlace`) can recover from this state. Incremental range
reconciliation leaves the sentinel unchanged.

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

## 5. Revision Semantics

This section is the single source of truth for the three monotonic counters on
`DocumentState`. Other docs and JSDoc point here rather than restating the rules.

### 5.1 `revision` — global state revision

`state.revision` is a global state revision, not a content version. It
increments by exactly 1 on every state-changing action:

- content edits — `INSERT`, `DELETE`, `REPLACE`, `APPLY_REMOTE`
- `SET_SELECTION`
- `HISTORY_CLEAR`, `UNDO`, `REDO`
- `LOAD_CHUNK`, `EVICT_CHUNK`

Because it moves on selection and history actions too, `revision` alone cannot
tell you that content changed. To detect a content change, compare piece-table
reference identity: `state.pieceTable === prev.pieceTable` (O(1) via structural
sharing) holds whenever content is unchanged.

### 5.2 Content-neutral operations MUST NOT increment `revision`

Some operations produce a new immutable state reference (so subscribers fire) but
are content-neutral and MUST NOT increment `revision`, so they are never
misread as content edits:

- reconciliation (`reconcileNow` / `getEagerSnapshot`) — resolves line offsets
  in place, leaving the visible text unchanged
- `CREATE_ATTENTION` / `DELETE_ATTENTION` — mutate the piece-anchored reference
  layer only
- `DECLARE_CHUNK_METADATA` — registers line counts for unloaded chunks

Canonical wording for such operations: "content-neutral: produces a new immutable
state reference but MUST NOT increment `revision`."

### 5.3 `selectionRevision`

Increments only on `SET_SELECTION`. Inline selections carried by a content edit do
not move it. It strictly tracks `SET_SELECTION` dispatches.

### 5.4 `lineIndex.lastReconciledRevision`

Set to `state.revision` at reconciliation time, the revision before reconcile
rather than after, because reconciliation does not increment `revision`. It never
decreases.
Compare `lineIndex.lastReconciledRevision < state.revision` to detect a stale
index.

---

## 5. Checkpoint Restore Invariants

A checkpoint is untrusted input. `restoreCheckpoint` assembles no state until the payload has
been shown to satisfy the invariants above, and raises `CheckpointError` otherwise.

### 5.1 Aggregates and Offsets Are Rebuilt, Not Read

Restore stores no subtree aggregate and no line byte offset. Both trees are bulk-loaded through
`createPieceNode`, `createChunkPieceNode`, and `createLineIndexNode`, which recompute every
aggregate from the children, and line offsets are recomputed as prefix sums of the line
lengths. Invariants 1.1, 2.1, 2.2, and 2.3 therefore hold by construction on a restored state.

Bulk loading uses median-split recursion with the deepest real nodes colored red, so invariant
1.2 holds as well. Tree topology is not preserved across a round trip, and nothing depends on
it, since attention anchors to `PieceID` rather than to tree shape.

### 5.2 Checked Before Assembly

- every piece range lies inside the buffer it names, and chunk pieces name a chunk present in the payload
- chunk pieces appear in ascending `chunkIndex` order, as invariant 1.4 requires
- piece lengths sum to `totalLength`, and line lengths cover the same span
- no duplicate piece id and no duplicate attention id
- every attention point names a piece in the payload with a boundary inside that piece

### 5.3 Allocator Cursors Stay Ahead of Live Identities

`pieceTable.nextPieceID` exceeds every `p<n>` identity in the payload, and
`attention.nextID` exceeds every `a<n>` identity. Without this, the first edit after restore
would mint an id that is already anchored. Identities that do not match those patterns are
opaque and place no constraint on the allocator.

### 5.4 History Byte Lengths Are Derived

Restore recomputes `byteLength` and `oldByteLength` from their strings rather than reading
them, so invariant 4 cannot be violated by an edited payload.

History selections are checked for shape but not against the current document length. An undo
entry describes an older revision, so its offsets may legitimately sit past the end of the
document as it stands now.
