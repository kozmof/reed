# Piece Table Internals

## 1. Overview

The piece table stores document content as a Red-Black tree of lightweight _piece nodes_.
Each node does not hold text directly — it holds a `(bufferType, start, length)` window
into one of two backing byte buffers:

- `originalBuffer: Uint8Array` — immutable, loaded once from the initial content string.
- `addBuffer: GrowableBuffer` — append-only, grows as the user edits.

Reading the full document means performing an in-order traversal of the tree and
concatenating the byte ranges each piece points to.

---

## 2. `addBuffer` Layout

`addBuffer` is a **flat, append-only byte array**. Bytes are written in edit-chronological
order, not document order.

Every insertion — regardless of where in the document it appears — appends to the end:

```
Edit sequence:
  1. Insert "Hello" at line 1  → addBuffer: [Hello]
  2. Insert "world" at line 4  → addBuffer: [Helloworld]
  3. Insert "!!" at line 8     → addBuffer: [Helloworld!!]

Pieces in tree (logical doc order):
  AddPieceNode { start:0,  length:5 }  → "Hello"
  AddPieceNode { start:5,  length:5 }  → "world"
  AddPieceNode { start:10, length:2 }  → "!!"
```

The tree's in-order traversal reconstructs the correct document even though buffer
bytes are ordered by edit time, not document position.

### 2.1 Multiple text chunks accumulated over edits

Because every edit appends, `addBuffer` ends up as a **concatenation of all inserted
text in edit order**, with no delimiters or alignment between them. Each `AddPieceNode`
in the tree holds a `(start, length)` window that picks out exactly its own chunk.

Extended example — five edits at scattered document positions:

```
Edit 1: insert "Line1\n"   at doc offset 0
Edit 2: insert "Line4\n"   at doc offset 18   (somewhere later in the doc)
Edit 3: insert "Line3\n"   at doc offset 12
Edit 4: insert "fix"       at doc offset 3    (correction inside Edit 1's text)
Edit 5: insert "Line8\n"   at doc offset 40

addBuffer bytes (flat, edit order):
  offset  0 : L i n e 1 \n          ← Edit 1  (6 bytes)
  offset  6 : L i n e 4 \n          ← Edit 2  (6 bytes)
  offset 12 : L i n e 3 \n          ← Edit 3  (6 bytes)
  offset 18 : f i x                 ← Edit 4  (3 bytes)
  offset 21 : L i n e 8 \n          ← Edit 5  (6 bytes)
```

The corresponding `AddPieceNode`s — wherever they sit in the RB-tree — point into
those ranges:

```
AddPieceNode { start: 0,  length: 6 }  → "Line1\n"
AddPieceNode { start: 6,  length: 6 }  → "Line4\n"
AddPieceNode { start: 12, length: 6 }  → "Line3\n"
AddPieceNode { start: 18, length: 3 }  → "fix"
AddPieceNode { start: 21, length: 6 }  → "Line8\n"
```

The tree's in-order traversal visits these nodes in **document order** (which may be
entirely different from the 0 → 6 → 12 → 18 → 21 physical order above) and emits the
correct document text.

A mid-piece insertion (§3) can also slice an existing add-buffer chunk. For example, if
Edit 4 lands inside the "Line1\n" piece at offset 4, `splitPiece` leaves two
`AddPieceNode`s pointing to the original chunk plus one new node pointing to the "fix"
bytes — all referencing the same `addBuffer`, no data copied:

```
addBuffer (unchanged):
  [L][i][n][e][1][\n][L][i][n][e][4][\n]…[f][i][x]…
   0  1  2  3  4   5   6 …                18 19 20

Three pieces now covering the original "Line1\n" region (doc order):
  AddPieceNode { start:0,  length:4 }  → "Line"     (left of split)
  AddPieceNode { start:18, length:3 }  → "fix"      (newly inserted)
  AddPieceNode { start:4,  length:2 }  → "1\n"      (right of split)
```

### 2.2 Capacity growth

`GrowableBuffer.append()` returns a new `GrowableBuffer` instance. When the backing
`Uint8Array` has spare capacity, the new instance **shares the same array** — no
reallocation occurs. When capacity is exceeded the array is reallocated at
`max(currentSize × 2, currentSize + newDataSize)`, amortising growth to O(1) per byte.

### 2.2 Snapshot safety

Old `PieceTableState` snapshots (e.g. undo-stack entries) hold a `GrowableBuffer` whose
`length` was smaller at snapshot time. Because bytes are only ever appended — never
overwritten — those snapshots remain valid indefinitely; they simply ignore bytes beyond
their own `length` boundary.

