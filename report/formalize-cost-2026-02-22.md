# Formalization Review: `cost.ts` and Usage Sites

Date: 2026-02-22
Updated: 2026-02-23

## Scope

- `src/types/cost.ts`
- `src/store/core/line-index.ts`
- `src/store/core/piece-table.ts`
- `src/store/features/rendering.ts`
- `src/store/features/diff.ts`
- `src/store/features/reducer.ts`
- `src/types/index.ts` (cost API re-export)
- `src/index.ts` (cost API re-export)

## Update Status (2026-02-23)

Note: the original findings below are preserved as a historical snapshot from 2026-02-22; line references in those original sections may no longer match current HEAD.

## Focused Formalize: Issue 2.1 (2026-02-23, Implementation v0)

Decision:
- Treat `$('O(...)', $cost(value))` as an ambiguous boundary pattern and split unchecked vs checked APIs with a breaking change.

Implemented:
1. Boundary API split (`src/types/cost.ts`)
- Added explicit boundary surfaces:
  - `$declare(level, value)` for unchecked declarations.
  - `$prove(level, $checked(() => plan))` for checked plans.
  - `$proveCtx(level, ctx)` for checked contexts.
- Added `UncheckedBoundaryValue<T>` so `$declare` rejects context/plan-like inputs at compile time.

2. Migration in implementation modules
- Replaced declaration boundaries of the form `$declare('O(...)', $cost(...))` with plain-value declarations in:
  - `src/store/core/line-index.ts`
  - `src/store/core/piece-table.ts`
  - `src/store/features/diff.ts`
  - `src/store/features/rendering.ts`
- Preserved checked boundaries through `$prove`/`$proveCtx`.

3. Contract tests updated (`src/types/branded.test.ts`)
- Added negative type checks to enforce that:
  - `$declare` rejects context input.
  - `$prove` rejects unwrapped callback plans.
- Updated plan/context examples to use `$prove` and `$proveCtx` exclusively.

4. Post-migration scan
- Production code has no remaining `$declare(..., $cost(...))` boundaries.
- One intentional negative test remains to assert the compile-time rejection rule.

## Whole-Codebase Re-check (2026-02-23)

Audit target:
- All `src/**/*.ts` files (production + tests).

Verification result:
1. Type/lint safety gates:
- `npx tsc --noEmit` passes.
- `npm test` passes (489 tests).

2. Boundary split integrity:
- No legacy `$` boundary helper usage remains in source code.
- `$declare` now blocks context/plan-like inputs at the type layer (`src/types/cost.ts`).
- Contract tests assert the split (`src/types/branded.test.ts`):
  - `$declare('O(1)', $cost(...))` is rejected.
  - `$prove('O(log n)', unwrappedCallback)` is rejected.

3. Usage distribution (non-test code):
- `$declare`: 97 calls
- `$prove`: 20 calls
- `$proveCtx`: 5 calls
- This indicates the ambiguity fix is applied, while unchecked declarations remain the dominant modality.

4. Strategy evaluation:
- For the stated strategy ("remove boundary ambiguity caused by `$('O(...)', $cost(value))`"), application is correct across the codebase.
- Remaining formalization work is policy-level (where checked plans should be mandatory), not boundary API ambiguity.

## Remaining Unchecked Declarations Analysis (2026-02-23)

Scope:
- Non-test files under `src/**` only.
- Unchecked boundary = `$declare(...)`.

Inventory:
- Total unchecked declarations: `97`
- By file:
  - `src/store/core/line-index.ts`: `43`
  - `src/store/core/piece-table.ts`: `27`
  - `src/store/features/diff.ts`: `11`
  - `src/store/features/rendering.ts`: `16`

Risk-band heuristic:
- High (`22`): declaration happens after loop-driven or aggregation-heavy logic in the same function.
- Medium (`49`): non-trivial unchecked declaration without clear post-loop aggregation signal.
- Low (`26`): guard/constructor-style declarations (`null`, `''`, `0`, `[]`).

