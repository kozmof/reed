# Code Analysis: `src/types/cost.ts`

**Date:** 2026-02-21
**Updated:** 2026-02-21 (P1–P5 resolved; D1, D3 resolved)

---

## 1. Code Organization and Structure

The file is cleanly divided into two major sections:

- **Cost Algebra + Brands** (lines 13–151): Type-level arithmetic (`Nat`, `Cost`, `GteNat`, `GteCost`), brand types (`Costed`, `CostFn`), and value-level combinators (`$mapCost`, `$chainCost`, `$zipCost`).
- **Cost Context Pipeline** (lines 296–433): `Ctx<C,T>` monad-like pipeline with `$cost`, `$pipe`, `$andThen`, `$map`, `$sort`, `$filter`, `$forEachN`, `$mapN`, etc.

The usage policy in the header is a good architectural guide. The file is the single canonical source for cost types, with a single composition model (the Ctx pipeline). Re-exported through `src/types/index.ts` and `src/index.ts`. Store files and tests import from `cost.ts` directly for cost items, and from `branded.ts` only for position types.

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

### Track 1 — Function boundary markers

| Function | Role | Cost propagation |
|---|---|---|
| `castCost` | Internal identity cast | N/A |
| `annotateCostFn` | Direct cast fn → CostFn | Declares level |
| `$constCostFn` ... `$quadCostFn` | Function-level `$` equivalent | Fixed level |

### Track 2 — Ctx pipeline (primary API)

| Function | Role | Cost propagation |
|---|---|---|
| `$cost` | Seed | `C_CONST` |
| `$from` | Lift Costed → Ctx | Preserves via `CostOfLabel` |
| `$checked` | Wrap plan for `$` validation | Wraps run() |
| `$pipe` | Generic pipeline | Pass-through |
| `$andThen` | Monadic bind | `Seq<C1, C2>` |
| `$map` | O(1) transform | `C` (preserved) |
| `$zipCtx` | Combine two Ctx values | `Seq<C1, C2>` (dominant) |
| `$binarySearch` | O(log n) lookup (sorted input) | `Seq<C, C_LOG>` |
| `$sort` | O(n log n) sort | `Seq<C, C_NLOGN>` |
| `$filter` | O(n) filter | `Seq<C, C_LIN>` |
| `$linearScan` | O(n) find | `Seq<C, C_LIN>` |
| `$forEachN` | O(n·body) side-effect loop | `Seq<C, Nest<C_LIN, BodyC>>` |
| `$mapN` | O(n·body) element-wise map | `Seq<C, Nest<C_LIN, BodyC>>` |

**Bridge**: The `$` function accepts both a `CheckedPlan` and a raw `Ctx`. It dispatches at runtime via `checkedPlanTag in boundary`. Function-annotated values (`CostFn`) enter the pipeline via `$from`.

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

`src/types/branded.test.ts` is comprehensive — it covers widening, `@ts-expect-error` regression tests, `$forEachN` nesting, and `$from` + `$andThen` incremental composition.

---

## 5. Pitfalls

### ~~P1 — `$binarySearch` uses `indexOf` (O(n))~~ — **Fixed**

Replaced the `indexOf` call with a proper binary search loop using unsigned right-shift for the safe midpoint. The combinator now correctly runs in O(log n). Requires sorted input, as documented in the JSDoc.

```ts
// Before
({ value: c.value.indexOf(x) } as Ctx<Seq<C, C_LOG>, number>)

// After
let lo = 0, hi = c.value.length - 1;
while (lo <= hi) {
  const mid = (lo + hi) >>> 1;
  const v = c.value[mid];
  if (v === x) return { value: mid } as Ctx<Seq<C, C_LOG>, number>;
  if (v < x) lo = mid + 1; else hi = mid - 1;
}
return { value: -1 } as Ctx<Seq<C, C_LOG>, number>;
```

### ~~P2 — `castCost` dead branch~~ — **Fixed**

Removed the dead if-chain. All branches were identical at runtime; branding is compile-time only. The `level` parameter is now named `_level` to signal it is intentionally unused.

```ts
// Before
function castCost<L extends CostLevel, T>(level: L, value: T): Costed<L, T> {
  if (level === 'const') return value as Costed<L, T>;
  if (level === 'log') return value as Costed<L, T>;
  if (level === 'linear') return value as Costed<L, T>;
  if (level === 'nlogn') return value as Costed<L, T>;
  return value as Costed<L, T>;
}

// After
function castCost<L extends CostLevel, T>(_level: L, value: T): Costed<L, T> {
  return value as Costed<L, T>;
}
```

### ~~P3 — `$forEachN` discards body results~~ — **Fixed**

Added a new `$mapN` combinator alongside `$forEachN`. `$forEachN` remains for side-effect-only loops and returns the original array; `$mapN` collects each body result into a new array. Both carry the same `Seq<C, Nest<C_LIN, BodyC>>` cost.

```ts
export const $mapN =
  <E, U, BodyC extends Cost>(body: (e: E) => Ctx<BodyC, U>) =>
  <C extends Cost>(c: Ctx<C, readonly E[]>): Ctx<Seq<C, Nest<C_LIN, BodyC>>, U[]> => {
    const result = c.value.map((e) => body(e).value);
    return ({ value: result } as Ctx<Seq<C, Nest<C_LIN, BodyC>>, U[]>);
  };
```

### ~~P4 — `$map` uses `Seq<C, C_CONST>` instead of `C`~~ — **Fixed**

`Seq<C, C_CONST> = MaxCost<C, C_CONST>` always reduces to `C` since `C_CONST` is the minimum cost. The return type is now simply `Ctx<C, U>`, making the signature clearer and removing an unnecessary conditional type evaluation.

