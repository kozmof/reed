# Checkpoint

## 1. Status

Implemented.

| Concern               | Location                                |
| --------------------- | --------------------------------------- |
| Capture and restore   | `src/store/features/checkpoint.ts`      |
| Wire-format types     | `src/types/checkpoint.ts`               |
| Public namespace      | `src/api/checkpoint.ts`                 |
| Store entry points    | `src/store/features/store.ts`           |
| Balanced bulk-loaders | `src/store/core/state.ts`               |
| Base64 codec          | `src/store/core/base64.ts`              |
| Tests                 | `src/store/features/checkpoint.test.ts` |

## 2. Model

A checkpoint is a `DocumentState` flattened to JSON-safe data. Write it to disk, put it in
IndexedDB, or send it over a socket, then load it back without replaying the edits that
produced it.

`snapshot` already names an in-memory `DocumentState` across the runtime, in `getSnapshot`,
`getServerSnapshot`, `isCurrentSnapshot`, and `getEagerSnapshot`. The serialized form is called
a checkpoint so the two never blur together.

Capture takes a `DocumentState<'eager'>` and restore returns one. The type parameter carries
the contract. A lazily-reconciled state cannot be captured, so a checkpoint never holds
unresolved line offsets or pending reconciliation work.

### 2.1 What is captured

Everything in `DocumentState`, which is `revision`, `selectionRevision`, `pieceTable`,
`lineIndex`, `selection`, `history`, `metadata`, and `attention`.

### 2.2 What is not captured

Store runtime belongs to a store instance rather than to its state, and always starts fresh
on restore:

- subscriber list
- transaction depth and the snapshots held per level
- reconciliation scheduler and pending `whenReconciled` waiters
- `ChunkManager` pins, LRU order, and in-flight fetches

A caller restoring a chunked document rebuilds its `ChunkManager` and re-subscribes.

Capturing during an open transaction captures the uncommitted state. The restored store has no
open transaction, so that state becomes its committed baseline.

## 3. Format

The envelope is `{ format: 'reed-checkpoint', version: 1, mode, ... }`. Restore rejects a
`format` it does not recognize and a `version` newer than the one it was built against.

Byte buffers are base64. Both trees are stored as flat in-order lists.

```jsonc
{
  "format": "reed-checkpoint",
  "version": 1,
  "mode": "exact",
  "revision": 42,
  "selectionRevision": 7,
  "pieceTable": {
    "nextPieceID": 88,
    "totalLength": 12345,
    "originalBuffer": "<base64>",
    "addBuffer": "<base64>",
    "chunkSize": 0,
    "nextExpectedChunk": 0,
    "totalFileSize": 0,
    "loadedChunks": [],
    "chunks": [],
    "chunkMetadata": [],
    "pieces": [
      ["p12", "o", 0, 120],
      ["p13", "a", 0, 5],
    ],
  },
  "lineIndex": {
    "maxDirtyRanges": 32,
    "unloadedLineCounts": [],
    "lines": [
      [12, 12],
      [40, 38],
    ],
  },
  "selection": { "ranges": [[3, 7]], "primaryIndex": 0 },
  "history": { "limit": 1000, "coalesceTimeout": 0, "undo": [], "redo": [] },
  "metadata": {
    "encoding": "utf-8",
    "lineEnding": "lf",
    "normalizeInsertedLineEndings": false,
    "isDirty": true,
  },
  "attention": { "nextID": 5, "attentions": [["a0", "p12", 0, "p13", 5]] },
}
```

### 3.1 Trees are flat, and rebuilt

`pieces` is the piece list in document order and `lines` is the line list in document order.
Restore rebuilds both into balanced Red-Black trees with `buildPieceTree` and
`buildLineIndexTree`, which use the same median-split recursion and the same rule for coloring
the deepest nodes red.

Tree topology is therefore not preserved, and nothing needs it to be. Attention points anchor
to `PieceID`, which is preserved.

Rebuilding through the node factories means `subtreeLength`, `subtreeAddLength`,
`subtreeLineCount`, `subtreeByteLength`, and `subtreeCharLength` are all recomputed from the
children rather than read from the payload. A bulk-loaded tree satisfies invariants 1.1 and 2.1
by construction, so a payload cannot smuggle in a wrong aggregate.

### 3.2 Derived fields are not stored

Two kinds of value are recomputed rather than trusted.

Line byte offsets are the running prefix sum of the line lengths, which is what `reconcileFull`
computes and what `assertEagerOffsets` checks. Restore derives them, so a restored line index
satisfies invariant 2.3 even when the captured tree held a cached offset that had drifted.

`HistoryChange.byteLength` and `oldByteLength` are recomputed from their strings, so a
hand-edited payload cannot desynchronize a length from the text it measures. See invariant 4.

### 3.3 Identity allocators

