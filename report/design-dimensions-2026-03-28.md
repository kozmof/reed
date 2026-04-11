# Reed Design Dimensions
*2026-03-28*

---

## I. Master Pattern: Lazy/Eager Dual-Mode Indexing

The foundational design axis. `LineIndexState<M extends EvaluationMode>` is parametrized by mode — the type system propagates this constraint to every field that depends on offset accuracy:

- `src/types/state.ts:174-212` — `EvaluationMode`, `LineIndexState<M>`, and `LineIndexNode<M>` definitions
- `documentOffset: M extends 'eager' ? number : number | null` — stale offsets are explicitly typed as nullable in lazy mode

After `reconcileNow()`, the return type narrows to `DocumentState<'eager'>`, giving TypeScript-enforced guarantees that offsets are valid. The design **momentum**: every new query must decide which mode it tolerates, making lazy-state bugs impossible to ignore at compile time.

---

## II. Separate Piece Table + Line Index Trees

Two independent Red-Black trees rather than one combined structure:

| Tree | Purpose | Key File |
|------|---------|----------|
| Piece table | Text bytes (original buffer + append-only add buffer) | `src/store/core/piece-table.ts` |
| Line index | Line-number → byte-offset mappings | `src/store/core/line-index.ts` |

**Why separate?** CRLF edge cases can invalidate line-offset mappings without changing the text (e.g., deleting `\r` when followed by `\n`). A combined tree would force full rebuilds on every edit. Separation allows the line index to lazily defer recomputation via dirty ranges — `src/store/features/reducer.ts:162-174`.

**Design momentum:** The two trees must stay in sync. The reconciliation machinery exists entirely to serve this constraint.

---

## III. RB-Tree Without Parent Pointers — Path-Copying Rotations

`src/store/core/rb-tree.ts`:

**Rotations create exactly 2 new nodes.** `rotateLeft` and `rotateRight` each call `withNode` twice — once for the old parent, once for the new root. The rest of the tree is structurally shared. No parent pointer is needed because the caller holds the path.

**`fixInsertWithPath`** (`rb-tree.ts:282-304`) walks the insertion path *from leaf to root* (collected during BST descent, then reversed). This replaces the classic O(n) `fixInsert` with an O(log n) bounded upward walk:
- **Color-flip case** (uncle is red): both children turn red, violation propagates up — continue walking.
- **Rotation case** (uncle is black): rotations fix locally, subtree root goes black — walk terminates.

**Unusual invariant:** A phantom brand `_pathOrder: 'root-to-leaf'` on `RootToLeafInsertPath<T>` enforces path direction at compile time. Passing a reversed path is a type error.

**Domain aggregates on nodes** are recomputed in `withNode` callbacks — not by the RB-tree core. Piece nodes carry `subtreeLength` + `subtreeAddLength`; line-index nodes carry `subtreeLineCount`, `subtreeByteLength`, `subtreeCharLength`. The tree itself is complexity-agnostic.

---

## IV. Piece Table — Split-on-Insert, Rank-Join Delete

`src/store/core/piece-table.ts` (1,358 lines):

**`splitPiece`** (`piece-table.ts:312-342`) enforces a near-leaf constraint — the piece to split may have at most one child. This ensures that the left half can inherit `piece.left` and the right half can inherit `piece.right` without losing subtree references.

**A single mid-piece insert produces 3 tree insertions:**
1. Replace the found piece with its left part.
2. Insert the new piece at the boundary.
3. Insert the right part.

All three are O(log n) path-walks. A single character typed in the middle of a large document causes 3 RB-tree mutations, each rebuilding O(log n) path nodes.

**Delete uses black-height rank-based joining.** `mergeTrees` → `joinByBlackHeight` (`piece-table.ts:697-722`): extracts the minimum of the right tree, then joins left + key + right by descending the taller tree until heights match, then stitching. This avoids the degenerate case where naive concatenation produces an unbalanced tree.

**The add buffer's shared backing array** is the key to O(1) snapshots: old `DocumentState` snapshots hold a reference to the same `Uint8Array` but track their own `length`. Because the buffer is append-only, bytes beyond any snapshot's `length` are invisible to it — no copy needed.

---

## V. GrowableBuffer — Append-Only with Shared Backing

`src/store/core/growable-buffer.ts` (52 lines):

**Growth strategy:** On `append`, if `length + data.length > bytes.length`, allocate `Math.max(bytes.length * 2, this.length + data.length)`. Exponential-first, capped to the minimum needed for large single appends.

