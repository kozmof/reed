/**
 * Branded algorithmic cost types and combinators.
 *
 * Usage policy:
 * 1. Use `constCost`/`logCost`/`linearCost`/`nlognCost`/`quadCost` for simple
 *    return-value casts when a function is already computed and just returns.
 * 2. Use `$(level, () => { ... })` to mark an explicit compute boundary when
 *    you want the costed region to be visible in code.
 * 3. Keep internal arithmetic/data as plain types where possible, and apply
 *    cost branding at boundaries (or via `CostFn` wrappers) rather than on
 *    intermediate mutable values.
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
export type AddNat<A extends Nat, B extends Nat> =
  A extends 0 ? B :
  A extends 1 ? (B extends 0 ? 1 : B extends 1 ? 2 : B extends 2 ? 3 : 3) :
  A extends 2 ? (B extends 0 ? 2 : B extends 1 ? 3 : 3) :
  3;

/**
 * Greater-than-or-equal over Nat.
 */
export type GteNat<A extends Nat, B extends Nat> =
  A extends B ? true :
  A extends 3 ? true :
  A extends 2 ? (B extends 3 ? false : true) :
  A extends 1 ? (B extends 0 ? true : false) :
  false;

/**
 * Asymptotic cost pair: O(n^p log^l n).
 */
export type Cost = { p: Nat; l: Nat };

/**
 * Cost labels used throughout public APIs.
 */
export type CostLabel = 'const' | 'log' | 'linear' | 'nlogn' | 'quad';
export type CostLevel = CostLabel;

/**
 * Label -> cost pair mapping.
 */
export type CostOfLabel<L extends CostLabel> =
  L extends 'const' ? { p: 0; l: 0 } :
  L extends 'log' ? { p: 0; l: 1 } :
  L extends 'linear' ? { p: 1; l: 0 } :
  L extends 'nlogn' ? { p: 1; l: 1 } :
  { p: 2; l: 0 };

/**
 * Named cost constants for combinator typing.
 */
export type C_CONST = CostOfLabel<'const'>;
export type C_LOG = CostOfLabel<'log'>;
export type C_LIN = CostOfLabel<'linear'>;
export type C_NLOGN = CostOfLabel<'nlogn'>;
export type C_QUAD = CostOfLabel<'quad'>;

/**
 * Cost comparison and composition primitives.
 */
export type GteCost<A extends Cost, B extends Cost> =
  GteNat<A['p'], B['p']> extends true
    ? (A['p'] extends B['p'] ? GteNat<A['l'], B['l']> : true)
    : false;

export type MaxCost<A extends Cost, B extends Cost> = GteCost<A, B> extends true ? A : B;
export type Seq<A extends Cost, B extends Cost> = MaxCost<A, B>;
export type Nest<A extends Cost, B extends Cost> = { p: AddNat<A['p'], B['p']>; l: AddNat<A['l'], B['l']> };
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
export type ConstCost<T> = Costed<'const', T>;
/** Value from an O(log n) operation. */
export type LogCost<T> = Costed<'log', T>;
/** Value from an O(n) operation. */
export type LinearCost<T> = Costed<'linear', T>;
/** Value from an O(n log n) operation. */
export type NLogNCost<T> = Costed<'nlogn', T>;
/** Value from an O(n^2) operation. */
export type QuadCost<T> = Costed<'quad', T>;

/**
 * Function contract with declarative cost level.
 */
export type CostFn<Level extends CostLevel, Args extends readonly unknown[], R> =
  (...args: Args) => Costed<Level, R>;

/**
 * Join two cost levels to the dominant one.
 */
export type JoinCostLevel<A extends CostLevel, B extends CostLevel> =
  GteCost<CostOfLabel<A>, CostOfLabel<B>> extends true ? A : B;

/**
 * Internal helper to cast a value to a declared cost level.
 * Keeps runtime behavior unchanged while centralizing type assertions.
 */