`pieceTable.nextPieceID` and `attention.nextID` are captured and validated. Both must exceed
every numeric identity already in use, otherwise the first edit after restore would reissue a
live id. Identities that do not follow the `p<n>` or `a<n>` convention are opaque and place no
constraint on the allocator.

## 4. Capture modes

| Mode         | Keeps                                      | Costs                                           |
| ------------ | ------------------------------------------ | ----------------------------------------------- |
| `exact`      | Piece list, piece identities, both buffers | Payload carries the original and add buffers    |
| `normalized` | Text, history, selection, metadata         | Piece identities change, attentions re-anchored |

`normalized` collapses the document to a single original-buffer piece and rebuilds the line
index from the text. Attentions are resolved to byte ranges at capture and re-created against
the new piece, so they keep resolving to the same text under their original ids. History
survives either mode, because a `HistoryChange` records a byte offset and text rather than a
piece.

`normalized` throws `CHUNKED_NORMALIZE` for a chunked document. Flattening a partially-loaded
file to text would silently drop its unloaded ranges.

`compact` defaults to true and drops unreferenced add-buffer bytes before capture, trading an
O(n) compaction pass for a smaller payload. `normalized` discards the add buffer outright and
ignores the option.

## 5. Restore validation

Restore is fail-closed. A payload that would produce a state violating a documented invariant
raises `CheckpointError` before any state is assembled, rather than loading a piece table that
corrupts later edits.

Every field is read through a narrowing reader, so `decodeCheckpoint` is safe on untrusted
JSON. `CheckpointError` carries a stable `code`:

| Code                     | Rejected because                                                  |
| ------------------------ | ----------------------------------------------------------------- |
| `NOT_A_CHECKPOINT`       | Not an object, wrong `format`, or unparseable JSON                |
| `VERSION_UNSUPPORTED`    | Written by a newer Reed                                           |
| `MALFORMED`              | A field is missing or has the wrong runtime type                  |
| `PIECE_OUT_OF_BOUNDS`    | A piece range falls outside the buffer it reads from              |
| `CHUNK_MISSING`          | A chunk piece names a chunk absent from the payload               |
| `CHUNK_ORDER`            | Chunk pieces are not in ascending `chunkIndex` order              |
| `LENGTH_MISMATCH`        | Piece lengths do not sum to `totalLength`                         |
| `LINE_INDEX_MISMATCH`    | Line lengths do not cover the document                            |
| `ID_COLLISION`           | A duplicate id, or an allocator cursor that would reissue one     |
| `SELECTION_OUT_OF_RANGE` | A selection offset past the document, or no ranges at all         |
| `HISTORY_INVALID`        | Bad limit, bad coalesce timeout, or a stack deeper than its limit |
| `ATTENTION_DANGLING`     | An attention names an unknown piece or an out-of-range boundary   |
| `CHUNKED_NORMALIZE`      | `normalized` capture requested for a chunked document             |

Error messages name the failing field by path, for example
`pieceTable.pieces[3][2] must be a non-negative safe integer`.

History selections are checked for shape but not for range. An undo entry describes an older
revision, so its offsets may legitimately point past the end of the current document.

## 6. API

```ts
checkpoint.create(state, options?)   // DocumentState<'eager'> -> DocumentCheckpoint
checkpoint.restore(checkpoint)       // DocumentCheckpoint -> DocumentState<'eager'>
checkpoint.encode(state, options?)   // DocumentState<'eager'> -> string
checkpoint.decode(json)              // string -> DocumentState<'eager'>
checkpoint.isCheckpoint(value)       // cheap envelope guard

store.createDocumentStoreFromCheckpoint(checkpoint, config?)
store.createDocumentStoreWithEventsFromCheckpoint(checkpoint, config?)
```

The store entry points accept `DocumentStoreRuntimeConfig`, which is `logger` plus
`reconcileMode` or `scheduler`. Content, history limit, line ending, chunk size, and the other
state-bearing options come from the checkpoint. Passing one throws rather than being ignored.

Restoring into an event store emits nothing. The first event a subscriber sees is the one their
own first dispatch produces.

## 7. Complexity

| Operation | Cost                                                    |
| --------- | ------------------------------------------------------- |
| `create`  | O(n) over pieces, lines, buffer bytes, and history text |
| `restore` | O(n) validation plus O(n) bulk-load of both trees       |
| `encode`  | `create` plus `JSON.stringify`                          |
| `decode`  | `JSON.parse` plus `restore`                             |

Capture cost is dominated by base64 encoding the buffers. Measured on a 50,000-line document,
capture runs in roughly 70 ms and restore in roughly 25 ms.

## 8. Known limits

- Chunked capture inlines every loaded chunk buffer. A policy for checkpointing an unloaded
  skeleton needs the eviction-refusal path from `chunk-actions.ts`, because a chunk with
  overlapping user edits cannot be dropped.
- The format has one version. `VERSION_UNSUPPORTED` reserves the forward-compatibility path,
  but no migration between versions exists yet.
- `normalized` capture is unavailable for chunked documents.
