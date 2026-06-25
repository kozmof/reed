# Attention Layer

## 1. What Exists Today

The attention layer (`src/store/core/attention.ts`) is the third independent Reed layer, alongside the piece table (content) and the line index (navigation):

| Layer      | Responsibility | Module                          |
| ---------- | -------------- | ------------------------------- |
| Piece Tree | content        | `src/store/core/piece-table.ts` |
| Line Index | navigation     | `src/store/core/line-index.ts`  |
| Attention  | references     | `src/store/core/attention.ts`   |

It provides **piece-anchored references** into mutable text: a reference survives tree rotations, rebalancing, inserts, and deletes without the caller re-tracking offsets.

The module is fully implemented and covered by `src/store/core/attention.test.ts`.

Exposure: it is public via the `attention` namespace on `src/index.ts` (`import { attention } from "@kozmof/reed"`). Attention layer types (`AttentionPoint`, `Attention`, `AttentionLayerState`, `ResolvedRange`, `InsertWithAttentionResult`, `DeleteWithAttentionResult`, `PieceID`, `AttentionID`) are exported flat. The function names in §4 are members of the `attention` namespace; `emptyAttentionLayerState` is exposed as `attention.emptyState`.

The layer is also wired into the store: `DocumentState` carries an `attention` field that the dispatch path migrates automatically, with `CREATE_ATTENTION` / `DELETE_ATTENTION` actions and an `attention-change` event (see §8).

## 2. Core Idea

An offset into a document is invalidated by every edit before it. An attention point instead pins to a **piece boundary**:

- `AttentionPoint = { pieceID, boundary }`
- `boundary` is the byte count from the piece's start to the point — the gap _before_ byte `boundary` and _after_ byte `boundary - 1`. Valid range: `0` (before the first byte) to `piece.length` (after the last byte).

Because a piece's ID is stable across tree rotations and rebalancing, the point keeps tracking the same character gap even as the piece's absolute document position shifts.

An `Attention` is a half-open span of two such points:

- `Attention = { id, start, end }` — covers all bytes whose piece-relative position falls in `[start, end)`.

Reed stores only the two boundary points. Higher-level structure (groups, trees, ASTs) is the caller's responsibility.

## 3. State

`AttentionLayerState` is immutable and lives beside the piece table and line index:

- `attentions: ReadonlyMap<AttentionID, Attention>`
- `nextID: number` — monotonic counter for minting `AttentionID`s, scoped to the layer's history (not the process), so IDs stay deterministic across runs and stable for serialization. Carried forward by every state-returning op.

`emptyAttentionLayerState` is the frozen initial value. Every state-returning function returns a new frozen state (copy-on-write; the map is cloned only when something actually changes).

## 4. API Surface

### 4.1 Points

- `createPoint(root, offset): AttentionPoint | null` — anchor a point to the piece containing `offset`. Clamps to document end; returns `null` for an empty tree or negative offset. `O(log n)`.
- `resolvePoint(root, point): ByteOffset | null` — current document offset of a point, or `null` if dangling. `O(n)` (builds the piece-offset index once; resolve many points via `resolveAttention` instead of calling this per point).

### 4.2 Attentions

- `createAttention(state, start, end): [state, id]` — store a new span, mint its ID. The caller owns the `start <= end` invariant; an inverted or zero-width span resolves to an empty range. `O(1)`.
- `getAttention(state, id): Attention | null` — `O(1)`.
- `deleteAttention(state, id): state` — no-op for an unknown ID. `O(1)`.

### 4.3 Resolution and text

- `resolveAttention(root, state, id): ResolvedRange | null` — both points to a `{ startOffset, endOffset }` half-open range in one tree walk; `null` if the ID is unknown or a point dangles. `O(n)`.
- `getTextForAttention(pieceTableState, attentionState, id): string | null` — the covered text, `""` for an empty/inverted span, `null` if unresolvable. `O(n)`.

### 4.4 Queries

- `findAttentionsAt(state, root, offset): AttentionID[]` — attentions whose resolved range contains `offset`. `O(n + A)`.
- `findAttentionsOverlapping(state, root, start, end): AttentionID[]` — attentions overlapping `[start, end)`. `O(n + A)`.

Both index the pieces once, then resolve each attention in `O(1)`. `A` is the number of attentions.

### 4.5 Edit support

- `insertWithAttention(pieceTableState, attentionState, position, text): InsertWithAttentionResult` — insert and migrate both layers in one step.
- `deleteWithAttention(pieceTableState, attentionState, start, end): DeleteWithAttentionResult` — delete and re-anchor both layers in one step.
- `migrateSplits(state, splits): state` — lower-level hook; migrate points after a raw `pieceTableInsert` (see §5.1).

The Attention Layer stays caller-owned: pass the current `attentionState` in, store the returned one.

## 5. Migration Across Edits

Edits change the piece tree, so points must be healed. Insert and delete need different strategies.

### 5.1 Insert (ID rewriting)

