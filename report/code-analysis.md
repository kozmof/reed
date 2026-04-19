# Code Analysis: Reed — Text Editor Library

---

## 1. Code Organization and Structure

**Reed** is a zero-dependency TypeScript text editor library (65 source files, 608 tests) organized in a clean 4-layer architecture:

```
src/
├── index.ts              — top-level namespace re-export
├── types/                — all type definitions (branded, state, actions, etc.)
├── store/
│   ├── core/             — immutable data structures (piece table, line index, RB-tree)
│   └── features/         — reducer, store, history, diff, events, rendering, chunks
├── api/                  — public-facing namespace wrappers
└── test-utils/           — large content generators for stress tests
```

Strengths: strict single-responsibility per file, no circular imports, `readonly` enforced everywhere. Zero runtime npm dependencies.

---

## 2. Relations of Implementations (Types & Interfaces)

The type hierarchy centers on `DocumentState<M extends EvaluationMode>`:

```
DocumentState<M>
├── PieceTableState           — text via RB-tree of PieceNodes
│   ├── PieceNode             — OriginalPieceNode | AddPieceNode | ChunkPieceNode
│   └── GrowableBuffer        — append-only add buffer
├── LineIndexState<M>         — line metadata via separate RB-tree
│   └── LineIndexNode<M>      — documentOffset: M extends "eager" ? number : number | null
├── SelectionState            — cursor positions (byte offsets)
├── HistoryState              — PStack<HistoryEntry> for undo/redo
└── DocumentMetadata          — encoding, line endings, dirty flag
```

Key design decision: `EvaluationMode` (`"eager" | "lazy"`) is a generic parameter on both `DocumentState` and `LineIndexNode`. This allows TypeScript to statically prove at call sites whether `documentOffset` is definitely resolved or potentially `null`. The `src/types/state.ts` file encodes this with conditional types.

**Branded position types** (`src/types/branded.ts`) create a nominal type system on top of `number`:

```
ByteOffset  ≠  CharOffset  ≠  ByteLength  ≠  LineNumber  ≠  ColumnNumber
```

Zero runtime cost — phantom brand only. Prevents the classic "mixed up UTF-8 byte offset with UTF-16 code unit" bug at compile time.

**DocumentAction** discriminated union (`src/types/actions.ts`) has 11 variants:
`INSERT | DELETE | REPLACE | SET_SELECTION | UNDO | REDO | HISTORY_CLEAR | APPLY_REMOTE | LOAD_CHUNK | EVICT_CHUNK | DECLARE_CHUNK_METADATA`

---

## 3. Relations of Implementations (Functions)

The data flow through a typical edit:

```
User call
  → api/store.ts: dispatch(action)
    → store/features/store.ts: internal dispatch
      → store/features/reducer.ts: documentReducer(state, action)   [pure]
        → store/features/edit.ts: validatePosition / validateRange
        → store/core/piece-table.ts: pieceTableInsert / pieceTableDelete
        → store/core/line-index.ts: lineIndexInsertLazy / lineIndexInsert
        → store/features/history.ts: record to history stack
      → store/features/transaction.ts: commit or rollback snapshot
      → store/features/events.ts: emit ContentChangeEvent
    → notify subscribers (React/Vue/etc.)
```

The `documentReducer` (`src/store/features/reducer.ts`) is a **pure function** — it takes state + action and returns new state. The store (`src/store/features/store.ts`) manages side effects: subscriptions, reconciliation scheduling, and transaction snapshots.

Reconciliation path (lazy → eager):

```
lineIndexInsertLazy()    →  accumulates DirtyLineRange
  → if dirtyRanges.length > maxDirtyRanges (default 32):
      reconcileFull(state)      O(n)
  → else:
      reconcileRange(...)       O(k log n)
  → or:
      reconcileViewport(...)    O(k log n)  [prioritizes visible lines]
```

---

## 4. Specific Contexts and Usages

**Large file support** (chunked streaming):
```
DECLARE_CHUNK_METADATA  →  register total chunks + line counts upfront
LOAD_CHUNK(n, data)     →  decode UTF-8, insert PieceNodes, update line index
EVICT_CHUNK(n)          →  remove from memory (line counts preserved in metadata)
```
The `ChunkManager` (`src/store/features/chunk-manager.ts`) handles: in-flight deduplication, LRU eviction, chunk pinning via `setActiveChunks()`.

