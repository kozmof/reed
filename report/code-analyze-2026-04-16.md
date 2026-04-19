# Reed Codebase Analysis — 2026-04-16

## 1. Code Organization and Structure

```
src/
├── index.ts                  ← Public entry: flat type exports + namespaced runtime exports
├── types/                    ← Pure type definitions (no implementation)
│   ├── state.ts              ← Core state types + PStack helpers
│   ├── actions.ts            ← Action types, guards, and validators
│   ├── store.ts              ← Store/listener interfaces
│   ├── branded.ts            ← ByteOffset / CharOffset / LineNumber brands + arithmetic
│   ├── cost-doc.ts           ← Algorithmic cost algebra (type-level DSL)
│   ├── operations.ts         ← Operational parameter types (ReadTextFn etc.)
│   ├── str-enum.ts           ← String enum utility
│   └── utils.ts              ← NonEmptyReadonlyArray
├── store/
│   ├── core/                 ← Data structures (no domain logic)
│   │   ├── rb-tree.ts        ← Generic immutable RB-tree operations
│   │   ├── piece-table.ts    ← Piece table: insert/delete/read over RB-tree
│   │   ├── line-index.ts     ← Line index: RB-tree + lazy dirty-range maintenance
│   │   ├── reconcile.ts      ← Background reconciliation (full / viewport)
│   │   ├── state.ts          ← Node constructors (createPieceNode, withPieceNode…)
│   │   ├── growable-buffer.ts← Append-only Uint8Array buffer
│   │   └── encoding.ts       ← Singleton TextEncoder / TextDecoder
│   └── features/             ← Domain logic assembled from core primitives
│       ├── reducer.ts        ← Pure documentReducer (action → state)
│       ├── store.ts          ← createDocumentStore / createDocumentStoreWithEvents
│       ├── edit.ts           ← Edit pipeline (insert/delete/replace + history push)
│       ├── history.ts        ← Undo / redo application
│       ├── transaction.ts    ← Transaction stack (begin / commit / rollback)
│       ├── actions.ts        ← DocumentActions factory (action creator helpers)
│       ├── events.ts         ← Typed event emitter + event factories
│       ├── chunk-manager.ts  ← Async LRU chunk loader
│       ├── diff.ts           ← Diff algorithm + setValue helper
│       └── rendering.ts      ← Viewport / line-column conversion helpers
└── api/                      ← Thin namespace wrappers over store/features
    ├── index.ts              ← Re-exports 9 named namespaces
    ├── query.ts              ← O(1)/O(log n) read selectors
    ├── scan.ts               ← O(n) traversal selectors
    ├── store.ts              ← store.* namespace
    ├── rendering.ts          ← rendering.* namespace
    ├── history.ts            ← history.* namespace
    ├── diff.ts               ← diff.* namespace
    ├── events.ts             ← events.* namespace
    ├── position.ts           ← position.* namespace
    ├── cost-doc.ts           ← cost.* namespace
    └── interfaces.ts         ← QueryApi / ScanApi / HistoryApi interface types
```

Layering is clean and strict: `types/` → `store/core/` → `store/features/` → `api/`. No reverse dependencies were found.

---

## 2. Relations of Implementations (Types / Interfaces)

```
DocumentState<M extends EvaluationMode>
  ├── PieceTableState
  │     ├── PieceNode  (= OriginalPieceNode | AddPieceNode | ChunkPieceNode)
  │     │     └── RBNode<PieceNode>  (generic, F-bounded)
  │     ├── GrowableBuffer  (addBuffer)
  │     └── ReadonlyMap<number, Uint8Array>  (chunkMap)
  ├── LineIndexState<M>
  │     ├── LineIndexNode<M>  (RBNode<LineIndexNode<M>>)
  │     ├── DirtyLineRange[]  (DirtyLineRangeEntry | DirtyLineRangeSentinel)
  │     └── ReadonlyMap<number, number>  (unloadedLineCountsByChunk)
  ├── SelectionState
  │     └── NonEmptyReadonlyArray<SelectionRange>
  ├── HistoryState
  │     ├── PStack<HistoryEntry>  (undoStack / redoStack)
  │     └── HistoryEntry → HistoryChange[]  (insert | delete | replace)
  └── DocumentMetadata

DocumentStore
  ├── ReconcilableDocumentStore extends DocumentStore
  └── DocumentStoreWithEvents extends ReconcilableDocumentStore

DocumentAction  (discriminated union, 14 variants)
  └── DocumentActionTypes  (strEnum — single source of truth for string literals)
```

