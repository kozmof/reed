# Code Analysis: Chunk Loading Feature

**Date:** 2026-04-11

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
| `src/store/features/reducer.ts:692-913` | Helper functions for chunk operations |
| `src/store/core/state.ts:93-118` | Chunk piece node creation |
| `src/store/core/piece-table.ts:45-118` | Buffer access for chunks |
| `src/store/features/store.logic.test.ts:1031-1168` | Chunk loading tests |

---

## Load / Evict Flow

### `LOAD_CHUNK`

1. **Validation**: reject if `chunkSize === 0`, `chunkIndex !== nextExpectedChunk`, already loaded, or empty data
2. **Tree insertion**: `appendChunkPiece()` walks right spine, creates red leaf, updates `subtreeLength` upward
3. **Metadata**: add entry to `chunkMap`, increment `totalLength` and `nextExpectedChunk`
4. **Line index**: `liInsertLazy()` — defers offset recalculation via dirty ranges

### `EVICT_CHUNK`

1. **Preconditions**: chunk must be loaded; abort if any add-buffer pieces overlap (user edits protect chunks)
2. **Tree removal**: `removeChunkPiecesFromTree()` — in-order traversal collects surviving pieces, median-split rebuilds balanced tree
3. **Metadata**: delete from `chunkMap`, decrement `totalLength`; `nextExpectedChunk` is **not** reset
4. **Line index**: `liDeleteLazy()` — marks dirty ranges

---

## Bugs and Design Issues

### Critical

**RB-tree red-red violation in `appendChunkPiece()`** (`reducer.ts:710`)

New chunk pieces are created as red leaves and appended to the right spine with no `fixRedViolations` pass. On sequential chunk loads, the rightmost existing node is often also red, producing two adjacent red nodes — a direct violation of the RB invariant. The tree will not self-correct until an unrelated edit triggers the standard fixup path.

**Fix needed**: call `fixRedViolations()` (or an equivalent right-spine fixup) after the insertion in `appendChunkPiece()`.

### Medium

| Issue | Location |
|---|---|
| Evicted chunk can never be re-loaded — `nextExpectedChunk` never resets | `reducer.ts:1159` |
| No auto-trigger for line index reconciliation after chunk loads; queries return stale results until `reconcileFull()` is called manually | `reducer.ts:1073` |
| Piece split after chunk eviction does not validate the referenced chunk is still in `chunkMap`; downstream `getBuffer()` throws | `reducer.ts:348` |

### Low

| Issue | Location |
|---|---|
| `chunkIndex: -1` sentinel for non-chunk pieces is a convention, not enforced at the type level | `types/state.ts:96` |

---

## Performance

| Operation | Complexity | Notes |
|---|---|---|
| `LOAD_CHUNK` | O(log n) avg / O(n) worst | Right-spine walk; worst case on degenerate right-heavy tree |
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

## Test Gaps

- No RB-tree invariant check after sequential chunk loads (the critical bug has no regression test)
- No tests for interleaved edit + chunk load/evict sequences
- No performance benchmarks for large chunk counts

---

## Summary

The chunk loading core is mostly correct for the sequential, forward-only loading case. The immediate priority is fixing the RB-tree red-red violation in `appendChunkPiece()`. Secondary work includes chunk re-loading support, automatic line index reconciliation, and merging the two O(n) eviction passes.