**Undo/Redo** uses an immutable cons-cell `PStack<T>` — O(1) push/pop with structural sharing. History coalescing merges consecutive same-type actions within a configurable `coalesceTimeout`, keeping stack size manageable for fast typing.

**Diff / setValue** (`src/store/features/diff.ts`) runs Myers' diff to convert an old→new content change into the minimal set of INSERT/DELETE/REPLACE actions. This allows external code to call `setValue(state, newContent)` without managing positions manually.

**Collaboration hook**: `APPLY_REMOTE` action exists in the union and the store emits an event for it, but no transport/CRDT bridge is wired. This is the extension point for OT or CRDT integration.

---

## 5. Pitfalls

| # | Pitfall | Location | Risk |
|---|---------|----------|------|
| 1 | **Evicting a chunk with unsaved in-flight edits** loses those bytes silently | `src/store/features/chunk-manager.ts` | High |
| 2 | **CRLF across a chunk boundary** — delete spanning that boundary forces full rebuild | `src/store/features/edit.ts` | Medium |
| 3 | **Dirty range threshold overflow** — if 32 dirty ranges accumulate rapidly (e.g., large paste), a full O(n) rebuild fires on next dispatch | `src/store/core/line-index.ts` | Medium |
| 4 | **Cost algebra is documentation only** — no runtime enforcement; a future contributor could silently make an O(log n) function O(n) | `src/types/cost-doc.ts` | Medium |
| 5 | **`emergencyReset()` restores oldest snapshot** — any uncommitted work in a deep nested transaction is discarded | `src/store/features/transaction.ts` | Medium |
| 6 | **Position clamping hides bugs** — invalid positions silently clamp to [0, length]; callers won't know they passed bad data unless they inspect the returned range | `src/store/features/edit.ts` | Low-Medium |
| 7 | **`getValueStream()` allocates per-piece** — for documents with many small edits (fragmented piece table), streaming still produces many small chunks | `src/api/scan.ts` | Low |

---

## 6. Improvement Points — Design Overview

**6a. No public reconciliation contract**
The lazy/eager transition is internal. External consumers can't reliably know *when* offsets are valid without calling `isReconciledState()` and manually scheduling `reconcileNow()`. A formal `ReadyState` event or a `whenReconciled(): Promise<EagerSnapshot>` API would make this more ergonomic.

**6b. Collaboration is a stub**
`APPLY_REMOTE` is in the type system but the OT/CRDT transform logic is missing. This is fine for a library — but the absence should be clearly documented at the top level. A `// TODO: not implemented` comment in the reducer's APPLY_REMOTE case would help.

**6c. Chunk API is imperative, not declarative**
Callers must sequence `DECLARE_CHUNK_METADATA → LOAD_CHUNK → EVICT_CHUNK` correctly. A higher-level `StreamingDocumentLoader` that encapsulates this protocol would reduce the chance of misuse.

**6d. No compaction strategy for the add buffer**
The add buffer grows unboundedly as edits accumulate (`src/store/core/growable-buffer.ts`). A long-lived document with many edits will keep allocating. A periodic "compact" operation (flatten piece table + add buffer into a single original buffer) is missing.

---

## 7. Improvement Points — Types & Interfaces

**7a. `EvaluationMode` conditional types can be hard to work with**
`LineIndexNode<M>` uses `M extends "eager" ? number : number | null`. Any code that works on `LineIndexNode<"eager" | "lazy">` (the union) must constantly narrow. Consider a separate sealed interface `EagerLineIndexNode extends LineIndexNode<"eager">` to make narrowing explicit.

**7b. `DocumentAction` has no version field**
For optimistic concurrency (client sends action, server applies at different version), actions need a base version. Adding `readonly baseVersion?: number` to the union root would future-proof collaboration without breaking existing code.

**7c. `SelectionState` uses raw `ByteOffset` pairs**
`SelectionState` stores byte offsets, but editors typically present char offsets (code points or UTF-16). The conversion exists in `src/store/features/rendering.ts` but is opt-in. A `CharSelectionState` companion type and automatic conversion in the store API would reduce consumer errors.