Key design decisions:

- `RBNode<T extends RBNode<T>>` F-bounded polymorphism → reuses one RB-tree implementation for both piece-table nodes and line-index nodes.
- `LineIndexState<M extends EvaluationMode>` with conditional types (`M extends 'eager' ? false : boolean`) statically distinguishes reconciled from lazy state.
- `PStack<T>` persistent stack using an unexported `PStackCons` class so external code cannot create malformed nodes.
- Branded numeric types (`ByteOffset`, `ByteLength`, `CharOffset`, `LineNumber`, `ColumnNumber`) prevent silent numeric confusion.

---

## 3. Relations of Implementations (Functions)

**Insert path (user keystroke)**:

```
store.dispatch(INSERT)
  → documentReducer (reducer.ts)
      → applyEdit (edit.ts)
          → pieceTableInsert (piece-table.ts)
              → textEncoder.encode
              → GrowableBuffer.append
              → findPieceAtPosition / rbInsertPiece (+ splitPiece if mid-piece)
                  → bstInsert → fixInsertWithPath (rb-tree.ts)
          → liInsertLazy (line-index.ts)
              → findNewlineBytePositions
              → lineIndexInsert + mergeDirtyRanges
          → historyPush (history.ts)
```

**Reconciliation path (background)**:

```
scheduleReconciliation()
  → requestIdleCallback / setTimeout
      → reconcileFull (reconcile.ts)
          → walks LineIndexState.dirtyRanges
          → recomputes documentOffset for stale nodes
          → returns EagerLineIndexState
```

**Read path (query)**:

```
query.getLineRange(state, lineNumber)
  → getLineRangeFromIndex (line-index.ts)
      → O(log n) tree traversal on LineIndexNode
```

**Chunk loading path (streaming)**:

```
chunkManager.ensureLoaded(chunkIndex)
  → ChunkLoader.loadChunk(i)
  → store.dispatch(LOAD_CHUNK)
      → documentReducer → appendChunkPiece (sequential) | insertChunkPieceAt (out-of-order)
      → liInsertLazy → scheduleReconciliation
```

---

## 4. Specific Contexts and Usages

| Use case            | Entry point                                                                    | Notes                                            |
| ------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Basic editing       | `createDocumentStore`, `dispatch({type:'INSERT'…})`                            | Returns `DocumentState` synchronously            |
| Event-driven UI     | `createDocumentStoreWithEvents` + `addEventListener('content-change'…)`        | Emits typed events after each dispatch           |
| React/SSR           | `store.getSnapshot()` / `getServerSnapshot()`                                  | Compatible with `useSyncExternalStore`           |
| Batched multi-edit  | `store.batch([…actions])`                                                      | One notification after all complete              |
| Undo/redo           | `dispatch({type:'UNDO'})`, `history.canUndo(state)`                            | PStack gives O(1) undo/redo                      |
| Large files         | `createDocumentStore({chunkSize:65536})` + `createChunkManager(store, loader)` | Async LRU eviction with metadata pre-declaration |
| Collaboration       | `dispatch({type:'APPLY_REMOTE', changes:[…]})`                                 | Remote changes bypass local history              |
| Viewport rendering  | `store.setViewport(start, end)` + `query.getLineRange`                         | Eager reconciliation of visible range only       |
| Diff/setValue       | `diff.setValue(store, newContent)`                                             | Computes edit diff, dispatches actions           |
| Complexity auditing | `cost.*` namespace                                                             | Type-level annotations; not enforced at runtime  |

---

## 5. Pitfalls

### 5.1 Known gaps (documented in SPEC.md)