### 2.3 Bytes are never freed

Deleted text leaves its bytes in `addBuffer` unreferenced. There is no compaction during
normal editing. Unreferenced bytes are reclaimed only when the document is closed or
reloaded from disk.

---

## 3. Insertion at a Middle Position

Relevant code: `pieceTableInsert`, `insertWithSplit`, `splitPiece` in
`src/store/core/piece-table.ts`.

### 3.1 Steps

1. **Encode & append** — The inserted text is UTF-8 encoded and appended to `addBuffer`,
   producing a new `GrowableBuffer`. The bytes occupy `[oldLength, oldLength + newByteLen)`.

2. **Find the target piece** — `findPieceAtPosition()` walks the RB-tree using the cached
   `subtreeLength` augment to locate the piece containing the insertion offset. It returns:
   - `node` — the piece to split
   - `offsetInPiece` — byte offset within that piece
   - `path` — root-to-node ancestry, used for efficient tree rewriting

3. **Boundary check** — If `offsetInPiece` is 0 or equals `node.length` the insertion
   falls on a piece boundary; a new `AddPieceNode` is inserted before or after the
   existing piece without splitting (O(log n)).

4. **Split** (`insertWithSplit`) — For a true mid-piece insertion, `splitPiece` divides
   the piece at `offsetInPiece`:

   ```
   Before:
     [piece: start ────────────────────── start+length]

   After splitPiece(node, offsetInPiece):
     left:  [start ──────── start+offsetInPiece)
     right: [start+offsetInPiece ─────── start+length)
   ```

   Both halves keep the original `bufferType` (and `chunkIndex` for chunk pieces). No
   buffer bytes are copied or moved.

5. **Rebuild** — Three tree operations (all O(log n)):
   1. Replace the original node with `left` using the recorded path.
   2. Insert a new `AddPieceNode` pointing to the freshly appended bytes.
   3. Re-insert `right` after the new node.

### 3.2 Net result

One piece becomes three:

```
... ─ [left of original] ─ [NEW add piece] ─ [right of original] ─ ...
```

`originalBuffer` is never modified. `addBuffer` only grows. Only O(log n) tree nodes
are allocated; all untouched subtrees are structurally shared with the previous snapshot.

---

## 4. Deletion Across Multiple Pieces / Buffer Types

Relevant code: `pieceTableDelete`, `deleteRange`, `mergeTrees` in
`src/store/core/piece-table.ts`.

### 4.1 Buffer-type agnosticism

Deletion is indifferent to `bufferType`. `deleteRange` is a recursive tree walk that
handles every overlapping piece by the same four cases, whether it is `'original'` or
`'add'`.

### 4.2 Per-piece cases

For each piece the algorithm computes:

```
keepBefore = deleteStart - pieceStart   // bytes before the cut
keepAfter  = pieceEnd   - deleteEnd     // bytes after the cut
```

| Condition                           | Action                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `keepBefore <= 0 && keepAfter <= 0` | Entire piece deleted — merge subtrees via `mergeTrees()`               |
| `keepBefore > 0 && keepAfter > 0`   | Deletion punches a hole — split into two pieces (same as insert-split) |
| `keepBefore > 0`                    | Trim right end — shorten `length`, `start` unchanged                   |
| `keepAfter > 0`                     | Trim left end — advance `start`, shorten `length`                      |

No bytes in either buffer are modified in any case.

### 4.3 Example: deletion spanning original + add pieces

```
Document: "Hello " [original] + "world" [add] + "!" [original]
Delete "o wor" → range [4, 9)

original piece "Hello ": keepBefore=4, keepAfter=0  → trimmed to "Hell"
add piece "world":       keepBefore=0, keepAfter=2  → start advances to "ld"
original piece "!":      no overlap                 → untouched

Result tree: [original "Hell"] ─ [add "ld"] ─ [original "!"]
Document:    "Hellld!"
```

The bytes `"o "` in `originalBuffer` and `"wor"` in `addBuffer` remain physically
present but are no longer referenced by any piece.

### 4.4 Tree rebalancing after deletion

Removing entire pieces requires joining the orphaned left and right subtrees.
`mergeTrees` handles this by:

1. `extractMin(rightSubtree)` — pulls the leftmost node out as the join key (O(log n)).
2. `joinByBlackHeight(left, key, right)` — merges the two subtrees maintaining the
   black-height invariant. Delegates to `joinRight` or `joinLeft` when heights differ,
   walking the appropriate spine and calling `fixRedViolations` on the way back up.