```ts
// Before
<C extends Cost>(c: Ctx<C, T>): Ctx<Seq<C, C_CONST>, U>

// After
<C extends Cost>(c: Ctx<C, T>): Ctx<C, U>
```

### ~~P5 — Duplicate export paths~~ — **Fixed**

`branded.ts` was re-exporting all of `cost.ts` alongside its own position types, creating two import routes for cost items. The cost re-export block has been removed from `branded.ts`, which now exclusively owns branded position types (`ByteOffset`, `CharOffset`, etc.).

All importers have been updated:

| File | Position types | Cost types |
|---|---|---|
| `branded.test.ts` | `./branded.ts` | `./cost.ts` |
| `store/core/line-index.ts` | `../../types/branded.ts` | `../../types/cost.ts` |
| `store/core/piece-table.ts` | `../../types/branded.ts` | `../../types/cost.ts` |
| `store/features/rendering.ts` | `../../types/branded.ts` | `../../types/cost.ts` |

`index.ts` remains the single public re-export barrel for both, and now also exports `$mapN`.

---

## 6. Improvement Points: Design Overview

### ~~D1 — Two-track API complexity~~ — **Fixed**

The redundant Costed-value combinators (`$mapCost`, `$chainCost`, `$zipCost`, `$composeCostFn`) have been removed. The Ctx pipeline is now the single composition model. The mapping from Track 1 to Track 2:

| Removed | Replacement |
|---|---|
| `$mapCost(v, f)` | `$('O(...)', $pipe($from(v), $map(f)))` |
| `$chainCost(v, f)` | `$('O(...)', $pipe($from(v), $andThen(x => $from(f(x)))))` |
| `$zipCost(a, b, f)` | `$('O(...)', $zipCtx($from(a), $from(b), f))` |
| `$composeCostFn(g, h)` | `$pipe` / `$andThen` at call site |

`annotateCostFn` simplified to a direct cast (no wrapping arrow function). `$constCostFn` … `$quadCostFn` are kept as the function-level equivalent of `$`. `JoinCostLevel<A,B>` retained as a useful type utility.

Files updated: `cost.ts`, `store/features/rendering.ts`, `types/index.ts`, `src/index.ts`, `types/branded.test.ts`.

### D2 — No runtime verification mode
The system is entirely compile-time. There is no opt-in development mode to assert that actual operations stay within declared costs (e.g., via counters or tracing). Incorrect annotations are silent.

### ~~D3 — `$pipe` is not cost-aware~~ — **Fixed**

The five generic overloads (`(a: A, ab: (a: A) => B, ...) => ...`) have been replaced with `Ctx`-constrained overloads. Every step must now map a `Ctx<Ci, Ti>` to a `Ctx<Cj, Tj>`, so passing a raw function whose return type is not a `Ctx` is a compile-time error. The runtime implementation is unchanged. All existing call sites already comply — they use `$cost` / `$from` as the seed and cost-typed combinators (`$map`, `$andThen`, `$binarySearch`, etc.) for every step.

---

## 7. Improvement Points: Types and Interfaces

### ~~T1 — `$map` return type simplification~~ — **Resolved by P4 fix**

### T2 — `LevelsUpTo<L>` is unexported
This utility could be valuable for external generic constraints (e.g., "this function accepts any cost ≤ linear").

### T3 — No `MaxNat` / `MinNat` primitives
The algebra defines `AddNat` and `GteNat` but no explicit `MaxNat`/`MinNat`. `MaxCost` computes max via `GteCost`, but a direct `MaxNat<A,B>` would complete the algebra.

---

## 8. Improvement Points: Implementations

### ~~I1 — `castCost` is a no-op wrapper~~ — **Resolved by P2 fix**

### I2 — `annotateCostFn` allocates an extra function per call
```ts
// Current: wraps fn in a new arrow function + castCost call on every invocation
return ((...args) => castCost(level, fn(...args))) as CostFn<L, Args, R>;
// Simpler (no extra allocation):
return fn as unknown as CostFn<L, Args, R>;
```
Since `castCost` is a no-op, the wrapper only adds call overhead.

### ~~I3 — `$binarySearch` should match its contract~~ — **Resolved by P1 fix**

### I4 — `$` runtime normalization could use a lookup map
```ts
const LABEL_MAP: Record<CostBigO, CostLabel> = {
  'O(1)': 'const', 'O(log n)': 'log', 'O(n)': 'linear',
  'O(n log n)': 'nlogn', 'O(n^2)': 'quad',
};
const level = LABEL_MAP[max as CostBigO] ?? (max as CostLabel);
```
More maintainable than the current if-chain.

---

## 9. Learning Paths

| Step | Concept | Location |
|---|---|---|
| 1 | `Nat` and saturating arithmetic | cost.ts lines 27–46 |
| 2 | `Cost = { p, l }` and `CostOfLabel` | cost.ts lines 51–87 |
| 3 | `LevelsUpTo<L>` + `Costed<L,T>` widening | cost.ts lines 107–130 |
| 4 | `$` boundary enforcement via `Leq` constraint | cost.ts lines 163–187 |
| 5 | `Ctx<C,T>` and `$cost/$pipe/$andThen/$zipCtx` | cost.ts lines 304–420 |
| 6 | `Seq` vs `Nest` cost propagation | cost.ts lines 98–99, `$forEachN` / `$mapN` |
| 7 | Full usage in practice | `src/store/core/line-index.ts`, `src/types/branded.test.ts` |

The most illuminating test cases for understanding the system are the `$forEachN` nesting tests in `branded.test.ts` — they demonstrate how `Nest<C_LIN, C_LOG>` infers `nlogn` and `Nest<C_LIN, C_LIN>` infers `quad`, which is the core value of the whole system.