- **`APPLY_REMOTE` does not auto-emit `content-change`** in the event-store wrapper. The event emitter in `store.ts:createDocumentStoreWithEvents` emits for `isTextEditAction || action.type === 'APPLY_REMOTE'` — this _is_ implemented. However SPEC.md flags it as a gap; verify whether the event carries correct `affectedRanges` for the full multi-change batch.
- **`batch()` does not auto-schedule reconciliation when `rebuildPending` remains true after outermost commit.** In `store.ts:191`, `TRANSACTION_COMMIT` calls `scheduleReconciliation()` only when `state.lineIndex.rebuildPending` is true — this appears implemented. The spec's warning may refer to older code; worth re-verifying with a test.
- **Lazy line-index precision before reconciliation.** `documentOffset` can be `null` for lines updated in lazy mode. Any caller that passes a lazy `DocumentState` (not `DocumentState<'eager'>`) to functions requiring precise offsets (e.g. `getLineRange`) will get a runtime error or miss data.

### 5.2 ~~`deleteRange` does not maintain RB-tree invariants~~ ✅ Fixed

~~`src/store/core/piece-table.ts:626` — `deleteRange` rebuilds the tree by modifying nodes in a recursive traversal, but it does NOT rebalance (no RB fix-up after deletion). This is intentional in the current implementation (it relies on the tree remaining structurally valid from insertions), but the black-height invariant can be violated after complex delete/split operations, especially when `mergeTrees` uses `joinByBlackHeight`. This has been partially addressed with the `joinByBlackHeight` helper, but a comprehensive deletion fix-up (double-black propagation) is absent.~~

**Fix applied (2026-04-16):** `deleteRange` split case (keepBefore > 0 && keepAfter > 0) now calls `fixRedViolations` on the combined node to resolve red-red violations when the original node was red. `pieceTableDelete` now enforces a black root after `deleteRange` returns. Note: full double-black propagation for black-height imbalances from deletion remains a future work item.

### 5.3 ~~`compactAddBuffer` uses a fragile offset map~~ ✅ Fixed

~~`src/store/core/piece-table.ts:1183` — The offset map keyed by `piece.start` will collide if two different pieces in the tree share the same `start` value in the add buffer (which can happen after edits that produce split add pieces at the same old start). The condition `newStart !== node.start` is correct only if starts are unique; deduplication of pieces with identical starts would silently drop one remapping.~~

**Fix applied (2026-04-19):** Replaced `Map<number, number>` keyed by `piece.start` with an ordered `Array<{ newStart: number }>` populated in the same in-order traversal as `collectPieces`. `rebuildTreeWithNewOffsets` now consumes entries via a shared counter, advancing one slot per "add" node visited — guaranteed to match since both use standard in-order (left, self, right) order. Collision between pieces sharing a start offset is no longer possible.

### 5.4 `withTransactionBatch` success flag set before `COMMIT`

`src/store/features/store.ts:55` — `success = true` is set before `txDispatch({ type: 'TRANSACTION_COMMIT' })`. If `COMMIT` throws, the `finally` block correctly skips rollback (because `success` is already `true`). However it also skips `emergencyReset`, leaving the store in an inconsistent half-committed state with no recovery path. This is a documented trade-off but can be surprising.

### 5.5 ~~`rebalanceAfterInsert` is O(n) and deprecated, but still present~~ ✅ Fixed

~~`src/store/core/rb-tree.ts:172` — `rebalanceAfterInsert` traverses the entire tree. `fixInsert` wraps it and is marked `@deprecated` but is kept alive via `void fixInsert`. Leaving dead code in a performance-sensitive core module is risky (easy to accidentally re-use).~~

**Fix applied (2026-04-19):** Removed `rebalanceAfterInsert` (exported) and `fixInsert` (private) from `rb-tree.ts`, along with the `void fixInsert` suppression comment. Updated `rb-tree.test.ts` to remove the import and replace the two tests that exercised `rebalanceAfterInsert` directly with a single `ensureBlackRoot` test that does not depend on the removed function.

### 5.6 ~~`findNewlineBytePositions` assumes `\r` and `\n` are single-byte~~ ✅ Documented

~~`src/store/core/line-index.ts:68` — The comment correctly notes this is safe for ASCII control characters in UTF-8. But there is no guard against malformed input (lone surrogates) that could produce incorrect byte-length accounting and corrupt the line index silently.~~

**Fix applied (2026-04-19):** Added an explicit comment on the `else` branch explaining that lone surrogates (unpaired 0xD800–0xDBFF or any 0xDC00–0xDFFF) are already handled correctly: they reach the `byteLen += 3` branch, which matches what `TextEncoder.encode()` produces for lone surrogates (3-byte CESU-8-like sequences). No behavior change; no additional guard is needed.

