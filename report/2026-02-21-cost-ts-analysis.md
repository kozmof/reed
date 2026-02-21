# Code Analysis: `src/types/cost.ts`

**Date:** 2026-02-21

---

## 1. Code Organization and Structure

The file is cleanly divided into two major sections:

- **Cost Algebra + Brands** (lines 13–294): Type-level arithmetic (`Nat`, `Cost`, `GteNat`, `GteCost`), brand types (`Costed`, `CostFn`), and value-level combinators (`$mapCost`, `$chainCost`, `$zipCost`).
- **Cost Context Pipeline** (lines 296–422): `Ctx<C,T>` monad-like pipeline with `$cost`, `$pipe`, `$andThen`, `$map`, `$sort`, `$filter`, `$forEachN`, etc.

The usage policy in the header is a good architectural guide. The file is used widely: re-exported through both `src/types/branded.ts` (lines 280–327) and `src/types/index.ts` (lines 83–155).

---

## 2. Relations: Types and Interfaces

```
Nat (0|1|2|3)
  ─> AddNat<A,B>          saturating addition
  ─> GteNat<A,B>          comparison

Cost { p: Nat; l: Nat }   asymptotic pair (O(n^p · log^l n))
  ─> GteCost, MaxCost
  ─> Seq<A,B> = MaxCost   sequential → dominant cost
  ─> Nest<A,B>            nested → additive cost (multiplicative asymptotically)
  ─> Leq, Assert

CostLabel / CostBigO / CostInputLabel
  ─> NormalizeCostLabel   'O(n)' → 'linear', etc.
  ─> CostOfLabel          label → Cost pair
  ─> C_CONST/C_LOG/...    named cost constants

LevelsUpTo<L>             union of all labels ≤ L
  ─> CostBrand<Level>     phantom brand (unique symbol, zero runtime)
  ─> Costed<Level, T>     T & CostBrand<LevelsUpTo<Level>>
  ─> ConstCost<T> ... QuadCost<T>   convenience aliases

CostFn<Level, Args, R>    function with cost annotation
JoinCostLevel<A,B>        dominant level for CostFn composition

Ctx<C, T>                 { _cost: C (phantom), value: T }
CheckedPlan<C, T>         { [checkedPlanTag]: true, run: () => Ctx<C,T> }
```

**Key insight** — `LevelsUpTo<L>` makes `Costed<'linear', T>` equal to `T & CostBrand<'const' | 'log' | 'linear'>`. This is what enables natural widening: a `ConstCost<T>` is assignable to `LinearCost<T>` because `'const'` is included in the 'linear' union.

---

## 3. Relations: Functions

### Track 1 — Branded values

| Function | Role | Cost propagation |
|---|---|---|
| `castCost` | Internal identity cast | N/A |
| `annotateCostFn` | Wraps fn → CostFn | Declares level |
| `$constCostFn` ... `$quadCostFn` | Level-specific wrappers | Fixed level |
| `$composeCostFn` | CostFn → CostFn chain | `JoinCostLevel` (dominant) |
| `$mapCost` | Pure transform on Costed | Preserves level |
| `$chainCost` | Bind / flatMap on Costed | `JoinCostLevel` (dominant) |
| `$zipCost` | Combine two Costed | `JoinCostLevel` (dominant) |

### Track 2 — Ctx pipeline

| Function | Role | Cost propagation |
|---|---|---|
| `$cost` | Seed | `C_CONST` |
| `$fromCosted` | Lift Costed → Ctx | Preserves via `CostOfLabel` |
| `$checked` | Wrap plan for `$` validation | Wraps run() |
| `$pipe` | Generic pipeline | Pass-through |
| `$andThen` | Monadic bind | `Seq<C1, C2>` |
| `$map` | O(1) transform | `Seq<C, C_CONST>` |
| `$binarySearch` | O(log n) lookup | `Seq<C, C_LOG>` |
| `$sort` | O(n log n) sort | `Seq<C, C_NLOGN>` |
| `$filter` | O(n) filter | `Seq<C, C_LIN>` |
| `$linearScan` | O(n) find | `Seq<C, C_LIN>` |
| `$forEachN` | O(n·body) nested loop | `Seq<C, Nest<C_LIN, BodyC>>` |

**Bridge**: The `$` function (line 163) accepts both tracks. It dispatches at runtime via `checkedPlanTag in boundary`.

---

## 4. Specific Contexts and Usages

The cost system is actively used in the store layer:

- `src/store/core/line-index.ts` — most intensive usage: `LogCost<LineLocation>`, `LogCost<LineIndexNode>`, `LinearCost<...>`, full `$pipe`/`$checked`/`$binarySearch` patterns.
- `src/store/core/piece-table.ts` — similar patterns.
- `src/store/features/rendering.ts` — uses cost-typed return values.

The dominant pattern in the store:
```ts
function lookup(...): LogCost<LineLocation> | null {
  const result = $('O(log n)', $cost(computedValue));
  return result;
}
```

`src/types/branded.test.ts` is comprehensive — it covers widening, `@ts-expect-error` regression tests, `$forEachN` nesting, and `$fromCosted` + `$andThen` incremental composition.

---

## 5. Pitfalls

### P1 — `$binarySearch` uses `indexOf` (O(n)) — line 380
```ts
({ value: c.value.indexOf(x) } as Ctx<Seq<C, C_LOG>, number>)
```
The type claims O(log n) but the runtime is O(n). The comment notes "intentionally simple," but any call site believing this is an actual binary search will have incorrect performance. This is the most impactful pitfall.

