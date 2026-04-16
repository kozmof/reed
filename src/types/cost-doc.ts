/**
 * Branded algorithmic cost types and combinators.
 *
 * Usage policy:
 * 1. Use `$prove(level, $checked(() => plan))` or `$proveCtx(level, planCtx)`
 *    for compile-time checked boundaries.
 * 2. Use `$declare(level, value)` for explicit unchecked declarations.
 * 3. Start plans from `$lift('O(1)', value)` and compose with pipeline combinators.
 * 4. Keep internal arithmetic/data as plain types and apply branding only
 *    at explicit boundaries (or via `CostFn` wrappers).
 * 5. Avoid direct cast helpers in store/application code.
 *
 * @remarks
 * **Cost labels are documentation annotations, not runtime contracts.**
 * The type-level algebra (`$prove`, `$proveCtx`, `$lift`) checks that label
 * relationships are internally consistent (e.g. O(n) is not declared inside
 * an O(1) boundary), but it does NOT measure actual execution cost, count
 * operations, or profile performance. Any contributor can annotate an O(n)
 * loop as O(1) and the type system will not object. Use a benchmark harness
 * to validate cost claims against real data.
 */

// =============================================================================
// Algorithmic Cost Algebra + Brands
// =============================================================================

/**
 * Phantom symbol for cost-level branding.
 * Never exists at runtime — zero overhead.
 */
declare const costLevel: unique symbol;

/**
 * Tiny bounded naturals used by the type-level cost algebra.
 * 3 acts as "3 or more" to keep types tractable.
 */
export type Nat = 0 | 1 | 2 | 3;

/**
 * Saturating addition over Nat.
 */
export type AddNat<A extends Nat, B extends Nat> = A extends 0
  ? B
  : A extends 1
    ? B extends 0
      ? 1
      : B extends 1
        ? 2
        : B extends 2
          ? 3
          : 3
    : A extends 2
      ? B extends 0
        ? 2
        : B extends 1
          ? 3
          : 3
      : 3;

/**
 * Greater-than-or-equal over Nat.
 */
export type GteNat<A extends Nat, B extends Nat> = A extends B
  ? true
  : A extends 3
    ? true
    : A extends 2
      ? B extends 3
        ? false
        : true
      : A extends 1
        ? B extends 0
          ? true
          : false
        : false;

/**
 * Asymptotic cost pair: O(n^p log^l n).
 */
export type Cost = { p: Nat; l: Nat };

/**
 * Cost labels used throughout public APIs.
 * - Canonical labels are used for type-level algebra.
 * - Big-O labels are accepted at `$` boundaries for readability.
 */
export type CostLabel = "const" | "log" | "linear" | "nlogn" | "quad";
export type CostLevel = CostLabel;
export type CostBigO = "O(1)" | "O(log n)" | "O(n)" | "O(n log n)" | "O(n^2)";
export type CostInputLabel = CostLabel | CostBigO;
const costLabelByInput = {
  const: "const",
  log: "log",
  linear: "linear",
  nlogn: "nlogn",
  quad: "quad",
  "O(1)": "const",
  "O(log n)": "log",
  "O(n)": "linear",
  "O(n log n)": "nlogn",
  "O(n^2)": "quad",
} as const satisfies Record<CostInputLabel, CostLabel>;
export type NormalizeCostLabel<L extends CostInputLabel> = (typeof costLabelByInput)[L];

/**
 * Label -> cost pair mapping.
 */
export type CostOfLabel<L extends CostLabel> = L extends "const"
  ? { p: 0; l: 0 }
  : L extends "log"
    ? { p: 0; l: 1 }
    : L extends "linear"
      ? { p: 1; l: 0 }
      : L extends "nlogn"
        ? { p: 1; l: 1 }
        : { p: 2; l: 0 };

/**
 * Named cost constants for combinator typing.
 */
export type C_CONST = CostOfLabel<"const">;
export type C_LOG = CostOfLabel<"log">;
export type C_LIN = CostOfLabel<"linear">;
export type C_NLOGN = CostOfLabel<"nlogn">;
export type C_QUAD = CostOfLabel<"quad">;

/**
 * Cost comparison and composition primitives.
 */
export type GteCost<A extends Cost, B extends Cost> =
  GteNat<A["p"], B["p"]> extends true
    ? A["p"] extends B["p"]
      ? GteNat<A["l"], B["l"]>
      : true
    : false;

export type MaxCost<A extends Cost, B extends Cost> = GteCost<A, B> extends true ? A : B;
export type Seq<A extends Cost, B extends Cost> = MaxCost<A, B>;
export type Nest<A extends Cost, B extends Cost> = {
  p: AddNat<A["p"], B["p"]>;
  l: AddNat<A["l"], B["l"]>;
};
export type Leq<A extends Cost, B extends Cost> = GteCost<B, A>;
export type Assert<T extends true> = T;