### 5.7 ~~`ReadonlyUint8Array` does not prevent aliased mutation~~ ✅ Documented

~~`src/types/branded.ts:59` — `ReadonlyUint8Array` blocks direct mutation of the dispatched buffer but does not prevent callers from holding a reference to the original `Uint8Array` and mutating it after dispatch, since `instanceof Uint8Array` is still true. This is a documentation-only guarantee.~~

**Fix applied (2026-04-19):** Added a `@remarks` JSDoc block to `ReadonlyUint8Array` explicitly stating that this is a compile-time guarantee only, and that callers retaining a reference to the original `Uint8Array` can still mutate the backing data at runtime. Recommends `new Uint8Array(buffer)` for true immutability.

---

## 6. Improvement Points 1 — Design Overview

### 6.1 `query` vs `scan` boundary is not enforced by types

The `query.*` namespace documents O(1)/O(log n) operations and `scan.*` documents O(n). However, nothing in the type system prevents a caller from accidentally using a `scan.*` function inside a hot rendering loop. A lint rule or a `@complexity` JSDoc tag on the `scan` namespace would help IDE-level guidance.

### 6.2 ~~The cost algebra is purely documentary and gives false confidence~~ ✅ Fixed

~~`cost-doc.ts` is a sophisticated compile-time DSL but the readme warns: _"Any contributor can annotate an O(n) loop as O(1) and the type system will not object."_ This creates a documentation system that can silently lie. Consider coupling it to benchmark assertions (e.g. `vitest` with threshold checks) so cost annotations become partially verified.~~

**Fix applied (2026-04-16):** Added a `"Scaling ratio (cost-algebra validation)"` describe block to `src/store/features/perf.test.ts` with two tests (`getLineStartOffset`, `findLineAtPosition`) that measure the 10k→900k line growth factor. The tests assert the ratio stays below 5×, rejecting O(n) scaling while allowing genuine O(log n) growth (~1.5×). This gives cost annotations a runtime check that CI will catch if annotations become misleading.

### 6.3 ~~`APPLY_REMOTE` bypasses the standard edit pipeline~~ ✅ Fixed

~~Remote changes in the reducer (`reducer.ts:416`) directly call `pieceTableInsert` and `pieceTableDelete` + `liInsertLazy`/`liDeleteLazy`, bypassing `applyEdit` (which handles history, selection inline-update, and line-ending normalization). This means:~~
~~- Remote inserts are not normalized to the document's `lineEnding`.~~
~~- No history entry is created (by design, but a comment explaining this explicitly would help).~~
~~- If the normalization logic in `applyEdit` evolves, remote changes won't benefit automatically.~~

**Fix applied (2026-04-16):** `APPLY_REMOTE` insert handling in `reducer.ts` now applies `normalizeLineEndings` when `state.metadata.normalizeInsertedLineEndings` is enabled, and passes the normalized text consistently to both `pieceTableInsert` and `liInsertLazy`. A comment explains why history is intentionally not pushed for remote changes.

### 6.4 The store conflates reconciliation scheduling and state mutation

`createDocumentStore` mixes reconciliation lifecycle (idle callbacks, viewport tracking) with state transitions. Extracting a `ReconciliationScheduler` object would make the store easier to test and swap (e.g. with a synchronous scheduler in tests without needing `reconcileMode: 'sync'` in config).

---

## 7. Improvement Points 2 — Types / Interfaces

### 7.1 ~~`DirtyLineRange` sentinel pattern is a footgun~~ ✅ Fixed

~~`DirtyLineRangeSentinel` (`kind: 'sentinel'`) is mixed into `DirtyLineRange[]`. Any code that iterates the array must check `kind` at every element. A dedicated type `DirtyLineRangeList = DirtyLineRangeEntry[] | 'full-rebuild-needed'` would make the sentinel state unmistakable and prevent accidentally treating a sentinel as a range entry.~~

