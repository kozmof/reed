# Formalization Analysis: Transparent Complexity & Evaluation Strategy

## 1. Data Structures — Hidden Complexity Contracts

The public API exports functions like `getValue`, `getText`, and `getLineContent` as peers — flat functions with identical call signatures. A consumer cannot distinguish O(n) from O(log n) without reading implementation.

| Function | Actual Complexity | Visible from signature? |
|---|---|---|
| `getValue` | O(n) | No |
| `getText` | O(log n + m) | No |
| ~~`getLine`~~ (removed) | O(n) | Renamed to `getLineLinearScan`, no longer public |
| `getLineContent` (rendering) | O(log n) | Only via JSDoc |
| `getBufferStats` | O(1) | Only via JSDoc |
| `getLength` | O(1) | No |

**Resolved**: `getLine` has been renamed to `getLineLinearScan` and removed from the public API (`src/index.ts`). It remains available internally in `src/store/core/piece-table.ts` for low-level use. Only `getLineContent` is now exported as the public line-access function.

## 2. Interfaces — The `LineIndexStrategy` Duality is Well-Formalized, But Invisible to Consumers

The `LineIndexStrategy` interface in `src/types/store.ts:177` cleanly separates eager vs. lazy. The reducer in `src/store/reducer.ts:114-134` correctly uses `eagerLineIndex` for undo/redo and `lazyLineIndex` for normal edits.

However, the strategy choice is **fully internal**. From a consumer's perspective:

- `dispatch({ type: 'INSERT', ... })` — uses lazy. No way to know.
- `dispatch({ type: 'UNDO' })` — uses eager. No way to know.
- The reconciliation lifecycle (`scheduleReconciliation`, `reconcileNow`, `setViewport`) is exposed on `ReconcilableDocumentStore`, but there is no type-level indication that *lazy operations require reconciliation before reads are accurate*.

A consumer calling `getLineRange` after a lazy insert will get stale data. Only `getLineRangePrecise` applies dirty-range deltas. These two functions differ by a single word in their name — a fragile distinction for a correctness-critical difference.

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

### Proposal A: Complexity-Branded Return Types

Extend the existing branded-type pattern to encode complexity in result types:

```typescript
// In branded.ts — zero runtime cost
type LogResult<T> = T & Brand<'O(log n)'>;
type LinearResult<T> = T & Brand<'O(n)'>;
type ConstResult<T> = T & Brand<'O(1)'>;
```

Functions would return branded results:

```typescript
function getText(state, start, end): LogResult<string>;
function getValue(state): LinearResult<string>;
function getLength(state): ConstResult<number>;
```

A consumer writing `renderLine(getValue(state))` gets a `LinearResult<string>` — the brand propagates through the type system and makes the cost visible at every call site.

**Trade-off**: This is the most formal approach but adds type noise. It works best if the codebase already has branded-type conventions (which it does).

### Proposal B: Namespace-Based API Stratification

Group exports by complexity tier using module namespaces:

```typescript
// Expose as:
import { query, scan } from 'reed';

query.getText(state, start, end);     // O(log n + m)
query.getLineContent(state, lineNum); // O(log n)
query.getLength(state);               // O(1)

scan.getValue(state);                 // O(n)
scan.getLine(state, lineNum);         // O(n)
scan.getValueStream(state, opts);     // O(n) streaming
```

A consumer importing from `scan` *knows* they are opting into linear cost. A code review can grep for `scan.` to audit performance hotspots.

**This removes `getLine` vs `getLineContent` ambiguity entirely** — they live in different namespaces with different cost contracts.

### Proposal C: Evaluation Strategy as a Type Parameter

Make the lazy/eager distinction visible in the state type:

```typescript
type EvaluationMode = 'eager' | 'lazy';

interface LineIndexState<M extends EvaluationMode = EvaluationMode> {
  readonly root: LineIndexNode | null;
  readonly lineCount: number;
  readonly dirtyRanges: M extends 'lazy' ? readonly DirtyLineRange[] : readonly [];
  readonly rebuildPending: M extends 'lazy' ? boolean : false;
  // ...
}
```

Then `getLineRange` would require `LineIndexState<'eager'>` while `getLineRangePrecise` accepts either. A consumer calling `getLineRange` on a `LineIndexState<'lazy'>` gets a compile error — not silent stale data.

The `DocumentState` itself could carry this:

```typescript
interface DocumentState<M extends EvaluationMode = EvaluationMode> {
  readonly lineIndex: LineIndexState<M>;
  // ...
}
```

After `reconcileNow()`, the store could return `DocumentState<'eager'>`, narrowing the type.

### Proposal D: Remove the O(n) `getLine` from Public API (Done)

`getLine` has been renamed to `getLineLinearScan` and removed from the public API (`src/index.ts`, `src/store/index.ts`). It remains in `src/store/core/piece-table.ts` for internal/test use only. The cost is now self-documenting in the name.

---

## 5. Type-Level Cost Contracts — Unified Framework

The four proposals above each address one dimension of a broader pattern: **type-level cost contracts**. Rather than relying on documentation or naming conventions alone, the type system encodes and propagates performance and staleness guarantees as branded contracts, with specific functions serving as discharge points that narrow the contract.

The following table maps each structural guarantee to its TypeScript-native mechanism:

