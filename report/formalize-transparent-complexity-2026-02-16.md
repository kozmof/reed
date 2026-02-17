# Formalization Analysis: Transparent Complexity & Evaluation Strategy

## 1. Data Structures — Complexity Contracts (Resolved)

The public API previously exported functions like `getValue`, `getText`, and `getLineContent` as peers — flat functions with identical call signatures. A consumer could not distinguish O(n) from O(log n) without reading implementation.

| Function | Actual Complexity | Visible from signature? |
|---|---|---|
| `getValue` | O(n) | **Yes** — returns `LinearCost<string>`, in `scan` namespace |
| `getText` | O(log n + m) | **Yes** — returns `LogCost<string>`, in `query` namespace |
| ~~`getLine`~~ (removed) | O(n) | Renamed to `getLineLinearScan`, no longer public |
| `getLineContent` (rendering) | O(log n) | **Yes** — returns `LogCost<string>`, in `query` namespace |
| `getBufferStats` | O(1) | In `query` namespace |
| `getLength` | O(1) | **Yes** — returns `ConstCost<number>`, in `query` namespace |

**Resolved**: All complexity contracts are now visible through three complementary mechanisms: cost-branded return types (Proposal A), namespace stratification (Proposal B), and `getLine` removal (Proposal D).

## 2. Interfaces — The `LineIndexStrategy` Duality (Resolved)

The `LineIndexStrategy` interface in `src/types/store.ts` cleanly separates eager vs. lazy. The reducer in `src/store/features/reducer.ts` correctly uses `eagerLineIndex` for undo/redo and `lazyLineIndex` for normal edits.

The strategy choice is now **visible at the type level**:

- `eagerLineIndex: LineIndexStrategy<'eager'>` — returns `LineIndexState<'eager'>`
- `lazyLineIndex: LineIndexStrategy<'lazy'>` — returns `LineIndexState<'lazy'>`
- `getLineRange` requires `LineIndexState<'eager'>` — calling it on lazy state is a **compile error**
- `getLineRangePrecise` accepts `LineIndexState` (either mode) — applies dirty-range deltas internally
- `reconcileNow()` returns `DocumentState<'eager'>` — the contract discharge point that narrows the type

A consumer calling `getLineRange` after a lazy insert now gets a type error, not stale data. The `getLineRange` / `getLineRangePrecise` distinction is enforced by the type system, not by naming convention alone.

**Key change**: `getLineContent` in `src/store/features/rendering.ts` now calls `getLineRangePrecise` instead of `getLineRange`, making it safe to use on lazy state. All other rendering functions already used `getLineRangePrecise`.

## 3. Algorithms — Two Contract Fidelity Violations (Resolved)

### (a) `byteOffsetToCharOffset` — was O(n), now O(log n + line_length)

Previously in `src/store/features/rendering.ts`, this function contained a `for (let line = 0; line < location.lineNumber; line++)` loop that issued one `getText` call per preceding line — O(n) in total.

**Fix**: Added `charLength` and `subtreeCharLength` aggregates to `LineIndexNode` (`src/types/state.ts`). The function now calls `getCharStartOffset(root, lineNumber)` — a single O(log n) tree descent accumulating `subtreeCharLength` — then reads only the partial current line for the within-line byte-to-char conversion. All line-index insert/delete operations (both eager and lazy) maintain `charLength` incrementally. For line splits that require knowing the char count of a byte prefix, a `ReadTextFn` callback is threaded from the reducer (which has piece table access).

### (b) `charOffsetsToSelection` — was O(n), now O(log n + line_length)

Previously this function called `getText(state.pieceTable, byteOffset(0), byteOffset(upperBoundBytes))` — always reading from the document start, O(n) for positions late in the document.

**Fix**: Added `findLineAtCharPosition(root, charOffset)` — an O(log n) tree descent using `subtreeCharLength` that finds the line containing a given character offset. The function now descends the tree to find the target line, reads only that line's text, and uses `charToByteOffset` within the line to find the exact byte position.

## 4. Specific Implementations — Formalization Proposals

Rather than adding documentation or wrappers, the goal is to make complexity **structurally unambiguous** so the type system or naming convention forces correct usage.

---

### Proposal A: Complexity-Branded Return Types (Done)

Cost brands encode algorithmic complexity in function return types using a numeric `CostBrand<Level>` phantom type with natural widening:

```typescript
// In src/types/branded.ts — zero runtime cost
declare const costLevel: unique symbol;
type CostBrand<Level extends number> = { readonly [costLevel]: Level };

type ConstCost<T>  = T & CostBrand<0>;         // O(1)
type LogCost<T>    = T & CostBrand<0 | 1>;      // O(log n)
type LinearCost<T> = T & CostBrand<0 | 1 | 2>;  // O(n)
```