**Encoding:** Stores raw UTF-8 bytes (Uint8Array). Character position conversion (charToByteOffset, byteToCharOffset) happens at the API boundary in `piece-table.ts`.

**Zero-copy views:** `subarray(start, end)` returns a view, not a copy.

---

## VI. Dirty Range Semantics — Cumulative Per-Range, Not Global

`offsetDelta` in `DirtyLineRange` is the byte shift to apply to lines *within that range*. It is not a global offset — multiple ranges have independent deltas, and the sweep-line algorithm accumulates them:

```
Range A: lines [3, 7], offsetDelta = -10
Range B: lines [5, 9], offsetDelta = +4
Overlap zone [5, 7]: cumDelta = -10 + 4 = -6
```

**`mergeDirtyRanges`** (`line-index.ts:1357-1497`) handles 4 overlap cases:
1. Adjacent, same delta → extend.
2. Same start, different delta → sum deltas.
3. True overlap (s1 < s2 ≤ e1) → decompose into non-overlapping sub-ranges with summed deltas in the overlap zone.
4. No overlap → finalize and start fresh.

**The sentinel collapse at 32 ranges** is a pragmatic ceiling. If merging still yields >32 ranges, the entire dirty list collapses to `{ kind: 'sentinel' }` — a structurally distinct discriminant (not a range entry that could be silently spread-merged). Sentinel presence forces `reconcileFull` to take the slow path: full O(n) in-order tree walk.

---

## VII. The Sweep-Line Algorithm — O(K+V) Reconciliation

`reconcileRange` (`line-index.ts:1934-2018`):

**Step 1 — Event construction, O(K):** For each dirty range, emit two events: `+offsetDelta` at `startLine`, `-offsetDelta` at `endLine+1`.

**Step 2 — Sort events, O(K log K):** Events sorted by line number.

**Step 3 — Sweep, O(V):** Walk lines [clampedStart, clampedEnd] with a running `cumDelta`. Call `updateLineOffsetByNumber` (single tree descent, O(log n)) for each line where `cumDelta ≠ 0`.

Total: **O(K log K + V log n)** where K ≤ 32 and V = viewport size. In practice K is tiny so this is effectively O(V log n).

**`reconcileFull` threshold:** If dirty ranges cover >75% of total lines, skip range-by-range reconciliation and do a single O(n) in-order `reconcileInPlace` walk. Below 75%, iterate `reconcileRange` per range — O(K² + totalDirty × log n).

---

## VIII. Background Reconciliation with Dirty Ranges

On lazy edits, the line index records `DirtyLineRange` entries instead of recomputing offsets.

Three reconciliation levels:
- **`reconcileFull`** — O(n), rebuilds entire index
- **`reconcileViewport`** — O(K log n), prioritizes visible lines
- **`reconcileRange`** — O(K+V) sweep-line algorithm

Background scheduling uses `requestIdleCallback` with a 200ms `setTimeout` fallback — `src/store/features/store.ts:256-310`.

**Version semantics:** Background reconciliation does *not* increment `state.version` (invisible to users). `reconcileNow()` does (user-initiated).

---

## IX. CRLF Detection — Context-Aware Pre-Check

`src/store/features/reducer.ts:162-176`:

```
shouldRebuildLineIndexForDelete:
  deletedText includes '\r'                        → rebuild (CR is a line ending)
  deletedText includes '\n' AND prevChar == '\r'   → rebuild (LF after CR collapses CRLF)
  prevChar == '\r' AND nextChar == '\n'            → rebuild (deleting content between CR and LF)
```

The reducer calls `getDeleteBoundaryContext` *before* the delete phase to snapshot `prevChar`/`nextChar` from the piece table. This two-character lookahead is the minimum context needed to detect all CRLF-crossing cases without reading the full document.

**If rebuild is triggered:** Both delete and insert lazy line-index updates are skipped. A single `rebuildLineIndexFromPieceTableState` call at the end decodes the entire piece table and reconstructs the line index from scratch — O(n) but only on CRLF edge cases.

---

## X. Persistent Cons-List History (PStack)

`src/types/state.ts:326-381`:

```typescript
type PStack<T> = null | { top: T; rest: PStack<T>; size: number }
```

- Push/Pop: O(1), fully structural sharing with previous stacks
- History snapshot overhead drops from O(K×H) to O(K)
- Undo coalescing checked in O(1) by inspecting only the top entry

