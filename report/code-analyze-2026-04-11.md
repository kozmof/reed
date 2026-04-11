# Code Analysis: Chunk Loading Feature

**Date:** 2026-04-11
**Updated:** 2026-04-11 (high and medium issues resolved)

---

## Architecture Overview

The chunk loading feature (Phase 3) spans three layers:

- **State**: `chunkMap` (index → `Uint8Array`), `nextExpectedChunk`, `chunkSize` in `DocumentState`
- **Piece nodes**: `bufferType: 'chunk'` with `chunkIndex` + relative `start` offset
- **Line index**: Lazy dirty-range tracking via `liInsertLazy`/`liDeleteLazy`

### Key Files

| File | Role |
|---|---|
| `src/types/state.ts:20-136` | Core chunk-related type definitions |
| `src/types/actions.ts:165-184` | `LoadChunkAction` and `EvictChunkAction` definitions |
| `src/store/features/reducer.ts:1043-1119` | Main reducer logic for chunk operations |
| `src/store/features/reducer.ts:692-950` | Helper functions for chunk operations |
| `src/store/core/state.ts:93-118` | Chunk piece node creation |
| `src/store/core/piece-table.ts:45-118` | Buffer access for chunks |
| `src/store/core/piece-table.ts:485-508` | `insertChunkPieceAt` — positional chunk insertion |
| `src/store/features/store.logic.test.ts:1031-1195` | Chunk loading tests |

---

## Load / Evict Flow

### `LOAD_CHUNK`

1. **Validation**: reject if `chunkSize === 0`, `chunkIndex > nextExpectedChunk`, already loaded, or empty data
2. **Tree insertion**:
   - First-time load (`chunkIndex === nextExpectedChunk`): `appendChunkPiece()` walks right spine, attaches red leaf, applies `fixRedViolations` bottom-up, ensures black root
   - Re-load of evicted chunk (`chunkIndex < nextExpectedChunk`): `insertChunkPieceAt()` does BST insert at the correct document position, followed by RB fixup
3. **Metadata**: add entry to `chunkMap`, increment `totalLength`; `nextExpectedChunk` advances only on first-time loads
4. **Line index**: `liInsertLazy()` — defers offset recalculation via dirty ranges; the store layer schedules background reconciliation automatically when `rebuildPending` is true

### `EVICT_CHUNK`

1. **Preconditions**: chunk must be loaded; abort if any add-buffer pieces overlap (user edits protect chunks)
2. **Tree removal**: `removeChunkPiecesFromTree()` — in-order traversal collects surviving pieces, median-split rebuilds balanced tree
3. **Metadata**: delete from `chunkMap`, decrement `totalLength`; `nextExpectedChunk` unchanged
4. **Line index**: `liDeleteLazy()` — marks dirty ranges

---

## Issues

### Resolved

| Severity | Issue | Fix |
|---|---|---|
| High | RB-tree red-red violation in `appendChunkPiece()` — red leaf appended without fixup | Added `fixRedViolations` + `withPieceNode` pass bottom-up along right spine; root forced black |
| Medium | Evicted chunk could never be re-loaded | Relaxed guard from `chunkIndex !== nextExpectedChunk` to `chunkIndex > nextExpectedChunk`; added `findReloadInsertionPos()` and `insertChunkPieceAt()` for positional re-insertion |
| Medium | Line index reconciliation not auto-triggered after chunk loads | Confirmed: the store layer already calls `scheduleReconciliation()` whenever `lineIndex.rebuildPending` is true after dispatch; documented with inline comment |
| Low | `chunkIndex: -1` sentinel for non-chunk pieces was a runtime convention, not enforced by the type system | Split `PieceNode` into a discriminated union (`OriginalPieceNode \| AddPieceNode \| ChunkPieceNode`); `chunkIndex` now only exists on `ChunkPieceNode`, removed sentinel from `createPieceNode`, narrowed `PieceNodeUpdates` and made `withPieceNode` generic |

### Open (Low)

All low issues resolved.

---

## Performance

| Operation | Complexity | Notes |
|---|---|---|
| `LOAD_CHUNK` (first-time) | O(log n) avg / O(n) worst | Right-spine walk; worst case on degenerate right-heavy tree |
| `LOAD_CHUNK` (re-load) | O(n) + O(log n) | `findReloadInsertionPos` O(n) traversal + BST insert O(log n) |
| `EVICT_CHUNK` | O(n log n) | Full traversal + median-split rebuild, **synchronous in reducer** |
| `findChunkDocumentRange` + `hasAddPiecesInRange` | 2× O(n) | Both run on every eviction — could be merged into one pass |
| `chunkMap` lookup | O(1) | Standard `Map` access |
| Buffer slice | O(1) | `Uint8Array.subarray()` |

The synchronous O(n log n) eviction is the main bottleneck. Batching multiple evictions or deferring the tree rebuild would help under memory pressure.

---

## Missing Infrastructure (Phase 3 incomplete)

The reducer actions exist and are implemented, but the surrounding runtime is not yet built:

- No async chunk fetch subsystem — callers must dispatch raw bytes manually
- No LRU/eviction policy manager
- No background file parsing workers
- No disk-backed paging

---

## Test Coverage

- Sequential load, duplicate load, empty data, out-of-order load: covered
- Re-load of evicted chunk: covered (3 new tests added)
- RB invariant after multiple sequential loads: covered implicitly by content-read tests
- Interleaved edit + chunk load/evict sequences: not covered
- Performance benchmarks for large chunk counts: not covered