/**
 * All labels less-than-or-equal to L.
 * Enables natural widening: const -> log -> linear -> nlogn -> quad.
 */
type LevelsUpTo<L extends CostLabel> = {
  [K in CostLabel]: Leq<CostOfLabel<K>, CostOfLabel<L>> extends true ? K : never;
}[CostLabel];

/**
 * Cost brand with level labels for natural widening through unions.
 */
type CostBrand<Level extends CostLabel> = { readonly [costLevel]: Level };

/**
 * Branded value by declared cost level.
 */
export type Costed<Level extends CostLevel, T> = T & CostBrand<LevelsUpTo<Level>>;

/** Value from an O(1) operation. */
export type ConstCost<T> = Costed<"const", T>;
/** Value from an O(log n) operation. */
export type LogCost<T> = Costed<"log", T>;
/** Value from an O(n) operation. */
export type LinearCost<T> = Costed<"linear", T>;
/** Value from an O(n log n) operation. */
export type NLogNCost<T> = Costed<"nlogn", T>;
/** Value from an O(n^2) operation. */
export type QuadCost<T> = Costed<"quad", T>;

/**
 * Function contract with declarative cost level.
 */
export type CostFn<Level extends CostLevel, Args extends readonly unknown[], R> = (
  ...args: Args
) => Costed<Level, R>;

/**
 * Join two cost levels to the dominant one.
 */
export type JoinCostLevel<A extends CostLevel, B extends CostLevel> =
  GteCost<CostOfLabel<A>, CostOfLabel<B>> extends true ? A : B;

/**
 * Internal helper to cast a value to a declared cost level.
 * Keeps runtime behavior unchanged while centralizing type assertions.
 * The level parameter is intentionally unused at runtime — branding is compile-time only.
 */
function castCost<L extends CostLevel, T>(_level: L, value: T): Costed<L, T> {
  return value as Costed<L, T>;
}

/**
 * Normalize public labels to canonical cost levels.
 */
function toCostLevel(max: CostInputLabel): CostLevel {
  return costLabelByInput[max];
}

type CtxLike = { readonly _cost: Cost; readonly value: unknown };
type CheckedPlanLike = { readonly run: () => CtxLike };
type UncheckedBoundaryValue<T> = T extends CtxLike ? never : T extends CheckedPlanLike ? never : T;

/**
 * Explicit unchecked boundary declaration.
 * Use this when a proof plan is not modeled.
 * For checked boundaries, use `$prove` or `$proveCtx`.
 */
export function $declare<L extends CostInputLabel, T>(
  max: L,
  value: UncheckedBoundaryValue<T>,
): Costed<NormalizeCostLabel<L>, UncheckedBoundaryValue<T>>;
export function $declare(max: CostInputLabel, value: unknown): unknown {
  return castCost(toCostLevel(max), value);
}

/**
 * Compile-time checked boundary from a checked plan.
 *
 * @remarks
 * The `max` label is not enforced at runtime. This function verifies only that
 * the composed plan's type-level cost is ≤ `max` at compile time. Actual
 * runtime performance is unchecked — see module-level note.
 */
export function $prove<L extends CostInputLabel, C extends Cost, T>(
  max: L,
  plan: CheckedPlan<C, T> &
    (Leq<C, CostOfLabel<NormalizeCostLabel<L>>> extends true ? unknown : never),
): Costed<NormalizeCostLabel<L>, T>;
export function $prove(max: CostInputLabel, plan: CheckedPlan<Cost, unknown>): unknown {
  return castCost(toCostLevel(max), plan.run().value);
}

/**
 * Compile-time checked boundary from a precomputed context.
 *
 * @remarks
 * Like `$prove`, the label is not enforced at runtime — see module-level note.
 */
export function $proveCtx<L extends CostInputLabel, C extends Cost, T>(
  max: L,
  ctx: Ctx<C, T> & (Leq<C, CostOfLabel<NormalizeCostLabel<L>>> extends true ? unknown : never),
): Costed<NormalizeCostLabel<L>, T>;
export function $proveCtx(max: CostInputLabel, ctx: Ctx<Cost, unknown>): unknown {
  return castCost(toCostLevel(max), ctx.value);
}

/**
 * Internal helper for declaring function cost contracts.
 * The level parameter is unused at runtime — branding is compile-time only.
 */
function annotateCostFn<L extends CostLevel, Args extends readonly unknown[], R>(
  _level: L,
  fn: (...args: Args) => R,
): CostFn<L, Args, R> {
  return fn as unknown as CostFn<L, Args, R>;
}