function castCost<L extends CostLevel, T>(level: L, value: T): Costed<L, T> {
  if (level === 'const') return value as Costed<L, T>;
  if (level === 'log') return value as Costed<L, T>;
  if (level === 'linear') return value as Costed<L, T>;
  if (level === 'nlogn') return value as Costed<L, T>;
  return value as Costed<L, T>;
}

/** Tag a value as O(1). Zero runtime cost — cast only. */
export function constCost<T>(value: T): ConstCost<T> {
  return castCost('const', value);
}

/** Tag a value as O(log n). Zero runtime cost — cast only. */
export function logCost<T>(value: T): LogCost<T> {
  return castCost('log', value);
}

/** Tag a value as O(n). Zero runtime cost — cast only. */
export function linearCost<T>(value: T): LinearCost<T> {
  return castCost('linear', value);
}

/** Tag a value as O(n log n). Zero runtime cost — cast only. */
export function nlognCost<T>(value: T): NLogNCost<T> {
  return castCost('nlogn', value);
}

/** Tag a value as O(n^2). Zero runtime cost — cast only. */
export function quadCost<T>(value: T): QuadCost<T> {
  return castCost('quad', value);
}

/**
 * Unified boundary helper.
 * - `$(level, () => value)` casts callback result at the declared level.
 * - `$(max, ctx)` checks compile-time upper bounds for context pipelines.
 */
export function $<L extends CostLevel, T>(level: L, compute: () => T): Costed<L, T>;
export function $<L extends CostLabel, C extends Cost, T>(
  max: L,
  ctx: { readonly _cost: C; readonly value: T } & (Leq<C, CostOfLabel<L>> extends true ? unknown : never)
): T;
export function $(
  level: CostLevel,
  boundary: { readonly _cost: Cost; readonly value: unknown } | (() => unknown)
): unknown {
  if (typeof boundary === 'function') {
    return castCost(level, boundary());
  }
  return boundary.value;
}

/**
 * Internal helper for declaring function cost contracts.
 */
function annotateCostFn<L extends CostLevel, Args extends readonly unknown[], R>(
  level: L,
  fn: (...args: Args) => R
): CostFn<L, Args, R> {
  return ((...args: Args) => castCost(level, fn(...args))) as CostFn<L, Args, R>;
}

/**
 * Annotate a function as O(1) without changing runtime behavior.
 */
export function constCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R
): CostFn<'const', Args, R> {
  return annotateCostFn('const', fn);
}

/**
 * Annotate a function as O(log n) without changing runtime behavior.
 */
export function logCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R
): CostFn<'log', Args, R> {
  return annotateCostFn('log', fn);
}

/**
 * Annotate a function as O(n) without changing runtime behavior.
 */
export function linearCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R
): CostFn<'linear', Args, R> {
  return annotateCostFn('linear', fn);
}

/**
 * Annotate a function as O(n log n) without changing runtime behavior.
 */
export function nlognCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R
): CostFn<'nlogn', Args, R> {
  return annotateCostFn('nlogn', fn);
}

/**
 * Annotate a function as O(n^2) without changing runtime behavior.
 */
export function quadCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R
): CostFn<'quad', Args, R> {
  return annotateCostFn('quad', fn);
}

/**
 * Compose cost-annotated functions and compute the dominant cost level.
 */
export function composeCostFn<
  L1 extends CostLevel,
  L2 extends CostLevel,
  Args extends readonly unknown[],
  Mid,
  Out
>(
  first: CostFn<L1, Args, Mid>,
  second: (value: Mid) => Costed<L2, Out>
): CostFn<JoinCostLevel<L1, L2>, Args, Out> {
  return ((...args: Args) =>
    second(first(...args)) as unknown as Costed<JoinCostLevel<L1, L2>, Out>
  ) as CostFn<JoinCostLevel<L1, L2>, Args, Out>;
}

/**
 * Extract the cost level from a branded value.
 */
type CostOf<T> = T extends CostBrand<infer L> ? L : never;

/**
 * Apply a pure (O(1)) transform to a cost-branded value.
 * The cost level is preserved — a pure function doesn't add algorithmic cost.
 */