| Structural Guarantee | TypeScript Mechanism | Where It Applies |
|---|---|---|
| **Cost contract** — branded into return type | `Brand<'O(log n)'>` on return types (Proposal A) | `getText`, `getValue`, `getLength`, etc. |
| **Contract discharge / narrowing point** — a function that narrows a contract from loose to strict | Generic parameter narrowing via return type | `reconcileNow()` narrows `DocumentState<'lazy'>` to `DocumentState<'eager'>` (Proposal C) |
| **Parametric state mode** — state parameterized over its mode | `DocumentState<M extends EvaluationMode>` | `LineIndexState`, `DocumentState` carry their evaluation mode |
| **Contract stacking** — orthogonal contracts composed via intersection | `LogCost & CleanRead` as intersection brands | A value can carry both a cost contract and a staleness contract simultaneously |
| **Contract fidelity** — implementation must satisfy its branded promise | Code review / test invariant / `subtreeCharLength` aggregate | `byteOffsetToCharOffset` and `charOffsetsToSelection` now satisfy their O(log n + line_length) contracts via tree-aggregate queries |
| **Cost widening** — a stricter contract satisfies a looser one | Branded-type hierarchy with assignability | `ConstResult<T>` assignable to `LogResult<T>` assignable to `LinearResult<T>` |

### Contract Stacking: Proposals A and C Compose

Proposals A (cost contracts) and C (parametric state mode) are not alternatives — they are orthogonal and should compose. A function's return value can carry both dimensions:

- `getLineRange` on `DocumentState<'eager'>` returns `LogResult<LineRange>` — both the cost and the staleness contract are visible.
- `getLineRange` on `DocumentState<'lazy'>` is a compile error — the staleness contract is unsatisfied.
- `getLineRangePrecise` on `DocumentState<'lazy'>` returns `LogResult<LineRange>` — it internally discharges the staleness by applying dirty-range deltas.

In TypeScript, this composes naturally via intersection brands: a value of type `string & Brand<'O(log n)'> & Brand<'clean'>` carries both contracts.

### Contract Fidelity Violations (Sections 3a and 3b) — Resolved

Both violations have been fixed by adding `charLength` / `subtreeCharLength` aggregates to `LineIndexNode` and rewriting the affected functions:

**(a) `byteOffsetToCharOffset`**: Now uses `getCharStartOffset(root, lineNumber)` — O(log n) prefix sum via `subtreeCharLength` — instead of the per-line loop. Contract fidelity restored.

**(b) `charOffsetsToSelection`**: Now uses `findLineAtCharPosition(root, charOffset)` — O(log n) tree descent via `subtreeCharLength` — instead of `getText` from byte 0. Reads only the target line. Contract fidelity restored.

The `subtreeCharLength` aggregate is maintained incrementally through all insert/delete operations (both eager and lazy paths). For line splits where the char count of a byte prefix is needed, a `ReadTextFn` callback is passed from the reducer.

### Cost Widening: Branded Hierarchy

If Proposal A is adopted, the cost brands need a widening relationship so that stricter contracts are assignable to looser ones:

```typescript
// O(1) satisfies any context expecting O(log n) or O(n)
// O(log n) satisfies any context expecting O(n)
type CostLevel = 'O(1)' | 'O(log n)' | 'O(n)';

// Widening via conditional mapped types:
type SatisfiesCost<Actual extends CostLevel, Required extends CostLevel> =
  Required extends 'O(n)' ? true :
  Required extends 'O(log n)' ? (Actual extends 'O(n)' ? false : true) :
  Actual extends 'O(1)' ? true : false;
```

Without this, `getLength()` (returning `ConstResult<number>`) would not be assignable where `LogResult<number>` is expected — the type system would reject correct usage.

## 6. Fragility Assessment

**Most likely to be bypassed**: The `getLineRange` vs `getLineRangePrecise` distinction. A contributor will call `getLineRange` in rendering code (shorter name, appears first in exports) and introduce a subtle stale-offset bug that only manifests under lazy mode with dirty ranges. Nothing in the type system prevents this. With Proposal C, this becomes a compile error — the parametric state mode rejects the call entirely.

**Most likely to become fragile**: The `charLength` / `subtreeCharLength` aggregate on `LineIndexNode`. Every code path that creates or modifies line index nodes must correctly maintain this aggregate. The `withLineIndexNode` helper recomputes `subtreeCharLength` automatically from children, but per-node `charLength` must be set correctly at every insert/delete/split site. A new code path that creates a `LineIndexNode` without setting `charLength` would silently corrupt all downstream char-offset queries.

**Resolved issues**:

1. ~~Remove or rename `getLine` (Proposal D)~~ — **Done**. Renamed to `getLineLinearScan`, removed from public API.
2. ~~Fix `byteOffsetToCharOffset` and `charOffsetsToSelection`~~ — **Done**. Both now use O(log n) tree-aggregate queries via `subtreeCharLength`.

**Remaining structural recommendations**:

3. Namespace stratification (Proposal B) — makes all future additions self-documenting
4. Evaluation-mode type parameter (Proposal C) — prevents stale-read bugs at compile time via contract discharge
5. Cost contracts with widening (Proposal A + cost hierarchy) — makes cost visible and composable at every call site