Widening is automatic via TypeScript union assignability: `CostBrand<0>` is assignable to `CostBrand<0 | 1>` is assignable to `CostBrand<0 | 1 | 2>`. No conditional types needed.

Annotated functions:

| Function | Return Type | Cost Level |
|---|---|---|
| `getLength` | `ConstCost<number>` | O(1) |
| `getLineCountFromIndex` | `ConstCost<number>` | O(1) |
| `getText` | `LogCost<string>` | O(log n + m) |
| `getLineContent` | `LogCost<string>` | O(log n) |
| `getLineRange` | `LogCost<{ start, length }> \| null` | O(log n) |
| `getLineRangePrecise` | `LogCost<{ start, length }> \| null` | O(log n) |
| `getValue` | `LinearCost<string>` | O(n) |

Constructor functions `constCost()`, `logCost()`, `linearCost()` are zero-cost casts exported from `src/types/branded.ts`.

### Proposal B: Namespace-Based API Stratification (Done)

The public API now offers complexity-stratified namespace objects alongside flat exports:

```typescript
import { query, scan } from 'reed';

query.getText(state, start, end);     // O(log n + m)
query.getLineContent(state, lineNum); // O(log n)
query.getLength(state);               // O(1)

scan.getValue(state);                 // O(n)
scan.collectPieces(state.root);       // O(n)
scan.getValueStream(state, opts);     // O(n) streaming
```

**Implementation**: `src/api/query.ts` re-exports O(log n) and O(1) operations. `src/api/scan.ts` re-exports O(n) operations. Both are re-exported from `src/api/index.ts` and `src/index.ts`. Existing flat exports remain unchanged — namespaces are additive and non-breaking.

A consumer importing from `scan` *knows* they are opting into linear cost. A code review can grep for `scan.` to audit performance hotspots.

### Proposal C: Evaluation Strategy as a Type Parameter (Done)

The lazy/eager distinction is now visible in the state type system:

```typescript
type EvaluationMode = 'eager' | 'lazy';

interface LineIndexState<M extends EvaluationMode = EvaluationMode> {
  readonly root: LineIndexNode | null;
  readonly lineCount: number;
  readonly dirtyRanges: M extends 'eager' ? readonly [] : readonly DirtyLineRange[];
  readonly rebuildPending: M extends 'eager' ? false : boolean;
  // ...
}

interface DocumentState<M extends EvaluationMode = EvaluationMode> {
  readonly lineIndex: LineIndexState<M>;
  // ...
}
```

`getLineRange` requires `LineIndexState<'eager'>` — calling it on `LineIndexState<'lazy'>` is a compile error. `getLineRangePrecise` accepts either mode. `reconcileNow()` returns `DocumentState<'eager'>`, narrowing the type and serving as the contract discharge point.

The default generic parameter `= EvaluationMode` (the union type) preserves full backward compatibility — all existing unqualified `LineIndexState` and `DocumentState` references compile unchanged.

### Proposal D: Remove the O(n) `getLine` from Public API (Done)

`getLine` has been renamed to `getLineLinearScan` and removed from the public API (`src/index.ts`, `src/store/index.ts`). It remains in `src/store/core/piece-table.ts` for internal/test use only. The cost is now self-documenting in the name.

---

## 5. Type-Level Cost Contracts — Unified Framework (Implemented)

The four proposals each address one dimension of a broader pattern: **type-level cost contracts**. The type system encodes and propagates performance and staleness guarantees as branded contracts, with specific functions serving as discharge points that narrow the contract.

The following table maps each structural guarantee to its TypeScript mechanism and implementation status:

| Structural Guarantee | TypeScript Mechanism | Where It Applies | Status |
|---|---|---|---|
| **Cost contract** — branded into return type | `CostBrand<Level>` on return types | `getText` → `LogCost`, `getValue` → `LinearCost`, `getLength` → `ConstCost` | **Done** |
| **Contract discharge / narrowing point** | Generic parameter narrowing via return type | `reconcileNow()` returns `DocumentState<'eager'>` | **Done** |
| **Parametric state mode** | `DocumentState<M extends EvaluationMode>` | `LineIndexState`, `DocumentState` carry their evaluation mode | **Done** |
| **Contract stacking** — orthogonal contracts composed via intersection | `LogCost & EagerState` as intersection brands | `getLineRange` on `DocumentState<'eager'>` returns `LogCost<LineRange>` — both cost and staleness are visible | **Done** |
| **Contract fidelity** — implementation satisfies its branded promise | `subtreeCharLength` aggregate + tree queries | `byteOffsetToCharOffset` and `charOffsetsToSelection` satisfy their O(log n + line_length) contracts | **Done** |
| **Cost widening** — a stricter contract satisfies a looser one | Numeric `CostBrand<Level>` union assignability | `ConstCost<T>` assignable to `LogCost<T>` assignable to `LinearCost<T>` | **Done** |
| **Namespace stratification** — cost tier visible at import site | `query.*` vs `scan.*` namespace objects | All O(log n)/O(1) functions in `query`, all O(n) in `scan` | **Done** |

