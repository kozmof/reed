# Code Analysis Report - 2026-02-23 (Updated 2026-02-24)

## Scope and method
- Target: current `reed` codebase in `src/` and `spec/`.
- Approach: read core/store/api/type layers, trace function relationships, and validate reliability through tests.
- Verification run: `pnpm test` on 2026-02-24.
- Test result: `11` test files, `495` tests passed.

## 1. Code organization and structure
- Layering is clear and mostly consistent:
  - `src/types/*`: domain model, action/store contracts, branded types, cost algebra.
  - `src/store/core/*`: immutable data structures and algorithms (piece table, line index, RB-tree helpers, state factories).
  - `src/store/features/*`: reducer, store orchestration, diff/setValue, events, rendering, history helpers, transaction manager.
  - `src/api/*`: complexity-stratified read APIs (`query.*` vs `scan.*`).
  - `src/index.ts`: aggregated public surface.
- Strengths:
  - Good separation between pure transition logic (`documentReducer`) and side effects/orchestration (`createDocumentStore`).
  - Persistent immutable node updates via `withPieceNode` and `withLineIndexNode` centralize subtree metadata maintenance.
  - Explicit complexity branding (`Costed`, `CostFn`) is consistently applied.
- Structural risk:
  - The system combines two complexity-heavy cores (piece table + lazy/eager line index), which raises maintenance overhead for edge-case correctness.

## 2. Relations of implementations (types/interfaces)
- `DocumentState<M extends EvaluationMode>` in `src/types/state.ts` is the root model:
  - `pieceTable: PieceTableState`
  - `lineIndex: LineIndexState<M>`
  - `selection`, `history`, `metadata`
- Mode-aware line index typing is a strong design:
  - `LineIndexState<'eager'>` guarantees no dirty ranges and `rebuildPending: false`.
  - `LineIndexState<'lazy'>` allows dirty ranges and deferred reconciliation.
- `LineIndexStrategy<M>` in `src/types/store.ts` formalizes eager/lazy dual behavior and keeps reducer wiring generic.
- `DocumentAction` union in `src/types/actions.ts` is comprehensive, and runtime action guard coverage is now aligned with the union (including `HISTORY_CLEAR`).
- Branded offset types (`ByteOffset`, `CharOffset`, `ByteLength`) reduce class-of-bug mixing position units.

## 3. Relations of implementations (functions)
- Primary write pipeline:
  - `DocumentActions.*` -> `store.dispatch` -> `documentReducer` -> `pieceTable*` + `lineIndex*` updates.
- `documentReducer` in `src/store/features/reducer.ts`:
  - Uses a unified `applyEdit` path for INSERT/DELETE/REPLACE.
  - Uses lazy line-index strategy for normal edits.
  - Uses eager reconciliation for undo/redo via `reconcileFull`.
  - Handles CRLF/CR boundary cases with conditional rebuild fallback.
- Store orchestration in `src/store/features/store.ts`:
  - Transactions are managed in store layer (`createTransactionManager`) rather than reducer.
  - Background reconciliation uses `requestIdleCallback` with fallback to `setTimeout`.
- Read path separation:
  - `query.*`: intended O(1)/O(log n)/bounded linear selectors.
  - `scan.*`: full traversal O(n) operations.
- Rendering and conversion utilities in `src/store/features/rendering.ts` bridge byte-based storage and user-facing line/column or char-offset behavior.

## 4. Specific contexts and usages
- Context: normal editing throughput.
  - Lazy line index defers downstream offset reconciliation, prioritizing edit responsiveness.
- Context: correctness-sensitive operations.
  - Undo/redo forces eager line-index reconciliation before replay.
  - `setViewport` reconciles visible ranges first, then defers remaining work.
- Context: mixed line endings and Unicode.
  - Core logic explicitly handles LF/CR/CRLF and includes randomized mixed-ending tests.
  - UTF-8 byte vs UTF-16 char conversions are present across piece table and rendering APIs.
- Context: collaboration-like updates.
  - `APPLY_REMOTE` mutates content/line index without writing to local history.

## 5. Pitfalls (status as of 2026-02-24)
- Runtime guard mismatch for history clear: resolved.
  - `isDocumentAction` now accepts `HISTORY_CLEAR`.
  - Reference: `src/types/actions.ts`.
- Batch semantics mismatch: resolved by contract alignment.
  - Behavior remains per-action history entries; comments/tests now match this behavior.
  - Reference: `src/store/features/store.ts`, `src/types/store.ts`, `src/store/features/store.usecase.test.ts`.