### High-Priority Unchecked Zones

1. `src/store/features/diff.ts`
- `diff` final aggregation boundary: `src/store/features/diff.ts:142`
- `computeSetValueActions` final action materialization: `src/store/features/diff.ts:443`
- `computeSetValueActionsOptimized` action construction branches:
  - `src/store/features/diff.ts:522`
  - `src/store/features/diff.ts:527`
  - `src/store/features/diff.ts:531`

2. `src/store/features/rendering.ts`
- `getVisibleLines` post-loop boundary: `src/store/features/rendering.ts:183`
- `estimateTotalHeight` sampled/aggregated boundaries:
  - `src/store/features/rendering.ts:304`
  - `src/store/features/rendering.ts:321`

3. `src/store/core/line-index.ts`
- `mergeDirtyRanges` sort/merge outputs:
  - `src/store/core/line-index.ts:1385`
  - `src/store/core/line-index.ts:1393`
- `getOffsetDeltaForLine` loop accumulation result: `src/store/core/line-index.ts:1421`
- `reconcileRange` final reconstructed state: `src/store/core/line-index.ts:1795`
- `reconcileFull` fast/slow path finalization:
  - `src/store/core/line-index.ts:1936`
  - `src/store/core/line-index.ts:1942`

### Lower-Priority / Likely Acceptable For v0

- Tree search primitives that return located nodes/positions:
  - `src/store/core/line-index.ts:237`
  - `src/store/core/line-index.ts:273`
  - `src/store/core/line-index.ts:396`
  - `src/store/core/piece-table.ts:142`
  - `src/store/core/piece-table.ts:171`
- Guard-return boundaries (`null`/`0`/empty) spread across line-index/piece-table/rendering.

### Formalization Interpretation

- The ambiguity problem is solved (unchecked vs checked API boundary is explicit).
- Remaining risk is not API ambiguity; it is declaration dominance in algorithmic hotspots.
- Next formalization step should target the high-priority zones above and define a rule for when loop/aggregation paths must use checked plans.

### Resolved

- **1.1 Label normalization duplication**
  - Runtime and type-level normalization now share `costLabelByInput` in `src/types/cost.ts:62`.
  - `$declare`/`$prove`/`$proveCtx` now use that mapping directly in `src/types/cost.ts`.

- **2.1 Boundary API still allows unchecked declaration in practice**
  - Boundary API was split into explicit unchecked/checked surfaces (`$declare`, `$prove`, `$proveCtx`) in `src/types/cost.ts`.
  - Ambiguous `$('O(...)', $cost(value))`-style declarations were removed from production modules in this review scope.

- **2.2 `getLineRangePrecise` overload mismatch**
  - Both overload paths now return `LogCost` in `src/store/core/line-index.ts:1714`.

- **2.3 Low-adoption combinator re-exports**
  - `$sort`/`$filter` removed from public re-export surfaces in `src/types/index.ts:133` and `src/index.ts:125`.

- **3.1 Constant-cost declarations hiding linear scans**
  - `isLineDirty` and `getOffsetDeltaForLine` are now `LinearCost` with `O(n)` boundaries in `src/store/core/line-index.ts:1399` and `src/store/core/line-index.ts:1411`.

- **3.2 `setValue` cost composition mostly declarative**
  - `setValue` and `computeSetValueActionsFromState` now compose via `$checked + $pipe` with explicit branch lifting in `src/store/features/diff.ts:566` and `src/store/features/diff.ts:601`.

- **4.1 Assertion casts bypassing eager-mode invariants**
  - Reconciliation now funnels through a validated eager-state conversion helper `toEagerLineIndexState` in `src/store/core/line-index.ts:1888`.
  - Prior `as LineIndexState<'eager'>` returns in `reconcileFull` were removed.

- **4.3 Nested wrapper ceremony for null/fallback branches**
  - Introduced `$lift` in `src/types/cost.ts:292` and replaced nested `$from($('O(...)', $cost(...)))` patterns (for example `src/store/features/rendering.ts:373`, `src/store/core/piece-table.ts:913`, `src/store/core/piece-table.ts:1017`).

