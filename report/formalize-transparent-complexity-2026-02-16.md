# Formalization Analysis: Transparent Complexity & Evaluation Strategy

## 1. Data Structures — Hidden Complexity Contracts

The public API exports functions like `getValue`, `getText`, `getLine`, and `getLineContent` as peers — flat functions with identical call signatures. A consumer cannot distinguish O(n) from O(log n) without reading implementation.

| Function | Actual Complexity | Visible from signature? |
|---|---|---|
| `getValue` | O(n) | No |
| `getText` | O(log n + m) | No |
| `getLine` (piece-table) | O(n) | Only via JSDoc |
| `getLineContent` (rendering) | O(log n) | Only via JSDoc |
| `getBufferStats` | O(1) | Only via JSDoc |
| `getLength` | O(1) | No |

Both `getLine` and `getLineContent` are exported from `src/index.ts`. Nothing at the type level prevents a consumer from using the O(n) `getLine` in a render loop where `getLineContent` should be used.

**Structural issue**: `getLine` in `src/store/piece-table.ts:891` operates on `PieceTableState`, while `getLineContent` in `src/store/rendering.ts:106` operates on `DocumentState`. This difference is the *only* structural hint — but it requires the consumer to already understand the type hierarchy to notice it.

## 2. Interfaces — The `LineIndexStrategy` Duality is Well-Formalized, But Invisible to Consumers

The `LineIndexStrategy` interface in `src/types/store.ts:177` cleanly separates eager vs. lazy. The reducer in `src/store/reducer.ts:114-134` correctly uses `eagerLineIndex` for undo/redo and `lazyLineIndex` for normal edits.

However, the strategy choice is **fully internal**. From a consumer's perspective:

- `dispatch({ type: 'INSERT', ... })` — uses lazy. No way to know.
- `dispatch({ type: 'UNDO' })` — uses eager. No way to know.
- The reconciliation lifecycle (`scheduleReconciliation`, `reconcileNow`, `setViewport`) is exposed on `ReconcilableDocumentStore`, but there is no type-level indication that *lazy operations require reconciliation before reads are accurate*.

A consumer calling `getLineRange` after a lazy insert will get stale data. Only `getLineRangePrecise` applies dirty-range deltas. These two functions differ by a single word in their name — a fragile distinction for a correctness-critical difference.

## 3. Algorithms — Two Specific Formalization Gaps

### (a) `byteOffsetToCharOffset` is accidentally O(n)

In `src/store/rendering.ts:360-394`, the function claims to be "O(line_length + log n)" but contains a loop `for (let line = 0; line < location.lineNumber; line++)` that iterates over all preceding lines. For a position near the end of a 100K-line document, this is O(n). The `subtreeByteLength` aggregate already exists on `LineIndexNode` — this loop could be replaced with an O(log n) tree query that accumulates char counts, or a new `subtreeCharLength` aggregate.

### (b) `charOffsetsToSelection` reads from byte 0

In `src/store/rendering.ts:414-426`, `charOffsetsToSelection` reads `getText(state.pieceTable, byteOffset(0), byteOffset(upperBoundBytes))` — always from the document start. This is O(n) for positions late in the document, despite the comment claiming "O(k) instead of O(n)" (the bound `maxChar * 4` is still proportional to position).

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

### Proposal D: Remove the O(n) `getLine` from Public API

The simplest structural fix: stop exporting `getLine` from `src/index.ts`. It exists in `src/store/piece-table.ts:891` with an explicit comment saying to use `getLineContent` instead. Keeping it exported is a trap.

If it must remain for backward compatibility, rename it `getLineLinearScan` to make the cost self-documenting.

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
| **Contract fidelity** — implementation must satisfy its branded promise | Code review / test invariant | `byteOffsetToCharOffset` violates its contract: the branded return type promises O(log n) but the loop is O(n) |
| **Cost widening** — a stricter contract satisfies a looser one | Branded-type hierarchy with assignability | `ConstResult<T>` assignable to `LogResult<T>` assignable to `LinearResult<T>` |

### Contract Stacking: Proposals A and C Compose

Proposals A (cost contracts) and C (parametric state mode) are not alternatives — they are orthogonal and should compose. A function's return value can carry both dimensions:

- `getLineRange` on `DocumentState<'eager'>` returns `LogResult<LineRange>` — both the cost and the staleness contract are visible.
- `getLineRange` on `DocumentState<'lazy'>` is a compile error — the staleness contract is unsatisfied.
- `getLineRangePrecise` on `DocumentState<'lazy'>` returns `LogResult<LineRange>` — it internally discharges the staleness by applying dirty-range deltas.

In TypeScript, this composes naturally via intersection brands: a value of type `string & Brand<'O(log n)'> & Brand<'clean'>` carries both contracts.

### Contract Fidelity Violations (Sections 3a and 3b)

The algorithm bugs identified in Section 3 are contract fidelity violations — the implementation does not satisfy the cost its type promises:

**(a) `byteOffsetToCharOffset`**: The function's signature and JSDoc promise O(log n + line_length), but the `for (let line = 0; ...)` loop makes it O(n). The `subtreeByteLength` aggregate already exists on `LineIndexNode` — restoring contract fidelity requires either replacing the loop with an O(log n) tree query or adding a `subtreeCharLength` aggregate. This is not merely a performance bug; it is a structural lie in the type contract.

**(b) `charOffsetsToSelection`**: Reading from `byteOffset(0)` delegates a hidden O(n) cost to `getText`. The function claims to handle `CharOffset → ByteOffset` conversion locally, but actually externalizes the cost. Contract fidelity requires handling the conversion via binary search on the tree rather than materializing a substring.

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

**Most likely to become fragile**: The `byteOffsetToCharOffset` loop in `src/store/rendering.ts:376`. As the document grows, this silently degrades. This is a contract fidelity violation — the function's type promises sublinear cost but the implementation is linear. The per-line loop should be replaced with a tree-aggregate query.

**Structural recommendation priority**:

1. Remove or rename `getLine` (Proposal D) — eliminates the primary O(n) trap
2. Fix `byteOffsetToCharOffset` and `charOffsetsToSelection` to restore contract fidelity — eliminates hidden O(n) regressions
3. Namespace stratification (Proposal B) — makes all future additions self-documenting
4. Evaluation-mode type parameter (Proposal C) — prevents stale-read bugs at compile time via contract discharge
5. Cost contracts with widening (Proposal A + cost hierarchy) — makes cost visible and composable at every call site