- Reconciliation scheduling gap on transaction commit: resolved.
  - Outermost `TRANSACTION_COMMIT` now schedules background reconciliation when `rebuildPending` is true.
  - Reference: `src/store/features/store.ts`.
- Event contract mismatch for remote changes: resolved.
  - `createDocumentStoreWithEvents` now emits `content-change` for `APPLY_REMOTE`.
  - Reference: `src/store/features/store.ts`, `src/store/features/events.ts`.
- Metadata/event ambiguity for remote changes: resolved.
  - `APPLY_REMOTE` now marks document dirty on actual remote content mutation; no-op remote payloads return unchanged state.
  - Reference: `src/store/features/reducer.ts`.

## 6. Improvement points 1 (design overview)
- Make behavior contracts executable:
  - Completed: comments/tests now match batch history behavior (multi-entry).
  - Completed: remote event semantics (`content-change`) and dirty semantics are now explicit in implementation/tests.
- Tighten reconciliation lifecycle:
  - Completed: commit path schedules reconciliation when pending.
- Clarify collaboration policy:
  - Completed (current policy): remote content changes are first-class content changes, set dirty state, and do not push local undo history.
- Add a concise invariant document for core structures:
  - Piece table subtree fields, line index mode guarantees, reconciliation invariants.

## 7. Improvement points 2 (types/interfaces)
- Fix runtime action guard consistency:
  - Completed: `HISTORY_CLEAR` is included in `isDocumentAction`.
- Consider stricter remote change typing:
  - Separate `length` into branded byte length to reduce accidental unit misuse.
- Strengthen event typing around remote mutations:
  - Partially completed: remote content changes are treated as first-class in dispatch/event behavior; event payload types remain generic `DocumentAction`.
- Consider action schema-centric validation:
  - Reduce divergence between union definition, type guards, and validation logic.

## 8. Improvement points 3 (implementations)
- Implementation fixes:
  - Completed: added `HISTORY_CLEAR` branch to `isDocumentAction`.
  - Completed: schedule reconciliation after outermost `TRANSACTION_COMMIT` when pending.
  - Completed: updated `emitEventsForAction` to include `APPLY_REMOTE` content-change.
  - Completed: reconciled store/type/docs comments vs observed batch history behavior.
  - Completed: remote apply path now marks dirty on actual mutation and no-ops on empty remote payloads.
- Regression tests to add:
  - Added: `isDocumentAction({ type: 'HISTORY_CLEAR' }) === true`.
  - Added/updated: batch semantics test now explicitly validates per-action history behavior.
  - Added: transaction commit path test that verifies reconciliation scheduling when `rebuildPending`.
  - Added: event-store tests for `APPLY_REMOTE` `content-change` and dirty-change behavior.
- Performance confidence:
  - Add benchmark harness for large doc edits, mixed line endings, and reconciliation thresholds.

## 9. Learning paths on implementations (entries and goals)
- Path A: API consumer to internal state flow
  - Entry: `src/index.ts`, `src/store/features/actions.ts`, `src/store/features/store.ts`
  - Goal: understand how public actions become immutable state snapshots.
- Path B: text editing core
  - Entry: `src/store/features/reducer.ts` -> `src/store/core/piece-table.ts`
  - Goal: understand insert/delete/replace behavior and history recording.
- Path C: line indexing and reconciliation
  - Entry: `src/store/core/line-index.ts`
  - Goal: understand eager vs lazy modes, dirty ranges, and viewport/full reconciliation.
- Path D: byte/char correctness and rendering adapters
  - Entry: `src/store/features/rendering.ts`, `src/store/core/piece-table.ts`
  - Goal: understand how byte offsets are mapped to user-visible line/column and char offsets.
- Path E: reliability harness
  - Entry: `src/store/features/store.usecase.test.ts`, `src/store/core/line-index.test.ts`
  - Goal: follow randomized and edge-case tests to reason about invariants.

## Reliability snapshot
- Overall reliability: good for core editing behavior, line-ending edge cases, immutable transition logic, and event/store contract alignment.
- Confidence basis:
  - Broad tests across core/features with `495` passing tests.
  - Randomized reconciliation tests for mixed line endings, Unicode, and remote changes.
- Main risks:
  - Core complexity remains high (piece table + lazy/eager line index); invariant drift risk remains without dedicated invariant docs/benchmarks.
