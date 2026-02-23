# Code Analysis Report - 2026-02-23

## Scope and method
- Target: current `reed` codebase in `src/` and `spec/`.
- Approach: read core/store/api/type layers, trace function relationships, and validate reliability through tests.
- Verification run: `pnpm test` on 2026-02-23.
- Test result: `11` test files, `489` tests passed.

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
- `DocumentAction` union in `src/types/actions.ts` is comprehensive, but runtime guard behavior is slightly inconsistent (see pitfalls).
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

## 5. Pitfalls
- Runtime guard mismatch for history clear:
  - `isDocumentAction` does not accept `HISTORY_CLEAR` although it is in `DocumentAction`.
  - Reference: `src/types/actions.ts:242`, `src/types/actions.ts:443`.
- Batch semantics mismatch:
  - Store comment says batch actions form a single undo unit, but behavior keeps per-action history entries.
  - Reference: `src/store/features/store.ts:152`, `src/store/features/store.usecase.test.ts:274`.
- Reconciliation scheduling gap on transaction commit:
  - `rebuildPending` scheduling occurs in non-transaction dispatch path, but commit path only notifies listeners.
  - Reference: `src/store/features/store.ts:109`, `src/store/features/store.ts:140`.
- Event contract mismatch for remote changes:
  - Doc comment says `content-change` fires for `APPLY_REMOTE`, but implementation only emits for `isTextEditAction` (INSERT/DELETE/REPLACE).
  - Reference: `src/store/features/store.ts:313`, `src/store/features/store.ts:348`.
- Metadata/event ambiguity for remote changes:
  - `APPLY_REMOTE` increments version but does not set `metadata.isDirty`, so dirty-change event may not fire for remote content changes.
  - Reference: `src/store/features/reducer.ts:705`.

## 6. Improvement points 1 (design overview)
- Make behavior contracts executable:
  - Align comments/specs/tests for batch undo semantics and event semantics.
  - Decide whether batch should be one undo unit or documented as multi-entry.
- Tighten reconciliation lifecycle:
  - Ensure commit path schedules reconciliation when `rebuildPending` is true.
- Clarify collaboration policy:
  - Define whether remote changes should affect dirty state and events.
- Add a concise invariant document for core structures:
  - Piece table subtree fields, line index mode guarantees, reconciliation invariants.

## 7. Improvement points 2 (types/interfaces)
- Fix runtime action guard consistency:
  - Include `HISTORY_CLEAR` in `isDocumentAction`.
- Consider stricter remote change typing:
  - Separate `length` into branded byte length to reduce accidental unit misuse.
- Strengthen event typing around remote mutations:
  - If remote content changes are first-class, encode that in dispatch/event contracts rather than comments only.
- Consider action schema-centric validation:
  - Reduce divergence between union definition, type guards, and validation logic.

## 8. Improvement points 3 (implementations)
- Implementation fixes:
  - Add `HISTORY_CLEAR` branch to `isDocumentAction`.
  - Schedule reconciliation after outermost `TRANSACTION_COMMIT` when pending.
  - Update `emitEventsForAction` to include `APPLY_REMOTE` content-change if intended.
  - Reconcile/store docs vs observed batch history behavior.
- Regression tests to add:
  - `isDocumentAction({ type: 'HISTORY_CLEAR' }) === true`.
  - Batch + undo behavior test that matches intended contract.
  - Transaction commit path triggers reconciliation scheduling when `rebuildPending`.
  - `createDocumentStoreWithEvents` emits/does not emit `content-change` on `APPLY_REMOTE` based on chosen policy.
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
- Overall reliability: good for core editing behavior, line-ending edge cases, and immutable transition logic.
- Confidence basis:
  - Broad tests across core/features with `489` passing tests.
  - Randomized reconciliation tests for mixed line endings, Unicode, and remote changes.
- Main risks:
  - Contract mismatches (docs/comments vs runtime behavior) around batch history, remote events, and reconciliation scheduling.