**7d. `PStack<T>` interface is not exported**
The immutable stack used for history is generic but its interface is not exported. If consumers want to inspect history entries (e.g., display "undo: typed 'foo'"), they need access to the typed entries. Exporting `HistoryEntry` and `historyEntries(state): readonly HistoryEntry[]` would enable richer undo-stack UIs.

---

## 8. Improvement Points — Implementations

**8a. `mergeDirtyRanges` is O(n log n) on every lazy edit**
`src/store/core/reconcile.ts` re-sorts and re-merges the entire dirty range list on every insert. Since edits are typically sequential (typing forward), a simpler O(1) amortized append + lazy merge on reconcile would be faster for the common case.

**8b. `computeSetValueDiff` does not stream**
`src/store/features/diff.ts` loads both old and new content fully into memory before diffing. For large files this can spike memory. A chunked/streaming diff (e.g., diff only the changed region using a heuristic) would help.

**8c. `getVisibleLines` assumes complete reconciliation**
`src/store/features/rendering.ts` calls `reconcileViewport` which is fine — but the internal `getLineRange` calls assume `documentOffset !== null` after reconciliation. If reconciliation is incomplete (e.g., viewport is beyond last reconciled line), the result is silently wrong. An explicit throw or a `Partial<LineRange>` return type would be safer.

**8d. History coalescing relies on wall-clock time**
`src/store/features/history.ts` uses `Date.now()` for coalesce timeout. This creates non-determinism in tests (and breaks replay in collaboration). A `clock` option injected at store creation would make history deterministic and testable.

**8e. No tree rebalancing after bulk deletes**
After deleting many pieces (e.g., `setValue` on large document), the piece table RB-tree may become unbalanced toward one side before rotations catch up. Explicit bulk-insert / bulk-delete optimizations (batch fixup) would improve worst-case perf for diff-based `setValue`.

---

## 9. Learning Paths — Entries and Goals

### Path A: "Understand the data model" (beginner)
1. `src/types/branded.ts` — learn why nominal types matter for text editors
2. `src/types/state.ts` — understand `DocumentState`, `PieceTableState`, `LineIndexState`
3. `src/store/core/growable-buffer.ts` — the simplest data structure; understand append-only semantics
4. `src/store/core/piece-table.ts` — how text is stored non-contiguously
5. **Goal**: be able to read a `DocumentState` snapshot and mentally reconstruct the document text

### Path B: "Understand edits and state transitions" (intermediate)
1. Path A (above)
2. `src/types/actions.ts` — the full action vocabulary
3. `src/store/features/edit.ts` — validation and the edit pipeline
4. `src/store/features/reducer.ts` — how actions flow through the pure reducer
5. `src/store/features/store.ts` — store factory, dispatch, transactions
6. **Goal**: trace a single INSERT action from API call to subscriber notification

### Path C: "Understand line indexing and reconciliation" (intermediate-advanced)
1. Paths A + B
2. `src/store/core/rb-tree.ts` — generic RB-tree rotations and fixups
3. `src/store/core/line-index.ts` — eager vs lazy line index operations
4. `src/store/core/reconcile.ts` — dirty range merging and incremental reconciliation
5. **Goal**: understand why `documentOffset` can be `null` and when it becomes safe to read

### Path D: "Understand advanced features" (advanced)
1. Paths A–C
2. `src/store/features/history.ts` — undo/redo with PStack and coalescing
3. `src/store/features/diff.ts` — Myers diff and `setValue`
4. `src/store/features/chunk-manager.ts` — async loading, LRU eviction
5. `src/store/features/events.ts` — event emission and affected range computation
6. **Goal**: implement a collaboration transport by wiring `APPLY_REMOTE` and a WebSocket provider

---

## Summary

Reed is a well-structured, production-quality core with strong type safety and solid test coverage. The highest-priority improvements are:

1. **Add buffer compaction** — unbounded growth for long-lived documents
2. **Explicit lazy→eager reconciliation contract** in the public API (`whenReconciled()`)
3. **Inject a clock** into the history coalescer for determinism and testability
4. **Document the `APPLY_REMOTE` stub** prominently in the top-level README