/**
 * Annotate a function as O(1) without changing runtime behavior.
 */
export function $constCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R,
): CostFn<"const", Args, R> {
  return annotateCostFn("const", fn);
}

/**
 * Annotate a function as O(log n) without changing runtime behavior.
 */
export function $logCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R,
): CostFn<"log", Args, R> {
  return annotateCostFn("log", fn);
}

/**
 * Annotate a function as O(n) without changing runtime behavior.
 */
export function $linearCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R,
): CostFn<"linear", Args, R> {
  return annotateCostFn("linear", fn);
}

/**
 * Annotate a function as O(n log n) without changing runtime behavior.
 */
export function $nlognCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R,
): CostFn<"nlogn", Args, R> {
  return annotateCostFn("nlogn", fn);
}

/**
 * Annotate a function as O(n^2) without changing runtime behavior.
 */
export function $quadCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R,
): CostFn<"quad", Args, R> {
  return annotateCostFn("quad", fn);
}

// =============================================================================
// Cost Context Pipeline Combinators
// =============================================================================

/**
 * Context value carrying only a compile-time cost.
 *
 * @remarks
 * `_cost` is a **phantom field** — it exists in the TypeScript type but is never
 * initialized or read at runtime. All constructors (`$lift`, `$andThen`, `$map`,
 * etc.) create objects with only `{ value }` and cast to `Ctx<C, T>`. This is
 * intentional and safe as long as no code accesses `_cost` directly. The phantom
 * field enables the type-level cost algebra without any runtime overhead.
 */
export type Ctx<C extends Cost, T> = { readonly _cost: C; readonly value: T };

const checkedPlanTag = Symbol("checked-cost-plan");

/**
 * Wrapper for a compile-time checked boundary plan.
 * Use with `$prove(max, $checked(() => plan))`.
 */
export type CheckedPlan<C extends Cost, T> = {
  readonly [checkedPlanTag]: true;
  readonly run: () => Ctx<C, T>;
};

/**
 * Mark a cost plan to be validated by `$prove` against an upper bound.
 */
export function $checked<C extends Cost, T>(run: () => Ctx<C, T>): CheckedPlan<C, T> {
  return {
    [checkedPlanTag]: true,
    run,
  };
}

/**
 * Lift a branded value into a context so it can participate in `$pipe` plans.
 */
export const $from = <L extends CostLevel, T>(value: Costed<L, T>): Ctx<CostOfLabel<L>, T> =>
  ({ value: value as unknown as T }) as Ctx<CostOfLabel<L>, T>;

/**
 * Lift a plain value into a context at a declared upper bound.
 * Use `O(1)` when seeding a new plan.
 * Useful in checked plans where branch costs must align.
 *
 * @remarks
 * The `_level` parameter is unused at runtime — it is consumed only by the
 * type system. Passing `'O(1)'` does not verify or constrain runtime cost.
 * See module-level note.
 */
export function $lift<L extends CostInputLabel, T>(
  _level: L,
  value: T,
): Ctx<CostOfLabel<NormalizeCostLabel<L>>, T> {
  return { value } as Ctx<CostOfLabel<NormalizeCostLabel<L>>, T>;
}

export function $pipe<C extends Cost, T>(ctx: Ctx<C, T>): Ctx<C, T>;
export function $pipe<C1 extends Cost, A, C2 extends Cost, B>(
  ctx: Ctx<C1, A>,
  f1: (a: Ctx<C1, A>) => Ctx<C2, B>,
): Ctx<C2, B>;
export function $pipe<C1 extends Cost, A, C2 extends Cost, B, C3 extends Cost, CC>(
  ctx: Ctx<C1, A>,
  f1: (a: Ctx<C1, A>) => Ctx<C2, B>,
  f2: (b: Ctx<C2, B>) => Ctx<C3, CC>,
): Ctx<C3, CC>;
export function $pipe<
  C1 extends Cost,
  A,
  C2 extends Cost,
  B,
  C3 extends Cost,
  CC,
  C4 extends Cost,
  D,
>(
  ctx: Ctx<C1, A>,
  f1: (a: Ctx<C1, A>) => Ctx<C2, B>,
  f2: (b: Ctx<C2, B>) => Ctx<C3, CC>,
  f3: (c: Ctx<C3, CC>) => Ctx<C4, D>,
): Ctx<C4, D>;
export function $pipe<
  C1 extends Cost,
  A,
  C2 extends Cost,
  B,
  C3 extends Cost,
  CC,
  C4 extends Cost,
  D,
  C5 extends Cost,
  E,