### Contract Stacking: Proposals A and C Compose

Proposals A (cost contracts) and C (parametric state mode) are orthogonal and compose as designed:

- `getLineRange` on `DocumentState<'eager'>` returns `LogCost<LineRange>` — both the cost and the staleness contract are visible.
- `getLineRange` on `DocumentState<'lazy'>` is a compile error — the staleness contract is unsatisfied.
- `getLineRangePrecise` on `DocumentState<'lazy'>` returns `LogCost<LineRange>` — it internally discharges the staleness by applying dirty-range deltas.

### Contract Fidelity Violations (Sections 3a and 3b) — Resolved

Both violations have been fixed by adding `charLength` / `subtreeCharLength` aggregates to `LineIndexNode` and rewriting the affected functions:

**(a) `byteOffsetToCharOffset`**: Now uses `getCharStartOffset(root, lineNumber)` — O(log n) prefix sum via `subtreeCharLength` — instead of the per-line loop. Contract fidelity restored.

**(b) `charOffsetsToSelection`**: Now uses `findLineAtCharPosition(root, charOffset)` — O(log n) tree descent via `subtreeCharLength` — instead of `getText` from byte 0. Reads only the target line. Contract fidelity restored.

The `subtreeCharLength` aggregate is maintained incrementally through all insert/delete operations (both eager and lazy paths). For line splits where the char count of a byte prefix is needed, a `ReadTextFn` callback is passed from the reducer.

### Cost Widening: Numeric Brand Hierarchy

The cost brands use a numeric level scheme where widening is automatic via TypeScript's union assignability:

```typescript
type CostBrand<Level extends number> = { readonly [costLevel]: Level };

type ConstCost<T>  = T & CostBrand<0>;         // Level 0
type LogCost<T>    = T & CostBrand<0 | 1>;      // Level 0 | 1
type LinearCost<T> = T & CostBrand<0 | 1 | 2>;  // Level 0 | 1 | 2
```

Since `0 extends 0 | 1` in TypeScript, `CostBrand<0>` is assignable to `CostBrand<0 | 1>`, giving `ConstCost<T>` natural assignability to `LogCost<T>`. No conditional mapped types or explicit widening functions are needed.

## 6. Fragility Assessment

**~~Most likely to be bypassed~~**: ~~The `getLineRange` vs `getLineRangePrecise` distinction.~~ **Resolved** — `getLineRange` now requires `LineIndexState<'eager'>`. Calling it on lazy state is a compile error (Proposal C). The sole internal caller in `getLineContent` has been migrated to `getLineRangePrecise`.

**Most likely to become fragile**: The `charLength` / `subtreeCharLength` aggregate on `LineIndexNode`. Every code path that creates or modifies line index nodes must correctly maintain this aggregate. The `withLineIndexNode` helper recomputes `subtreeCharLength` automatically from children, but per-node `charLength` must be set correctly at every insert/delete/split site. A new code path that creates a `LineIndexNode` without setting `charLength` would silently corrupt all downstream char-offset queries.

**All issues resolved**:

1. ~~Remove or rename `getLine` (Proposal D)~~ — **Done**. Renamed to `getLineLinearScan`, removed from public API.
2. ~~Fix `byteOffsetToCharOffset` and `charOffsetsToSelection`~~ — **Done**. Both now use O(log n) tree-aggregate queries via `subtreeCharLength`.
3. ~~Namespace stratification (Proposal B)~~ — **Done**. `query` and `scan` namespaces in `src/api/`. Flat exports preserved for backward compatibility.
4. ~~Evaluation-mode type parameter (Proposal C)~~ — **Done**. `EvaluationMode` parameterizes `LineIndexState` and `DocumentState`. `getLineRange` requires eager state. `reconcileNow()` returns `DocumentState<'eager'>`.
5. ~~Cost contracts with widening (Proposal A)~~ — **Done**. `ConstCost`, `LogCost`, `LinearCost` with numeric `CostBrand<Level>` for automatic widening. Key functions annotated.