When `pieceTableInsert` splits a piece, the left half keeps the original ID and the right half gets a fresh ID, recorded in a `SplitRecord { originalID, rightID, splitOffset }`.

`migrateSplits` walks the attentions and, for any point on a split piece:

- `boundary <= splitOffset` → stays on the left half (ID already correct).
- `boundary > splitOffset` → rewritten to `{ pieceID: rightID, boundary: boundary - splitOffset }`.

`pieceTableInsert` followed by `migrateSplits` is a two-step protocol — a forgotten `migrateSplits` silently corrupts any point that fell on the right half. `insertWithAttention` couples the two so the layers cannot desync.

Complexity: `O(A · S)`, where `S` (splits per insert) is almost always 0 or 1.

### 5.2 Delete (re-anchoring)

The split–join delete strategy hands surviving fragments fresh piece IDs that no `SplitRecord` describes, so ID rewriting cannot heal points on a cut piece. `deleteWithAttention` instead resolves each point against the **pre-delete** tree and re-anchors it against the **post-delete** tree:

- points strictly before `start` — unaffected.
- points at or after `end` — shift left by the deleted length.
- points inside the span, **and points exactly at `start`** — collapse to `start`.

Collapsing the `start`-boundary case is deliberate: a point at boundary 0 of a fully-deleted interior piece would otherwise dangle (the piece is dropped and no fragment inherits its ID); re-anchoring to `start` keeps it live at the same document position.

Complexity: `O(n + A · log n)` — the delete and pre-delete indexing are `O(n)`; each affected point re-anchors in `O(log n)`.

## 6. Fail-Closed Resolution

Resolution never returns a silently-wrong offset. A point resolves to `null` when:

- its `pieceID` is no longer in the tree, or
- its `boundary` is negative or exceeds the piece's current length (e.g. the piece was cut by a delete).

Already-dangling points are left untouched by delete migration — they stay dangling rather than re-anchoring to garbage.

## 7. Example

```ts
import { store, scan, position, attention } from "@kozmof/reed";

const doc = store.createDocumentStore({ content: "hello world" });
let pt = doc.getSnapshot().pieceTable;
let att = attention.emptyState;

// Anchor an attention over "world".
const start = attention.createPoint(pt.root, position.byteOffset(6))!;
const end = attention.createPoint(pt.root, position.byteOffset(11))!;
let id;
[att, id] = attention.createAttention(att, start, end);

// Edit earlier in the document; the attention follows "world" automatically.
const next = attention.insertWithAttention(pt, att, position.byteOffset(0), ">> ");
pt = next.pieceTableState;
att = next.attentionState;

scan.getValue(pt); // ">> hello world"
attention.getTextForAttention(pt, att, id); // "world"
```

## 8. Store Dispatch Integration

`DocumentState` carries an `attention: AttentionLayerState` (initialized to `attention.emptyState`), so the layer travels with every snapshot. Content actions migrate it automatically — there is no longer any need to drive `insertWithAttention` / `deleteWithAttention` by hand against a bare piece table.

### 8.1 Migration on edits

All content edits re-anchor points: `INSERT`, `DELETE`, `REPLACE`, `APPLY_REMOTE`, and `UNDO` / `REDO`. Migration is centralized in the two `DocumentState` edit wrappers (`pieceTableInsert` / `pieceTableDelete` in `edit.ts`), which every edit path funnels through: inserts heal via `migrateSplits` (§5.1), deletes via `migrateDelete` (§5.2). Chunk streaming (`LOAD_CHUNK` / `EVICT_CHUNK`) does **not** migrate attentions — chunked-mode tracking is out of scope.

### 8.2 Attention actions

- `CREATE_ATTENTION { start, end }` — anchor a span by document byte offsets (offsets are serializable; piece IDs are process-scoped and never appear in an action). The reducer converts offsets to points against the current tree; an empty tree is a no-op. The minted `AttentionID` is deterministic (`a{attention.nextID}` of the pre-dispatch state) — read it from the post-dispatch snapshot's `attention` layer.
- `DELETE_ATTENTION { id }` — remove an attention; unknown IDs are a no-op.

Both produce a new state reference (so subscribers fire) but **do not bump `version`** — attention changes are content-neutral, mirroring reconciliation, so they are not misread as content edits. Create them via `store.createAttention(start, end)` / `store.deleteAttention(id)` (the `DocumentActions` factory), and they round-trip through `serializeAction` / `deserializeAction`.

### 8.3 Event emission

`createDocumentStoreWithEvents` emits an `attention-change` event whenever the stored layer changes — on create/delete, and on a content edit that rewrites a stored point (a split during an insert, or a re-anchor during a delete). The payload carries `{ prevState, nextState, changedIds }`, where `changedIds` lists every created, deleted, or migrated attention. An insert/delete *before* a tracked span does **not** fire the event: piece-anchoring means the stored point is unchanged and its resolved offset shifts for free — subscribe to `content-change` if you need to recompute resolved positions on every edit. Events respect transaction buffering (flushed on outermost commit, discarded on rollback).