### P2 — `castCost` has a dead branch — lines 148–154
The if-chain checks `const/log/linear/nlogn` but never explicitly handles `'quad'`. The function returns correctly because the final `return value as Costed<L, T>` is always reached. The `level` parameter is entirely unused at runtime — all branches do the same thing.

### P3 — `$forEachN` discards body results — lines 414–421
```ts
c.value.forEach((e) => { body(e); });
return ({ value: c.value } as ...); // original array unchanged
```
The combinator models the cost of a loop body but returns the original array unchanged. It only models the cost of side-effectful loops — there is no `$mapN` for element-wise transformation.

### P4 — `$map` uses `Seq<C, C_CONST>` instead of `C` — line 370
`Seq<C, C_CONST> = MaxCost<C, C_CONST> = C` for all `C` since C_CONST is the minimum. The type is correct but the indirection makes the signature harder to read than necessary.

### P5 — Duplicate export paths
`cost.ts` is re-exported in both `branded.ts` (lines 280–327) and `index.ts` (lines 83–155). Two routes to the same exports exist, which is redundant and could cause confusion about the canonical import path.

---

## 6. Improvement Points: Design Overview

### D1 — Two-track API complexity
The `Costed<L,T>` / `CostFn` track and the `Ctx<C,T>` pipeline track overlap in purpose. The `$fromCosted` bridge helps, but users must understand when to use which. A unified `Ctx`-only API would be simpler.

### D2 — No runtime verification mode
The system is entirely compile-time. There is no opt-in development mode to assert that actual operations stay within declared costs (e.g., via counters or tracing). Incorrect annotations are silent.

### D3 — `$pipe` is not cost-aware
`$pipe` is a generic pipeline utility (line 341). Cost accumulation is driven by the combinator types passed into it. Cost inference only works when the user pipes through cost-typed combinators — raw functions lose cost context.

---

## 7. Improvement Points: Types and Interfaces

### T1 — `$map` return type simplification
```ts
// Current (verbose)
<C extends Cost>(c: Ctx<C, T>): Ctx<Seq<C, C_CONST>, U>
// Equivalent (direct)
<C extends Cost>(c: Ctx<C, T>): Ctx<C, U>
```

### T2 — `LevelsUpTo<L>` is unexported
This utility could be valuable for external generic constraints (e.g., "this function accepts any cost ≤ linear").

### T3 — No `MaxNat` / `MinNat` primitives
The algebra defines `AddNat` and `GteNat` but no explicit `MaxNat`/`MinNat`. `MaxCost` computes max via `GteCost`, but a direct `MaxNat<A,B>` would complete the algebra.

---

## 8. Improvement Points: Implementations

### I1 — `castCost` is a no-op wrapper
```ts
// All branches do identical things at runtime — simplified:
function castCost<L extends CostLevel, T>(_level: L, value: T): Costed<L, T> {
  return value as Costed<L, T>;
}
```
The `level` parameter could be prefixed `_level` to signal it is intentionally unused.

### I2 — `annotateCostFn` allocates an extra function per call
```ts
// Current: wraps fn in a new arrow function + castCost call on every invocation
return ((...args) => castCost(level, fn(...args))) as CostFn<L, Args, R>;
// Simpler (no extra allocation):
return fn as unknown as CostFn<L, Args, R>;
```
Since `castCost` is a no-op, the wrapper only adds call overhead.

### I3 — `$binarySearch` should match its contract
Either rename to `$linearSearch` / `$indexOf`, or implement an actual binary search (requires sorted input):
```ts
export const $binarySearch = (x: number) =>
  <C extends Cost>(c: Ctx<C, readonly number[]>): Ctx<Seq<C, C_LOG>, number> => {
    let lo = 0, hi = c.value.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c.value[mid] === x) return { value: mid } as Ctx<Seq<C, C_LOG>, number>;
      if (c.value[mid] < x) lo = mid + 1; else hi = mid - 1;
    }
    return { value: -1 } as Ctx<Seq<C, C_LOG>, number>;
  };
```

### I4 — `$` runtime normalization could use a lookup map
```ts
const LABEL_MAP: Record<CostBigO, CostLabel> = {
  'O(1)': 'const', 'O(log n)': 'log', 'O(n)': 'linear',
  'O(n log n)': 'nlogn', 'O(n^2)': 'quad',
};
const level = LABEL_MAP[max as CostBigO] ?? (max as CostLabel);
```
More maintainable than the if-chain at lines 175–181.

---

## 9. Learning Paths

| Step | Concept | Location |
|---|---|---|
| 1 | `Nat` and saturating arithmetic | cost.ts lines 27–46 |
| 2 | `Cost = { p, l }` and `CostOfLabel` | cost.ts lines 51–87 |
| 3 | `LevelsUpTo<L>` + `Costed<L,T>` widening | cost.ts lines 107–130 |
| 4 | `$` boundary enforcement via `Leq` constraint | cost.ts lines 163–187 |
| 5 | `Ctx<C,T>` and `$cost/$pipe/$andThen` | cost.ts lines 304–363 |
| 6 | `Seq` vs `Nest` cost propagation | cost.ts lines 98–99, `$forEachN` line 414 |
| 7 | Full usage in practice | `src/store/core/line-index.ts`, `src/types/branded.test.ts` lines 300–373 |

The most illuminating test cases for understanding the system are the `$forEachN` nesting tests in `branded.test.ts` (lines 324–355) — they demonstrate how `Nest<C_LIN, C_LOG>` infers `nlogn` and `Nest<C_LIN, C_LIN>` infers `quad`, which is the core value of the whole system.
