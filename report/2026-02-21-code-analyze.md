# Reed Code Analyze Report (2026-02-21)

## Scope
- Repository: `reed`
- Analyzed areas: `src/` (types, core store, features, public API), tests, and build/test scripts
- Method: `Code analyze` skill checklist

## Verification Snapshot
- `pnpm test`: 11 files, 465 tests passed.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm build`: fails because Vite cannot resolve `index.html` (library-style repo with app-style build script).

## 1. Code organization and structure
- Public API surface is centralized in `src/index.ts` and stratified by complexity namespaces in `src/api/query.ts` and `src/api/scan.ts`.
- Types are separated cleanly in `src/types/` and drive most behavior contracts (`DocumentState`, `DocumentAction`, `DocumentStore`, branded offsets, and cost algebra).
- Core immutable data structures live in `src/store/core/`:
  - Piece table + RB-tree operations: `src/store/core/piece-table.ts`
  - Line index + lazy/eager reconciliation: `src/store/core/line-index.ts`
  - Shared RB-tree rotations/fixups: `src/store/core/rb-tree.ts`
  - State constructors and immutable update helpers: `src/store/core/state.ts`
- Feature orchestration is in `src/store/features/`:
  - Reducer and edit/history pipeline: `src/store/features/reducer.ts`
  - Store runtime and transactions: `src/store/features/store.ts`
  - Rendering selectors: `src/store/features/rendering.ts`
  - Diff/setValue pipeline: `src/store/features/diff.ts`
  - Events/actions/history helpers: `src/store/features/events.ts`, `src/store/features/actions.ts`, `src/store/features/history.ts`

## 2. Relations of implementations (types and interfaces)
- `DocumentState` composes `pieceTable`, `lineIndex`, `selection`, `history`, and `metadata` in `src/types/state.ts`.
- `LineIndexState<M>` mode parameter (`'eager' | 'lazy'`) is a strong design choice that models reconciliation state at type level, then narrowed at boundaries (for example `reconcileNow()` in `src/types/store.ts`).
- `LineIndexStrategy` in `src/types/store.ts` is used concretely by `eagerLineIndex` and `lazyLineIndex` in `src/store/features/reducer.ts`, keeping reducer policy-swappable.
- `DocumentStoreWithEvents` extends `ReconcilableDocumentStore` and maps event names to typed payloads through `DocumentEventMap` in `src/store/features/events.ts`.
- Branded offsets and cost types in `src/types/branded.ts` and `src/types/cost.ts` are used pervasively as API boundaries.

## 3. Relations of implementations (functions)
- Main edit flow:
  - `store.dispatch()` (`src/store/features/store.ts`) routes actions to `documentReducer()` (`src/store/features/reducer.ts`).
  - Reducer uses piece table operations (`pieceTableInsert`/`pieceTableDelete`) and line index operations (lazy for normal edits, eager for undo/redo).
- Rendering flow:
  - `getVisibleLines`, `getVisibleLine`, `positionToLineColumn`, `lineColumnToPosition` in `src/store/features/rendering.ts` depend on `getLineRangePrecise`/line lookup APIs plus piece table range extraction.
- Reconciliation flow:
  - Lazy edits create `dirtyRanges` in `src/store/core/line-index.ts`.
  - Background or explicit reconciliation uses `reconcileRange`, `reconcileFull`, `reconcileViewport`.
- Diff/setValue flow:
  - `setValue` in `src/store/features/diff.ts` chooses between optimized replace-style actions and Myers-style minimal actions, then applies through reducer.

## 4. Specific contexts and usages
- High-throughput editing path: lazy line index update + deferred reconciliation (`src/store/features/reducer.ts`, `src/store/features/store.ts`).
- Accuracy-critical path: undo/redo forces eager reconciliation before replay (`src/store/features/reducer.ts`).
- Virtualized rendering path: complexity-aware selectors in `src/store/features/rendering.ts`.
- Collaboration path: remote changes via `APPLY_REMOTE` action type in `src/types/actions.ts` and reducer handling in `src/store/features/reducer.ts`.

## 5. Pitfalls

### P0: `getLineRangePrecise` returns incorrect ranges in dirty/lazy states
- Evidence:
  - Dirty path adds `getOffsetDeltaForLine(...)` on top of `getLineStartOffset(...)` in `src/store/core/line-index.ts:1619` and `src/store/core/line-index.ts:1621`.
  - `getLineStartOffset(...)` already computes offsets from subtree byte aggregates, not stale `documentOffset` (`src/store/core/line-index.ts:184`), so this can double-apply shifts.
  - Rendering depends on this function (`src/store/features/rendering.ts:161`).
- Reproduced via temporary test: after inserting `"X\n"` at byte 0 into `"A\nB\nC"`, visible lines became `['X', 'B', 'C', '']` instead of `['X', 'A', 'B', 'C']`.

### P1: `batch()` does not schedule reconciliation at outer commit
- Evidence:
  - Non-transaction dispatch schedules reconciliation when `rebuildPending` in `src/store/features/store.ts:139`.
  - `TRANSACTION_COMMIT` branch only notifies listeners and returns (`src/store/features/store.ts:109`).
  - `batch()` depends on transaction start/commit (`src/store/features/store.ts:157`).
- Reproduced via temporary test: after a batched multiline insert, `rebuildPending` stayed `true` after waiting for async reconciliation window.

### P1: `APPLY_REMOTE` does not emit `content-change` event in event-enabled store
- Evidence:
  - Comment claims content-change is emitted for `APPLY_REMOTE` in `src/store/features/store.ts:313`.
  - Implementation only emits for `isTextEditAction(...)` (`INSERT/DELETE/REPLACE`) at `src/store/features/store.ts:348`.
  - `isTextEditAction` excludes `APPLY_REMOTE` in `src/types/actions.ts:203`.
- Reproduced via temporary test: `createDocumentStoreWithEvents()` emitted zero `content-change` events for remote insert.

### P1: `setValue(..., { useReplace: false })` corrupts surrogate-pair edits
- Evidence:
  - Minimal diff path (`computeSetValueActions`) operates by UTF-16 code-unit positions without surrogate-boundary guards (`src/store/features/diff.ts:369`).
  - Optimized path includes surrogate protections (`src/store/features/diff.ts:474`), but minimal path does not.
  - `setValue` selects minimal path when `useReplace: false` (`src/store/features/diff.ts:561`).
- Reproduced via temporary test: replacing `"😀"` with `"😃"` under `useReplace: false` produced replacement characters (`"����"`).

### P2: Contract drift for transaction batching and undo semantics
- Evidence:
  - Store interface says batched actions form a single undo unit in `src/types/store.ts:63`.
  - Behavior/test expectation shows per-action history entries in batch (`src/store/features/store.usecase.test.ts:206`).
- Impact: API users can mis-assume undo behavior.

### P3: Build script mismatch for repository shape
- Evidence:
  - `pnpm build` fails because Vite expects `index.html` (app build) while repo is library-first.

## 6. Improvement points 1 (design overview)
- Decide and document one clear transaction contract:
  - Option A: batch is only notification batching.
  - Option B: batch is both notification and undo batching.
- Isolate lazy-offset semantics so rendering/query paths consume a single authoritative start-offset function.
- Define event semantics for collaboration actions (single aggregated event vs per-remote-change events).

## 7. Improvement points 2 (types and interfaces)
- Add explicit action category helper for content-changing actions that includes `APPLY_REMOTE`, instead of relying on `isTextEditAction`.
- Replace residual `any` usage in production code (`src/store/core/line-index.ts:721`, `src/types/cost.ts:313`) with narrower generic types.
- Align `DocumentStore.batch` contract text (`src/types/store.ts:63`) with actual implementation or update implementation to satisfy it.

## 8. Improvement points 3 (implementations)
- Fix lazy range computation:
  - In `src/store/core/line-index.ts`, remove extra delta addition in `getLineRangePrecise` dirty branch, or compute from stale `documentOffset` consistently (not mixed models).
- Fix post-batch reconciliation scheduling:
  - In `TRANSACTION_COMMIT` branch (`src/store/features/store.ts:109`), schedule reconciliation when outermost commit leaves `rebuildPending` true.
- Fix remote event emission:
  - Extend `emitEventsForAction` in `src/store/features/store.ts` to handle `APPLY_REMOTE` as content change.
- Fix surrogate safety in minimal diff path:
  - Add surrogate boundary protection similar to optimized path, or automatically fallback to optimized replace when unsafe code-unit boundaries are detected.
- Fix build script clarity:
  - Split scripts into library-only typecheck/build targets vs optional app preview target.

## 9. Learning paths on implementations (entries and goals)
1. Entry: `src/types/state.ts`, `src/types/actions.ts`, `src/types/store.ts`
Goal: understand core invariants and store contract surface.
2. Entry: `src/store/core/state.ts`, `src/store/core/rb-tree.ts`
Goal: learn immutable node construction and structural sharing patterns.
3. Entry: `src/store/core/piece-table.ts`
Goal: understand text storage/edit mechanics and add-buffer lifecycle.
4. Entry: `src/store/core/line-index.ts`
Goal: understand eager vs lazy offset maintenance and reconciliation.
5. Entry: `src/store/features/reducer.ts`, `src/store/features/store.ts`
Goal: connect pure state transitions to runtime orchestration.
6. Entry: `src/store/features/rendering.ts`, `src/store/features/diff.ts`
Goal: understand selector behavior and bulk-update strategy tradeoffs.
7. Entry: tests in `src/store/core/*.test.ts` and `src/store/features/*.test.ts`
Goal: infer expected semantics, edge-case coverage, and remaining gaps.