export function mapCost<T extends CostBrand<CostLevel>, U>(
  value: T,
  f: (value: T) => U
): U & CostBrand<CostOf<T>> {
  return f(value) as U & CostBrand<CostOf<T>>;
}

/**
 * Compose two cost-branded operations.
 * The result cost is the union of both levels (= the more expensive tier).
 */
export function chainCost<T extends CostBrand<CostLevel>, U extends CostBrand<CostLevel>>(
  value: T,
  f: (value: T) => U
): U & CostBrand<CostOf<T> | CostOf<U>> {
  return f(value) as U & CostBrand<CostOf<T> | CostOf<U>>;
}

// =============================================================================
// Cost Context Pipeline Combinators
// =============================================================================

/**
 * Context value carrying only a compile-time cost.
 * `_cost` is phantom; no runtime overhead is introduced.
 */
export type Ctx<C extends Cost, T> = { readonly _cost: C; readonly value: T };

/**
 * Start a cost-typed pipeline with O(1) seed cost.
 */
export const start = <T>(value: T): Ctx<C_CONST, T> =>
  ({ value } as Ctx<C_CONST, T>);

export function pipe<A>(a: A): A;
export function pipe<A, B>(a: A, ab: (a: A) => B): B;
export function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C;
export function pipe<A, B, C, D>(a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D): D;
export function pipe<A, B, C, D, E>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E
): E;
export function pipe(a: unknown, ...fns: Array<(x: any) => any>): unknown {
  return fns.reduce((x, f) => f(x), a);
}

/**
 * O(1) map over the current context value.
 */
export const map =
  <T, U>(f: (t: T) => U) =>
  <C extends Cost>(c: Ctx<C, T>): Ctx<Seq<C, C_CONST>, U> =>
    ({ value: f(c.value) } as Ctx<Seq<C, C_CONST>, U>);

/**
 * O(log n) lookup combinator.
 * Runtime implementation is intentionally simple; typing models declared cost.
 */
export const binarySearch =
  (x: number) =>
  <C extends Cost>(c: Ctx<C, readonly number[]>): Ctx<Seq<C, C_LOG>, number> =>
    ({ value: c.value.indexOf(x) } as Ctx<Seq<C, C_LOG>, number>);

/**
 * O(n log n) sorting combinator.
 */
export const sort =
  <E>(compareFn?: (a: E, b: E) => number) =>
  <C extends Cost>(c: Ctx<C, readonly E[]>): Ctx<Seq<C, C_NLOGN>, E[]> => {
    const out = [...c.value];
    if (compareFn) out.sort(compareFn);
    else out.sort();
    return ({ value: out } as Ctx<Seq<C, C_NLOGN>, E[]>);
  };

/**
 * O(n) filter combinator.
 */
export const filter =
  <E>(pred: (e: E) => boolean) =>
  <C extends Cost>(c: Ctx<C, readonly E[]>): Ctx<Seq<C, C_LIN>, E[]> =>
    ({ value: c.value.filter(pred) } as Ctx<Seq<C, C_LIN>, E[]>);

/**
 * O(n) scan combinator returning first matching element.
 */
export const linearScan =
  <E>(pred: (e: E) => boolean) =>
  <C extends Cost>(c: Ctx<C, readonly E[]>): Ctx<Seq<C, C_LIN>, E | undefined> =>
    ({ value: c.value.find(pred) } as Ctx<Seq<C, C_LIN>, E | undefined>);

/**
 * O(n * body) nested combinator.
 * Body is evaluated once per element and contributes multiplicatively.
 */
export const forEachN =
  <E, BodyC extends Cost>(body: (e: E) => Ctx<BodyC, unknown>) =>
  <C extends Cost>(c: Ctx<C, readonly E[]>): Ctx<Seq<C, Nest<C_LIN, BodyC>>, E[]> => {
    c.value.forEach((e) => {
      body(e);
    });
    return ({ value: c.value } as Ctx<Seq<C, Nest<C_LIN, BodyC>>, E[]>);
  };