- **4.4 Reducer-local wrappers re-annotating already-costed operations**
  - Reducer piece-table helpers now return plain values without re-branding in `src/store/features/reducer.ts:73` and `src/store/features/reducer.ts:89`.

### Partially Resolved

- **3.3 Mixed precision policy remains implicit**
  - Some high-level paths now use checked plans more consistently (notably diff/setValue), but module-level criteria for when checked plans are required is still undocumented.

### Open

- **1.2 Cost lattice partially open/closed**
  - No API-level extension strategy was added for costs above `quad`.

- **1.3 Permeable cost branding**
  - `Costed<Level, T> = T & brand` remains unchanged by design.

### Cast Reduction Notes

- In the scoped files from this review (`cost.ts`, `line-index.ts`, `piece-table.ts`, `rendering.ts`, `diff.ts`, `reducer.ts`), direct `as number` casts and mutable-to-readonly assertion casts previously called out by this report were removed.

### Verification

- `npx tsc --noEmit` passes.
- `npm test` passes (489 tests).

## 1) Data Structures

### 1.1 Label normalization is duplicated in two independent forms

- Type-level normalization is defined in `NormalizeCostLabel` (`src/types/cost.ts:62`).
- Runtime normalization is re-implemented in the `$` function via string chain logic (`src/types/cost.ts:172`).
- This creates a split source of truth: adding or changing labels requires synchronized edits in two places, and drift is silent until runtime/type mismatches appear.

### 1.2 The cost lattice is partially open and partially closed

- `Nat` allows `3` as "3 or more" (`src/types/cost.ts:27`), and `Nest` can produce higher exponents (`src/types/cost.ts:99`).
- Public labels only model up to `quad` (`src/types/cost.ts:58`, `src/types/cost.ts:73`).
- Extension rules above `O(n^2)` are undefined at the API level, so nested compositions can exceed the label space with no explicit formalized boundary type for those cases.

### 1.3 Cost branding is intentionally permeable, which weakens boundary strictness

- `Costed<Level, T>` is `T & brand` (`src/types/cost.ts:119`), so values remain directly consumable as plain `T`.
- In usage sites, branded outputs are routinely used as unbranded values without contextual composition:
  - `const oldContent = getValue(...)` in `src/store/features/diff.ts:560`
  - `const actions = computeSetValueActions...` in `src/store/features/diff.ts:567`
  - `const result = ptInsert(...)` in `src/store/features/reducer.ts:78`
- This turns the modality from enforced composition into optional annotation.

## 2) Interfaces

### 2.1 The boundary API allows unchecked declaration by default in practice

- The codebase frequently returns `$('O(...)', $cost(value))` after imperative logic:
  - `src/store/features/diff.ts:59`
  - `src/store/features/diff.ts:436`
  - `src/store/features/reducer.ts:79`
  - `src/store/core/line-index.ts:847`
  - `src/store/core/piece-table.ts:492`
- Because `$cost` always seeds constant context (`src/types/cost.ts:277`), these boundaries do not encode intermediate algorithmic steps and therefore do not produce compile-time verification of the stated bound.

### 2.2 `getLineRangePrecise` overload contract and implementation modality diverge

- Overloads declare:
  - eager mode -> `LogCost` (`src/store/core/line-index.ts:1590`)
  - generic mode -> `LinearCost` (`src/store/core/line-index.ts:1594`)
- Implementation always returns `$('O(log n)', ...)` (`src/store/core/line-index.ts:1607`).
- The interface encodes mode-dependent widening while implementation is uniform; that makes extension rules for callers unclear and invites unnecessary conservative typing.

### 2.3 Public API surface includes low-adoption combinators without formalized adoption rules

- `$sort`, `$filter`, and some function wrappers are re-exported (`src/types/index.ts:133`, `src/index.ts:125`) but are not used in store/features implementation paths.
- The exported modality is broader than the applied modality, so extension points are exposed without a house style for when each combinator should be used in production code.