**Fix applied (2026-04-19):** Introduced `DirtyLineRangeList = readonly DirtyLineRangeEntry[] | 'full-rebuild-needed'` in `src/types/state.ts` and updated `LineIndexState.dirtyRanges` to use it. All sentinel productions (`[{ kind: 'sentinel' }]`) are replaced with the string literal `'full-rebuild-needed'`. All consumers (`reconcile.ts`, `line-index.ts`, `edit.ts`) now check `=== 'full-rebuild-needed'` instead of `.some(r => r.kind === 'sentinel')`, and iteration loops no longer need per-element `kind` guards. `DirtyLineRangeList` is exported from the public API. `DirtyLineRangeSentinel` and `DirtyLineRange` remain exported for backwards compatibility.

### 7.2 ~~`PieceLocation.path` is mutable~~ ✅ Fixed

~~`src/store/core/piece-table.ts:134` — `path: PathEntry[]` is returned from `findPieceAtPosition` as part of a `PieceLocation`. Callers could mutate this path after calling `findPieceAtPosition`, corrupting subsequent `replacePieceInTree` calls. The path should be typed `readonly PathEntry[]`.~~

**Fix applied (2026-04-19):** `PieceLocation.path` changed to `readonly PathEntry[]`; `PathEntry.node` and `PathEntry.direction` made `readonly`. `replacePieceInTree` parameter updated to accept `readonly PathEntry[]`. TypeScript enforces that no caller can mutate the returned path.

### 7.3 `DocumentStoreConfig.reconcileMode` default is undocumented in the interface

The `DocumentStoreConfig` docstring says `reconcileMode` defaults to `'idle'`, but the interface declares `reconcileMode?: 'idle' | 'sync' | 'none'` without a `@default` tag. The actual default is applied in `createDocumentStore` at `config.reconcileMode ?? 'idle'`. Adding `@default 'idle'` to the interface would surface the default in IDE hover.

### 7.4 No factory for `SelectionRange` in char-offset units

The public API exports `store.selectionToCharOffsets` (via `query` namespace) but the distinction is not reflected by `DocumentStore`'s `dispatch` contract: `SET_SELECTION` accepts raw `SelectionRange[]` (byte offsets), which users commonly confuse with char offsets. A factory `position.selectionRange(charAnchor, charHead, state)` would guide users to the correct unit.

---

## 8. Improvement Points 3 — Implementations

### 8.1 ~~`deleteRange` does not perform RB fix-up~~ ✅ Fixed (partial)

~~As noted in §5.2, tree rebalancing after deletion is missing. The correct approach is a standard "double-black" fix-up phase walking back up the path. The existing `mergeTrees`→`joinByBlackHeight` covers the node-removal merge case, but pieces trimmed in-place (keepBefore/keepAfter cases) may leave red-red violations or incorrect black-heights along the parent path.~~

**Fix applied (2026-04-16):** Red-red violation from the split case is resolved with `fixRedViolations`; root black invariant is enforced in `pieceTableDelete`. Full double-black propagation for black-height imbalances after arbitrary deletions remains a future work item.

### 8.2 ~~`collectPieces` is used inside `getValueStream` eagerly before iteration~~ ✅ Fixed

~~`src/store/core/piece-table.ts:1372` — The docstring acknowledges this: `collectPieces` (O(n) allocation) runs at call time. For very large documents, this doubles memory: `pieces[]` + streaming output buffer simultaneously. An iterator-based in-order traversal without pre-collecting would reduce peak memory for large files.~~

**Fix applied (2026-04-19):** Introduced a private `inOrderPieces(root)` generator that lazily yields `{ piece, docOffset }` pairs via iterative in-order traversal. `getValueStream` and `streamChunks` now consume this generator — no upfront array is allocated. Peak memory is reduced from O(n) + stream buffer to O(log n) stack depth + stream buffer.

### 8.3 ~~`removeChunkPiecesFromTree` rebuilds a fully-black tree~~ ✅ Fixed

~~`src/store/features/reducer.ts:308` — The inline `buildTree` function creates all nodes with `color: 'black'`. While this preserves black-height for a perfectly balanced tree, the resulting tree may violate the red-coloring heuristic that keeps RB-trees balanced after subsequent inserts. A proper rebuild should color the root black and children red for standard balanced construction.~~

**Fix applied (2026-04-19):** `buildTree` now colors leaf nodes (no left or right child) `'red'` and internal nodes `'black'`. For a perfectly balanced median-split tree this preserves consistent black-height while providing red slack for subsequent insertions. Subsequent `fixInsertWithPath` calls rebalance normally from this foundation.

