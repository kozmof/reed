# Checkpoint

## 1. Status

Reed can save an eager document state as JSON-safe data and restore it without replaying edits.

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
on restore.

- subscriber list
- transaction depth and the snapshots held per level
- reconciliation scheduler and pending `whenReconciled` waiters
- `ChunkManager` pins, LRU order, and in-flight fetches

A caller restoring a chunked document rebuilds its `ChunkManager` and re-subscribes.

Capturing during an open transaction captures the uncommitted state. The restored store has no
open transaction, so that state becomes its committed baseline.

## 3. Format

The envelope is `{ format: 'reed-checkpoint', version: 2, mode, ... }`. Restore rejects an
unknown `format` and unsupported versions. A migration registry routes supported older versions before validation. Versions `1` and `2` are supported. See [the migration policy](../docs/adr/001-checkpoint-compatibility.md#decision-1--migration-policy-accepted-implemented).

Version 2 adds chunk placement keys and anchored history positions:

- An add piece tuple may carry a fifth element, its placement key (`afterChunk`). It is omitted when the key is `-1`.
- A history change tuple ends with its placement key, omitted when `-1`. Its position is an anchored position and may be negative.
- A history change may carry the exact bytes undo restores, as base64 after the placement key: `["i" | "d", position, text, afterChunk, bytes]` or `["r", position, text, oldText, afterChunk, bytes | null, oldBytes]`. `null` holds the place of `bytes` only when `oldBytes` follows, and restore rejects a tuple with more elements than these. They are present only when the text does not encode back to those bytes (malformed UTF-8 or a byte order mark), and the key is then written even when `-1`. Restore takes the byte length from them and counts them toward the decoded-bytes limit.
- Restore checks every history placement key against the loaded chunks: it must be at most `nextExpectedChunk - 1`, so `-1` without chunking. A change's anchored position with key `K` must resolve to a non-negative offset in the restored layout, so it is at least minus the lengths of the loaded chunks at or below `K`. A history selection is clamped when undo or redo restores it, so its positions need only be at least `-(K + 1) * chunkSize`. Positions with key `-1` are non-negative. Restore also replays each stack from its newest entry, undo last change first and redo first change first, by the rule `UNDO` and `REDO` apply. It rejects a change that removes bytes past the end of the document it applies to, or whose placement key does not fit there for the text either direction inserts.
- `UNDO` and `REDO` never apply a change that does not replay by that rule. They drop the entry and the rest of its stack, leave the document unchanged, and emit `history-drop` (see [the public API](05-public-api.md)). A restored version 2 stack replays in full, so this only happens after later loads, evictions, or edits. A version 1 payload is migrated with the same replay: each stack keeps its newer entries that replay and drops the first that does not, with every entry older than it, instead of rejecting the checkpoint.
- A history selection range is `[anchor, head]` or `[anchor, head, anchorAfterChunk, headAfterChunk]`.
- A live selection range is `[anchor, head]` byte offsets, or `[anchor, head, anchorAfterChunk, headAfterChunk]` when it stores a placement key (see `SelectionRange.anchorAfterChunk`). `null` stands for a key the range does not store. Every action that changes the document moves the selection with it, so a captured key fits its offset. Restore ignores a key that does not fit, as the live selection does.
- `history.evictionPolicy` is `'pin'`, `'drop'` or `'pin-bounded'`. Restore treats a missing value as `'pin-bounded'`, the default.

The version 1 to 2 step derives the keys from the captured layout. Each history offset is keyed in the document its entry applied to: the step follows the captured document back through the undo stack and forward through the redo stack, so an offset that later edits moved into another chunk keeps the chunk it was recorded in. Documents without chunks need no change.

Byte buffers are base64. Both trees are stored as flat in-order lists. The following example illustrates the wire shape. Its placeholder buffers and abbreviated lists are not a restorable payload.

```jsonc
{
  "format": "reed-checkpoint",
  "version": 2,
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
  "history": {
    "limit": 1000,
    "coalesceTimeout": 0,
    "evictionPolicy": "pin",
    "undo": [],
    "redo": [],
  },
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

`normalized` collapses the document to a single original-buffer piece holding its bytes as they are,
including a leading U+FEFF and malformed sequences, and rebuilds the line
index from the text. Attentions are resolved to byte ranges at capture and re-created against
the new piece, so they keep resolving to the same text under their original ids. History
survives either mode, because a `HistoryChange` records an anchored position and text rather
than a piece.

`normalized` throws `CHUNKED_NORMALIZE` for a chunked document. Flattening a partially-loaded
file to text would silently drop its unloaded ranges.

`compact` defaults to true and drops unreferenced add-buffer bytes before capture, trading an
O(n) compaction pass for a smaller payload. `normalized` discards the add buffer outright and
ignores the option.

## 5. Restore validation

Restore is fail-closed. A payload that would produce a state violating a documented invariant
raises `CheckpointError` before any state is assembled, rather than loading a piece table that
corrupts later edits.

Every field is read through a narrowing reader, so malformed values are rejected. Add resource
limits when decoding input from outside the application. `maxJsonLength` rejects oversized JSON
before parsing. The remaining limits cap decoded buffer bytes, pieces, logical lines, history
entries and attention records before Reed rebuilds the state trees.
`maxCollectionItems` caps cumulative array elements. `maxStringCodeUnits` caps cumulative
string code units. Omitted limits remain unrestricted for backward compatibility.

`CheckpointError` carries a stable `code`.

| Code                     | Rejected because                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_A_CHECKPOINT`       | Not an object, wrong `format`, or unparseable JSON                                                                                                                                             |
| `VERSION_UNSUPPORTED`    | The checkpoint version is not supported by this build                                                                                                                                          |
| `MALFORMED`              | A field is missing or has the wrong runtime type                                                                                                                                               |
| `PIECE_OUT_OF_BOUNDS`    | A piece range falls outside the buffer it reads from                                                                                                                                           |
| `CHUNK_MISSING`          | A chunk piece names a chunk absent from the payload                                                                                                                                            |
| `CHUNK_ORDER`            | Chunk pieces are not in ascending `chunkIndex` order                                                                                                                                           |
| `LENGTH_MISMATCH`        | Piece lengths do not sum to `totalLength`                                                                                                                                                      |
| `LINE_INDEX_MISMATCH`    | Line lengths do not cover the document                                                                                                                                                         |
| `ID_COLLISION`           | A duplicate id, or an allocator cursor that would reissue one                                                                                                                                  |
| `SELECTION_OUT_OF_RANGE` | A selection offset past the document, or no ranges at all                                                                                                                                      |
| `HISTORY_INVALID`        | Bad limit, bad coalesce timeout, a stack deeper than its limit, a history placement key naming a chunk that has not been loaded, or a history change that replays past the end of its document |
| `ATTENTION_DANGLING`     | An attention names an unknown piece or an out-of-range boundary                                                                                                                                |
| `CHUNKED_NORMALIZE`      | `normalized` capture requested for a chunked document                                                                                                                                          |
| `RESOURCE_LIMIT`         | A configured restore resource limit was exceeded                                                                                                                                               |

Error messages name the failing field by path, for example
`pieceTable.pieces[3][2] must be a non-negative safe integer`.

History selections are checked for shape but not for range. An undo entry describes an older
revision, so its offsets may legitimately point past the end of the current document.

Placement keys must not decrease in document order. An add piece key must also be below
`nextExpectedChunk`. Restore reports a violation as `CHUNK_ORDER`.

## 6. API

Capture an eager state, then restore either a state or a live store.

```ts
checkpoint.create(state, options?)   // DocumentState<'eager'> -> DocumentCheckpoint
checkpoint.restore(checkpoint, restoreOptions?) // unknown -> DocumentState<'eager'>
checkpoint.encode(state, options?)   // DocumentState<'eager'> -> string
checkpoint.decode(json, restoreOptions?)        // string -> DocumentState<'eager'>
checkpoint.isCheckpoint(value)       // value is CheckpointEnvelope
checkpoint.isRestorableCheckpoint(value) // value is RestorableCheckpointEnvelope, older versions too

store.createDocumentStoreFromCheckpoint(checkpoint, config?, restoreOptions?)
store.createDocumentStoreWithEventsFromCheckpoint(checkpoint, config?, restoreOptions?)
```

`isCheckpoint` checks the format, the current version, and non-null object sections. It
narrows to `CheckpointEnvelope`, whose section contents remain unvalidated.
`isRestorableCheckpoint` makes the same checks but also accepts the older versions restore
migrates. It narrows to `RestorableCheckpointEnvelope`, whose `version` is any number and whose
sections may use an older layout. Use `isCheckpoint` to narrow to the current
envelope before reading its sections directly. Pass the value to `restore` for
full validation. Restore entry points accept `unknown` input and check
line boundaries and UTF-16 lengths against the resident document bytes.

The store entry points accept `DocumentStoreRestoreConfig`, which is `logger` plus
`reconcileMode` or `scheduler`, and optionally `historyEvictionPolicy`. Set `historyEvictionPolicy` to replace
`history.evictionPolicy` for future evictions. Content, history limit, line ending, chunk size, and the other
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

Normalized capture builds one piece-offset index and resolves every attention against it. The
attention step is O(P + A), where P is the piece count and A is the attention count.

Capture includes base64 encoding of the buffers. Measure capture and restore with representative content and history on your target runtime.

## 8. Known limits

- Chunked capture inlines every loaded chunk buffer. A policy for checkpointing an unloaded
  skeleton needs the eviction-refusal path from `chunk-actions.ts`, because a chunk with
  overlapping user edits cannot be dropped.
- The registry has one upgrade step, from version `1` to `2`.
- `normalized` capture is unavailable for chunked documents.