## 3) Algorithms

### 3.1 Some declared constant-cost helpers depend on hidden global constraints

- `isLineDirty` is declared `ConstCost<boolean>` but scans ranges with `.some(...)` (`src/store/core/line-index.ts:1281`).
- `getOffsetDeltaForLine` is declared `ConstCost<number>` but loops through all ranges (`src/store/core/line-index.ts:1293`).
- This is only near-constant if dirty range count is bounded by the merge cap (`src/store/core/line-index.ts:1265`), but that dependency is not reflected in the function types or signatures.

### 3.2 Cost composition in diff/setValue path is largely declarative, not modeled

- `setValue` composes costed calls as plain values (`src/store/features/diff.ts:560`, `src/store/features/diff.ts:567`, `src/store/features/diff.ts:571`) and then stamps a final bound (`src/store/features/diff.ts:582`).
- `computeSetValueActionsFromState` does the same (`src/store/features/diff.ts:594`, `src/store/features/diff.ts:600`).
- The effective algorithmic contract is manual and can drift from implementation without type resistance.

### 3.3 Mixed precision policy is implicit and inconsistent across paths

- Some paths use `$checked + $pipe` plans (`src/store/core/line-index.ts:425`, `src/store/core/piece-table.ts:356`, `src/store/features/rendering.ts:126`).
- Adjacent paths of similar complexity use direct `$cost` wrapping only (e.g., `src/store/features/diff.ts:59`, `src/store/features/rendering.ts:181`).
- Without formalized criteria for when checked plans are required, extensibility depends on contributor preference instead of module-level rules.

## 4) Specific Implementations

### 4.1 Assertion casts bypass mode invariants in reconciliation paths

- `LineIndexState<'eager'>` is asserted in multiple returns:
  - `src/store/core/line-index.ts:1752`
  - `src/store/core/line-index.ts:1760`
  - `src/store/core/line-index.ts:1774`
  - `src/store/core/line-index.ts:1785`
- This bypasses structural proof that reconciliation actually produced eager-safe state.

### 4.2 Repeated shape and brand erasure casts reduce local type reliability

- Casts from mutable to readonly collections:
  - `src/store/core/line-index.ts:321`
  - `src/store/core/line-index.ts:1275`
  - `src/store/core/piece-table.ts:192`
- Brand-to-number casts in hot paths:
  - `src/store/features/rendering.ts:133`
  - `src/store/features/rendering.ts:223`
  - `src/store/core/line-index.ts:459`
  - `src/store/core/piece-table.ts:1046`
- These create ad hoc escape hatches instead of a formalized conversion boundary.

### 4.3 Null and fallback branches use nested wrapper ceremony that obscures modality

- Pattern: `$from($('O(n)', $cost(null)))` and similar appears in multiple modules:
  - `src/store/features/rendering.ts:372`
  - `src/store/core/piece-table.ts:912`
  - `src/store/core/piece-table.ts:1016`
- This indicates missing first-class combinators for optional/nullable contexts and encourages boundary noise over regular transformation.

### 4.4 Reducer-local wrappers re-annotate already-costed operations

- `pieceTableInsert`/`pieceTableDelete` in reducer rewrap outputs from core operations (`src/store/features/reducer.ts:73`, `src/store/features/reducer.ts:89`) rather than composing existing contexts.
- Callers then consume wrapped values directly as plain objects (`src/store/features/reducer.ts:420`, `src/store/features/reducer.ts:427`, `src/store/features/reducer.ts:580`), so the reducer layer does not preserve a consistent formal cost pipeline.

## Usage Map (Direct `cost.ts` Imports)

- `src/store/core/line-index.ts`
- `src/store/core/piece-table.ts`
- `src/store/features/rendering.ts`
- `src/store/features/diff.ts`
- `src/store/features/reducer.ts`

## Re-export-Only Cost Surfaces

- `src/types/index.ts`
- `src/index.ts`