### 8.4 ~~In-order traversal boilerplate is duplicated in `reducer.ts`~~ ✅ Fixed

~~`src/store/features/reducer.ts:145` and `reducer.ts:184` both implement identical iterative in-order traversal (nodeStack + offsetStack). This should be extracted into a shared `inOrderWithOffset(root, visitor)` helper in `piece-table.ts` or `state.ts`.~~

**Fix applied (2026-04-16):** `pieceTableInOrder(root, visitor)` exported from `src/store/core/piece-table.ts`. `findReloadInsertionPos`, `findChunkDocumentRange`, and `hasAddPiecesInRange` in `reducer.ts` all refactored to use it, removing ~80 lines of duplicated nodeStack/offsetStack boilerplate.

### 8.5 ~~`getLineLinearScan` collects all pieces before scanning~~ ✅ Fixed

~~`src/store/core/piece-table.ts:1048` — `getLineLinearScan` collects all pieces first, then scans byte-by-byte. For documents with millions of lines, this is unavoidably O(n). However, the function could avoid `collectPieces` by using the already-available `findPieceAtPosition` to start the scan from the right piece, reducing constant factors significantly for random-line access.~~

**Fix applied (2026-04-19):** `findLineOffsets` (internal helper for `getLineLinearScan`) now uses `pieceTableInOrder` with an early-exit visitor instead of `collectPieces`. No upfront array is allocated; the traversal stops as soon as the target line's closing newline is found. Worst-case complexity remains O(n), but best-case for early lines is O(k) where k is the byte offset of line N.

### 8.6 ~~Module-level global regex with `/g` flag~~ ✅ Fixed

~~`src/store/features/reducer.ts:37` — `CRLF_RE`, `LONE_CR_RE`, `LONE_LF_RE` are declared with `/g` (global flag). In ECMAScript, regexes with `/g` have internal `lastIndex` state. Although `String.prototype.replace` resets `lastIndex` before each call, using globally-scoped regex literals with `/g` in concurrent environments (Workers) can produce unexpected behavior if the regex is ever used with `exec()` in future. Using `/gu` or creating regexes per-call would be safer.~~

**Fix applied (2026-04-19):** All three constants changed to `/gu` (Unicode + global). The `u` flag enables strict Unicode mode, making regex syntax errors parse-time failures, and ensures well-defined behaviour for accidental `exec()` usage in Worker contexts. All three patterns are syntactically valid and behaviourally unchanged under the `u` flag.

---

## 9. Learning Paths

### Entry point: understand the data model

1. `src/types/state.ts` — Start here. Understand `DocumentState`, `PieceTableState`, `LineIndexState`.
2. `src/types/branded.ts` — Learn the `ByteOffset`/`CharOffset` discipline.
3. `src/store/core/growable-buffer.ts` — The `addBuffer` append-only store.

### Understanding the piece table

4. `src/store/core/rb-tree.ts` — Generic immutable RB-tree: rotations, `fixInsertWithPath`.
5. `src/store/core/state.ts` — `createPieceNode`, `withPieceNode` (how structural sharing works).
6. `src/store/core/piece-table.ts` — `pieceTableInsert`, `pieceTableDelete`, `getText`.

### Understanding the line index

7. `src/store/core/line-index.ts` — `lineIndexInsertLazy`, `findLineByNumber`, `getLineRange`.
8. `src/store/core/reconcile.ts` — `reconcileFull`, `reconcileViewport`.

### Understanding the store

9. `src/store/features/edit.ts` — `applyEdit`: the main edit pipeline composing piece-table + line-index + history.
10. `src/store/features/reducer.ts` — `documentReducer`: maps every `DocumentAction` to a state transition.
11. `src/store/features/store.ts` — `createDocumentStore`: listener management, transactions, reconciliation scheduling.

### Public API surface

12. `src/api/query.ts` — O(1)/O(log n) selectors — the safe read path.
13. `src/api/interfaces.ts` — `QueryApi`, `ScanApi`, `HistoryApi` typed contracts.
14. `src/index.ts` — The full public API surface in one file.

### Advanced / large file support

15. `src/store/features/chunk-manager.ts` — Async LRU chunk loader.
16. `src/types/cost-doc.ts` — Cost algebra DSL for understanding and annotating complexity claims.