**Momentum:** History traversal is singly-linked only. No O(1) "jump to entry N" — walking is required.

---

## XI. Pure Reducer + Discriminated Union Edit Pipeline

All edits flow through a discriminated union (`src/store/features/reducer.ts:110-138`):

```typescript
type EditOperation =
  | { kind: 'insert'; position; insertText }
  | { kind: 'delete'; position; deleteEnd; deletedText }
  | { kind: 'replace'; position; deleteEnd; deletedText; insertText }
```

Undo is `applyChange(invertChange(change))` — symmetry by construction, no duplicate logic.

**Strategy pattern for eager/lazy:** Two strategy objects (`eagerStrategy`, `lazyStrategy(version)`) capture mode-specific insert/delete behavior. The reducer remains mode-agnostic.

---

## XII. Cost Algebra — Phantom Branding with Type-Level Arithmetic

`src/types/cost-doc.ts` (478 lines) uses pure phantom types — zero runtime cost:

**`Cost = { p: Nat, l: Nat }`** — represents O(n^p log^l n). `Nat` saturates at 3 for tractability.

**Composition:**
- `Seq(A, B)` → max exponents — sequential dominates
- `Nest(A, B)` → AddNat(A.p, B.p) — nested loop multiplies exponents via saturating addition

**`$prove(max, $checked(plan))`:** Validates at compile time that `plan`'s phantom cost ≤ `max`. A developer who writes O(n) code but marks the inner `$checked` annotation as O(1) will defeat the system — the type system cannot catch the lie if the annotation itself is wrong.

**`$mapN` / `$forEachN`:** Combinators for expressing O(n × body) cost.

The system's explicit disclaimer in `cost.ts:14-20`: *"Cost labels are documentation annotations, not runtime contracts."*

---

## XIII. Transaction Manager — Snapshot Stack with Emergency Exit

`src/store/features/transaction.ts` (128 lines):

- `snapshotStack.length === depth` is a maintained invariant, asserted after every operation.
- Snapshots are full `DocumentState` objects — the entire state tree.
- **Emergency reset contract:** If `rollback` dispatch throws, `emergencyReset` clears transaction state and returns the **first (outermost)** snapshot — the last fully-committed state. The innermost may be partially applied.

No per-depth limit on nesting. In practice, only 1–2 levels are used.

---

## XIV. Query API — Three-Tier Lazy Fallback

`src/api/query.ts`:

| Function | State Requirement | Offset Guarantee | Failure Mode |
|----------|------------------|-----------------|--------------|
| `getLineRange` | `DocumentState<'eager'>` (compile-time) | Always definite | Type error if called on lazy state |
| `getLineRangeChecked` | Any (runtime assertion) | Definite or throws | `Error` at runtime |
| `getLineRangePrecise` | Any | `null` if unreconciled | Returns `null` — no throw |

Callers on the render hot path use `getLineRangePrecise` to tolerate stale state without stalling. The `null` offset signals "render with previous position until reconciled."

---

## XV. Event Emission — Wrapper Pattern Over Core Store

`src/store/features/events.ts` + `src/store/features/store.ts:410-512`:

`createDocumentStoreWithEvents` wraps the core store by overriding `dispatch` to emit events post-mutation. The core store has zero event overhead. Callers who don't need events use `createDocumentStore()` directly.

**Trade-off:** Listeners cannot prevent mutations — the reducer is pure and non-blocking. Event emission is strictly post-fact.

---

## XVI. Test Strategy — Structural Invariant Assertions, No Property-Based Tests

Representative patterns:

- **`assertRBTree`** — Checks: black root, BST order, no red-red violations, equal black-height on all paths, correct subtree aggregate sizes.
- **`assertEagerOffsets`** — Spot-samples 10 lines, computes expected `documentOffset` from scratch via `getLineStartOffset`, compares against stored value.
- **Adversarial insertion orders** — Ascending, descending, and worst-case permutations to trigger all rebalancing paths.

No property-based testing (no fast-check / QuickCheck). All edge cases are hand-authored — a deliberate choice in precision data-structure implementations where the author knows exactly which invariants matter.

---

## XVII. Chunk Loading — Third Buffer Type (Phase 3, 2026-04-11)

`src/store/features/reducer.ts`, `src/store/core/piece-table.ts`, `src/types/state.ts`:

**The problem:** For large files, loading all content into `originalBuffer` at startup is impractical. `LOAD_CHUNK` / `EVICT_CHUNK` were designed to allow streaming: the host loads only the visible viewport's worth of bytes, then evicts them as the user scrolls away.

**Buffer model extension:** `BufferType` extended from `'original' | 'add'` to `'original' | 'add' | 'chunk'`. A third `ChunkBufferRef` variant joins the `BufferReference` discriminated union. Each `'chunk'` piece carries a `chunkIndex: number` identifying its entry in `PieceTableState.chunkMap: ReadonlyMap<number, Uint8Array>`. `start` remains the offset *within the chunk*, preserving the existing buffer-access contract in `getBufferSlice`. Non-chunk pieces carry `chunkIndex: -1`.

**Sequential loading constraint:** `PieceTableState.nextExpectedChunk` enforces that chunks arrive in file order (0, 1, 2, …). This eliminates the "gap problem": if chunks could arrive out of order, the piece table would have holes where document positions are undefined. With sequential ordering, each `LOAD_CHUNK` always appends to the tail of the tree — O(right-spine depth) with no structural ambiguity.

**Eviction safety:** `EVICT_CHUNK` performs an O(n) scan to find the chunk's document range and check for overlapping `'add'` pieces (user edits). If any overlap is found, eviction is refused — the host must save or discard edits before evicting. If no overlap, the chunk's pieces are removed by collecting survivors in-order and rebuilding a balanced black tree.

**Line index:** Both operations update the line index lazily (`liInsertLazy` / `liDeleteLazy`). The background reconciliation path resolves offsets as usual.

**Phase 4 open items:**
- Out-of-order (random-access) chunk loading — requires 'unloaded' placeholder pieces or gap tracking.
- Pre-populating the line index from chunk metadata for immediate line-count queries on unloaded content.
- Configurable `totalFileSize` in `DocumentStoreConfig` to allow known-size documents before loading.

---

## XVIII. Design Momentum Summary

| Decision | Enables | Constrains |
|----------|---------|-----------|
| Lazy/eager parametrization | Deferred O(n) work, responsive UI | Every query must declare mode tolerance |
| Separate piece + line trees | Independent lifecycles, lazy offsets | Must stay in sync; reconciliation complexity |
| Pure reducer | Determinism, time-travel, testability | Listeners notified after-the-fact; cannot veto |
| Persistent history (PStack) | O(1) snapshots, O(1) undo push/pop | Singly-linked; no random access |
| Immutable RB-trees (no parent pointers) | Safe structural sharing | Path copying on rotations; no in-place fixup |
| 3 mutations per mid-piece insert | Immutability preserved | Higher per-keystroke mutation cost than gap buffers |
| Shared add-buffer backing array | O(1) snapshots (no copy) | Append-only discipline must never be violated |
| Sentinel collapse at 32 ranges | Bounds memory and scan cost | Full rebuild triggered; delta information lost |
| Two-char CRLF lookahead | Avoids full rebuild on simple edits | Fragile if new line-ending types are added |
| Cost-annotated types | Explicit complexity at API boundaries | Not runtime-enforced; relies on code review |
| Event wrapper pattern | Zero-overhead core store | Separate dispatch codepath to maintain |
| `emergencyReset` returns outermost snapshot | Consistent recovery on double-fault | Partial innermost state is discarded |
| Sequential chunk loading (Phase 3) | Simple, gap-free document | Cannot pre-populate line index for unloaded chunks |

---

## XIX. Surprising Design Choices

| Choice | Why Surprising | Design Reason |
|--------|---------------|---------------|
| 3 RB-tree mutations per mid-piece insert | Most editors use gap buffers (1 op) | Enables immutability + O(1) snapshots |
| Sweep-line for dirty ranges | Uncommon in editors | O(K+V) beats O(V×K); K bounded by sentinel |
| Sentinel collapse at exactly 32 ranges | Magic number | Caps memory and scan cost; full rebuild cheap enough at this threshold |
| Shared add-buffer backing array across snapshots | Looks like aliasing bug | Append-only discipline makes this safe |
| Two-char lookahead for CRLF detection | Feels fragile | Provably sufficient — only 3 cases exist |
| Cost algebra with no runtime enforcement | Looks like theater | Documentation pressure + type narrowing on `$checked` catches annotated violations |
| `emergencyReset` returns outermost, not innermost snapshot | Counter-intuitive | Innermost may be partially applied; outermost is the last fully-committed state |
