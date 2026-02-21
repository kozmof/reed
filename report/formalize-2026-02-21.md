# Formalization Report — Reed

Date: 2026-02-21

## 1. Data Structures

### 1.1 Two offset models exist in `LineIndexNode`, but only one drives lookups
- `LineIndexNode` stores `documentOffset` (`src/types/state.ts:112`) and also subtree byte aggregates (`subtreeByteLength`) (`src/types/state.ts:120`).
- `getLineStartOffset` computes offsets from subtree aggregates and does not read `documentOffset` (`src/store/core/line-index.ts:184`).
- Lazy reconciliation logic still mutates/depends on `documentOffset` (`src/store/core/line-index.ts:730`, `src/store/core/line-index.ts:1694`, `src/store/core/line-index.ts:1733`).
- This creates a split authority model: tree aggregate offsets vs node field offsets. The structure does not encode which source is canonical.

### 1.2 Branded byte/char types are repeatedly collapsed back to `number`
- Multiple production call sites cast brands away (`src/store/features/rendering.ts:164`, `src/store/features/rendering.ts:370`, `src/store/features/reducer.ts:534`, `src/store/core/piece-table.ts:1046`, `src/store/core/line-index.ts:459`).
- The branded type system stops acting as a formal boundary when internal arithmetic regularly bypasses it.

### 1.3 Dirty range representation uses sentinel values and weak invariants
- Dirty ranges use `endLine: Number.MAX_SAFE_INTEGER` as a special token (`src/store/core/line-index.ts:1436`, `src/store/core/line-index.ts:1546`).
- `mergeDirtyRanges` mixes three merge rules (same delta, same start, otherwise split) in one pass (`src/store/core/line-index.ts:1236`), but no data-level invariant ensures normalized form at construction boundaries.
- Extension rules are implicit and can be bypassed by appending raw ranges before merge.

### 1.4 Cost pipeline runtime bridge uses `any`
- `$pipe` overloads are strict at signature level, but runtime implementation falls back to `(x: any) => any` (`src/types/cost.ts:313`).
- The data shape contract for cost contexts is not fully preserved through implementation.

## 2. Interfaces

### 2.1 `batch` contract and behavior diverge
- Interface says batch actions form a single undo unit (`src/types/store.ts:63`).
- Existing behavior/tests show per-action undo entries in a batch (`src/store/features/store.usecase.test.ts:196`, `src/store/features/store.usecase.test.ts:207`).
- The interface does not formalize actual transaction semantics used by the reducer/history path.

### 2.2 Content-changing action taxonomy and event interface do not align
- `isTextEditAction` includes only `INSERT/DELETE/REPLACE` (`src/types/actions.ts:203`).
- Event emission for `content-change` is keyed only on `isTextEditAction` (`src/store/features/store.ts:348`).
- Reducer changes content for `APPLY_REMOTE` (`src/store/features/reducer.ts:633`), but this action is excluded from that event path.
- Interface-level event expectations and action categories are not centralized into one extensible modality.

### 2.3 Reconciliation interface boundary is incomplete around transactions
- Store dispatch schedules reconciliation only in non-transaction edit path (`src/store/features/store.ts:139`).
- `TRANSACTION_COMMIT` path does not schedule reconciliation (`src/store/features/store.ts:109`).
- `batch` is implemented using transaction start/commit (`src/store/features/store.ts:157`), so the deferred-maintenance contract is not consistently applied across interface entry points.

## 3. Algorithms

### 3.1 `getLineRangePrecise` composes two offset mechanisms that conflict in lazy mode
- Lazy branch computes `start` using `getLineStartOffset(...) + getOffsetDeltaForLine(...)` (`src/store/core/line-index.ts:1619`, `src/store/core/line-index.ts:1621`).
- `getLineStartOffset` is already derived from subtree byte lengths (`src/store/core/line-index.ts:204`, `src/store/core/line-index.ts:211`).
- The algorithm overlays a dirty delta on a start offset that is not modeled as stale in the same way as `documentOffset`, producing a non-regular correction model.

### 3.2 Minimal diff path mixes UTF-16 edit coordinates with UTF-8 action coordinates without surrogate safety
- `computeSetValueActions` consumes `diff` edits using string positions (`src/store/features/diff.ts:387`, `src/store/features/diff.ts:416`).
- It converts each op position via prefix re-encode (`src/store/features/diff.ts:437`) and lacks surrogate boundary guards.
- `computeSetValueActionsOptimized` does include surrogate guards (`src/store/features/diff.ts:474`, `src/store/features/diff.ts:488`), so the module contains two incompatible coordinate safety models.

### 3.3 Algorithmic regularity is split between duplicate edit pipelines
- `applyEdit` formalizes local edit sequencing (`src/store/features/reducer.ts:497`).
- `APPLY_REMOTE` reimplements insert/delete sequencing separately (`src/store/features/reducer.ts:633`).
- Shared algorithm rules (line-index updates, versioning boundaries, future extension hooks) are duplicated instead of parameterized.

## 4. Specific Implementations

### 4.1 `updateLineAtNumber` bypasses typed update contract with `any`
- `const updates: any = { lineLength: newLength }` (`src/store/core/line-index.ts:721`).
- This weakens `withLineIndexNode` as the formal mutation boundary for node updates.

### 4.2 `createDocumentStoreWithEvents.batch` duplicates transaction orchestration
- Event store re-implements explicit start/commit/rollback orchestration (`src/store/features/store.ts:404`) instead of delegating one shared batching primitive.
- Transaction modality is split between two implementations, increasing divergence risk.

### 4.3 Background reconciliation semantics differ between `dispatch` and `batch`
- Non-transaction edits schedule reconciliation (`src/store/features/store.ts:139`).
- Outermost transaction commit does not schedule reconciliation (`src/store/features/store.ts:109`).
- Same logical state transition class (edit producing `rebuildPending`) yields different maintenance behavior based on entrypoint.

### 4.4 Build pipeline script encodes app runtime assumption in library-shaped repository
- `build` runs `vite build` (`package.json:8`) but repository has no `index.html`, causing build failure.
- Packaging modality is not formalized (library build vs app build).

## 5. Fragility Points

1. The lazy line-index correction path is easiest to bypass because offset semantics are distributed across subtree aggregates, `documentOffset`, and dirty delta overlays.
2. Action extension is fragile because event emission relies on narrow action guards rather than a single authoritative “content mutation” classifier.
3. Batch semantics are fragile because transaction, undo grouping, and reconciliation scheduling are defined in separate places with conflicting expectations.
4. Unicode correctness in diff-based setValue is fragile because two action synthesis algorithms use different boundary rules.
5. Branded type guarantees are fragile due to repeated cast-based escapes in core rendering/edit paths.

## 6. Formalization Directions

1. Pick one canonical line-start model and eliminate mixed corrections in `getLineRangePrecise`.
2. Introduce a single action-level content mutation predicate and reuse it for reducer/event/store boundaries.
3. Refactor batch execution to one transaction primitive that owns undo grouping and reconciliation scheduling.
4. Merge diff action synthesis paths under one coordinate policy (including surrogate-safe boundaries).
5. Replace cast-based brand escapes with brand-aware helpers for byte-end arithmetic and buffer slicing.
6. Replace `any` update objects with typed conditional object construction at mutation boundaries.