>(
  ctx: Ctx<C1, A>,
  f1: (a: Ctx<C1, A>) => Ctx<C2, B>,
  f2: (b: Ctx<C2, B>) => Ctx<C3, CC>,
  f3: (c: Ctx<C3, CC>) => Ctx<C4, D>,
  f4: (d: Ctx<C4, D>) => Ctx<C5, E>,
): Ctx<C5, E>;
export function $pipe(a: unknown, ...fns: Array<(x: any) => any>): unknown {
  return fns.reduce((x, f) => f(x), a);
}

/**
 * Sequentially compose context-producing steps.
 * Useful when each step calls another function with its own declared cost.
 */
export const $andThen =
  <T, C2 extends Cost, U>(f: (t: T) => Ctx<C2, U>) =>
  <C1 extends Cost>(c: Ctx<C1, T>): Ctx<Seq<C1, C2>, U> =>
    ({ value: f(c.value).value }) as Ctx<Seq<C1, C2>, U>;

/**
 * O(1) map over the current context value.
 * Cost is preserved: a pure transform adds no algorithmic cost.
 */
export const $map =
  <T, U>(f: (t: T) => U) =>
  <C extends Cost>(c: Ctx<C, T>): Ctx<C, U> =>
    ({ value: f(c.value) }) as Ctx<C, U>;

/**
 * O(log n) binary search combinator.
 * Requires the input array to be sorted in ascending order.
 * Returns the index of x, or -1 if not found.
 */
export const $binarySearch =
  (x: number) =>
  <C extends Cost>(c: Ctx<C, readonly number[]>): Ctx<Seq<C, C_LOG>, number> => {
    let lo = 0;
    let hi = c.value.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = c.value[mid];
      if (v === x) return { value: mid } as Ctx<Seq<C, C_LOG>, number>;
      if (v < x) lo = mid + 1;
      else hi = mid - 1;
    }
    return { value: -1 } as Ctx<Seq<C, C_LOG>, number>;
  };

/**
 * O(n log n) sorting combinator.
 */
export const $sort =
  <E>(compareFn?: (a: E, b: E) => number) =>
  <C extends Cost>(c: Ctx<C, readonly E[]>): Ctx<Seq<C, C_NLOGN>, E[]> => {
    const out = [...c.value];
    if (compareFn) out.sort(compareFn);
    else out.sort();
    return { value: out } as Ctx<Seq<C, C_NLOGN>, E[]>;
  };

/**
 * O(n) filter combinator.
 */
export const $filter =
  <E>(pred: (e: E) => boolean) =>
  <C extends Cost>(c: Ctx<C, readonly E[]>): Ctx<Seq<C, C_LIN>, E[]> =>
    ({ value: c.value.filter(pred) }) as Ctx<Seq<C, C_LIN>, E[]>;

/**
 * O(n) scan combinator returning first matching element.
 */
export const $linearScan =
  <E>(pred: (e: E) => boolean) =>
  <C extends Cost>(c: Ctx<C, readonly E[]>): Ctx<Seq<C, C_LIN>, E | undefined> =>
    ({ value: c.value.find(pred) }) as Ctx<Seq<C, C_LIN>, E | undefined>;

/**
 * Combine two context values into one.
 * The result cost is the dominant cost of both inputs.
 * Use with `$from` to zip branded values: `$zipCtx($from(a), $from(b), f)`.
 */
export const $zipCtx = <C1 extends Cost, A, C2 extends Cost, B, U>(
  left: Ctx<C1, A>,
  right: Ctx<C2, B>,
  f: (a: A, b: B) => U,
): Ctx<Seq<C1, C2>, U> => ({ value: f(left.value, right.value) }) as Ctx<Seq<C1, C2>, U>;

/**
 * O(n * body) nested combinator for side effects.
 * Body is evaluated once per element and contributes multiplicatively.
 * The original array is returned unchanged — use `$mapN` to collect results.
 */
export const $forEachN =
  <E, BodyC extends Cost>(body: (e: E) => Ctx<BodyC, unknown>) =>
  <C extends Cost>(c: Ctx<C, readonly E[]>): Ctx<Seq<C, Nest<C_LIN, BodyC>>, E[]> => {
    c.value.forEach((e) => {
      body(e);
    });
    return { value: c.value } as Ctx<Seq<C, Nest<C_LIN, BodyC>>, E[]>;
  };

/**
 * O(n * body) nested map combinator.
 * Like `$forEachN` but collects each body result into a new array.
 */
export const $mapN =
  <E, U, BodyC extends Cost>(body: (e: E) => Ctx<BodyC, U>) =>
  <C extends Cost>(c: Ctx<C, readonly E[]>): Ctx<Seq<C, Nest<C_LIN, BodyC>>, U[]> => {
    const result = c.value.map((e) => body(e).value);
    return { value: result } as Ctx<Seq<C, Nest<C_LIN, BodyC>>, U[]>;
  };