All rebalancing is O(log n).

---

## 5. Chunk Buffer — Why It Is Separate from `originalBuffer`

### 5.1 Purpose

For large documents, loading the entire content upfront is impractical. The chunk system
allows the document to be populated **incrementally**: the backing store sends fixed-size
byte arrays one at a time, and each arrives as a `LOAD_CHUNK` action. Chunks that have
already been scrolled past can be **evicted** (`EVICT_CHUNK`) to free memory, and
re-loaded on demand when that region is visited again.

`originalBuffer` cannot support this lifecycle because it is a single immutable
`Uint8Array` loaded all at once. There is no way to release part of it, and its piece
nodes carry no index that could identify a sub-region to evict.

### 5.2 Data structure differences

|                           | `originalBuffer`                         | chunk buffers                               |
| ------------------------- | ---------------------------------------- | ------------------------------------------- |
| Storage                   | Single `Uint8Array` on `PieceTableState` | `Map<number, Uint8Array>` (`chunkMap`)      |
| Piece node type           | `OriginalPieceNode`                      | `ChunkPieceNode`                            |
| Extra field on piece node | —                                        | `chunkIndex: number`                        |
| `start` field meaning     | Absolute offset within `originalBuffer`  | Offset **within that chunk's `Uint8Array`** |
| Lifetime                  | Permanent (never removed)                | Evictable; re-loadable                      |

The critical asymmetry is the `start` field. A `ChunkPieceNode` with
`chunkIndex = 2, start = 40` means byte 40 of the `Uint8Array` stored at
`chunkMap.get(2)` — not byte 40 of any combined buffer. This is necessary so that each
chunk's buffer can be replaced independently without touching any other piece node.

### 5.3 Eviction and re-load lifecycle

```
LOAD_CHUNK { chunkIndex: 3, data: Uint8Array }
  → chunkMap.set(3, data)
  → ChunkPieceNode(s) inserted into the RB-tree at the correct document position
  → nextExpectedChunk advances (sequential first loads only)

EVICT_CHUNK { chunkIndex: 3 }
  → all ChunkPieceNodes with chunkIndex === 3 removed from the tree
  → chunkMap.delete(3)
  → totalLength shrinks accordingly

LOAD_CHUNK { chunkIndex: 3, data: Uint8Array }   ← re-load after eviction
  → findReloadInsertionPos() locates the gap left by the eviction
    (finds the first node whose chunkIndex > 3 and inserts before it)
  → piece node re-inserted; chunkMap entry restored
```

`getBuffer()` in `piece-table.ts` is the single access point for all buffer types. For
chunk pieces it does `chunkMap.get(ref.chunkIndex)` and throws if the chunk has been
evicted — this is the intended failure mode when a region is accessed before re-loading.

### 5.4 Why chunks cannot be transparently merged into `originalBuffer`

Once all chunks have arrived it may seem that `chunkMap` could be collapsed: concatenate
every chunk buffer into `originalBuffer` and retag all `ChunkPieceNode`s as
`OriginalPieceNode`s. There are two blockers:

1. **`start` offsets must be remapped.** Each chunk piece's `start` is relative to its
   own chunk buffer. After concatenation the correct offset would be
   `chunkIndex × chunkSize + oldStart`. Every chunk piece node in the entire tree must be
   rewritten — an O(n) pass with no safe shortcut.

2. **Eviction becomes permanently impossible.** The `chunkIndex` field is the only handle
   that lets `EVICT_CHUNK` locate and remove a specific region. Once it is discarded there
   is no way to identify which nodes belong to which chunk, and no way to release memory
   for individual document regions later.

Merging is only safe when the document is guaranteed never to need eviction again (e.g.
the file is small enough to stay fully resident). Even then, the offset-remapping tree
walk is a required step — skipping it produces silent data corruption on all reads from
former chunk pieces.

---

## 6. Complexity Summary

| Operation                | Complexity                               |
| ------------------------ | ---------------------------------------- |
| Insert at boundary       | O(log n)                                 |
| Insert in middle (split) | O(log n)                                 |
| Delete within one piece  | O(log n)                                 |
| Delete across k pieces   | O(k + log n)                             |
| Read full document       | O(n)                                     |
| Position lookup          | O(log n) via `subtreeLength` augment     |
| Snapshot (undo entry)    | O(1) structural sharing                  |
| Load chunk (first load)  | O(log n)                                 |
| Load chunk (re-load)     | O(log n)                                 |
| Evict chunk              | O(k + log n), k = nodes in evicted chunk |
