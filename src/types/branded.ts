/**
 * Branded types for type-safe position handling.
 *
 * Branded types (also called "opaque types" or "nominal types") prevent
 * accidentally mixing up different kinds of numeric values. For example,
 * byte offsets should not be confused with character offsets when dealing
 * with multi-byte UTF-8 characters.
 *
 * Usage:
 * ```typescript
 * const bytePos = 10 as ByteOffset;
 * const charPos = 5 as CharOffset;
 *
 * // Type error: can't assign ByteOffset to CharOffset
 * const wrongPos: CharOffset = bytePos;
 *
 * // OK: explicit conversion
 * const converted: CharOffset = charPos;
 * ```
 */

// =============================================================================
// Brand Symbol
// =============================================================================

/**
 * Unique symbol used for branding types.
 * This symbol is never used at runtime - it only exists for the type system.
 */
declare const brand: unique symbol;

/**
 * Generic brand interface.
 * The brand is a phantom type that only exists in the type system.
 */
interface Brand<B> {
  readonly [brand]: B;
}

/**
 * Create a branded type from a base type.
 * The brand only exists at compile time - no runtime overhead.
 */
type Branded<T, B> = T & Brand<B>;

// =============================================================================
// Position Types
// =============================================================================

/**
 * Byte offset in a buffer or document.
 * Represents a position in terms of UTF-8 bytes.
 *
 * Use when:
 * - Indexing into Uint8Array buffers
 * - Working with piece table start/length values
 * - Calculating buffer positions
 */
export type ByteOffset = Branded<number, 'ByteOffset'>;

/**
 * Character offset in a string.
 * Represents a position in terms of UTF-16 code units (JavaScript's string indexing).
 *
 * Use when:
 * - Working with JavaScript string methods
 * - User-facing cursor positions
 * - Selection ranges in the editor UI
 */
export type CharOffset = Branded<number, 'CharOffset'>;

/**
 * Byte length (size/count of bytes).
 * Represents a length in terms of UTF-8 bytes.
 *
 * Semantically distinct from ByteOffset: an offset is a position,
 * a length is a size/count.
 */
export type ByteLength = Branded<number, 'ByteLength'>;

/**
 * Line number (0-indexed).
 * Represents a line in the document.
 */
export type LineNumber = Branded<number, 'LineNumber'>;

/**
 * Column number (0-indexed).
 * Represents a character position within a line.
 */
export type ColumnNumber = Branded<number, 'ColumnNumber'>;

// =============================================================================
// Constructor Functions
// =============================================================================

/**
 * Create a ByteOffset from a number.
 * Use this for explicit conversions from raw numbers.
 */
export function byteOffset(value: number): ByteOffset {
  return value as ByteOffset;
}

/**
 * Create a CharOffset from a number.
 * Use this for explicit conversions from raw numbers.
 */
export function charOffset(value: number): CharOffset {
  return value as CharOffset;
}

/**
 * Create a ByteLength from a number.
 * Use this for explicit conversions from raw numbers.
 */
export function byteLength(value: number): ByteLength {
  return value as ByteLength;
}

/**
 * Create a LineNumber from a number.
 * Use this for explicit conversions from raw numbers.
 */
export function lineNumber(value: number): LineNumber {
  return value as LineNumber;
}

/**
 * Create a ColumnNumber from a number.
 * Use this for explicit conversions from raw numbers.
 */
export function columnNumber(value: number): ColumnNumber {
  return value as ColumnNumber;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a value is a valid offset (non-negative integer).
 */
export function isValidOffset(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Check if a value is a valid line number (non-negative integer).
 */
export function isValidLineNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

// =============================================================================
// Arithmetic Helpers
// =============================================================================

/**
 * Add a delta to a ByteOffset.
 * Preserves the brand type.
 */
export function addByteOffset(offset: ByteOffset, delta: number): ByteOffset {
  return (offset + delta) as ByteOffset;
}

/**
 * Subtract two ByteOffsets to get a numeric difference.
 */
export function diffByteOffset(a: ByteOffset, b: ByteOffset): number {
  return a - b;
}

/**
 * Add a delta to a CharOffset.
 * Preserves the brand type.
 */
export function addCharOffset(offset: CharOffset, delta: number): CharOffset {
  return (offset + delta) as CharOffset;
}

/**
 * Subtract two CharOffsets to get a numeric difference.
 */
export function diffCharOffset(a: CharOffset, b: CharOffset): number {
  return a - b;
}

/**
 * Increment a LineNumber.
 * Preserves the brand type.
 */
export function nextLine(line: LineNumber): LineNumber {
  return (line + 1) as LineNumber;
}

/**
 * Decrement a LineNumber.
 * Preserves the brand type.
 */
export function prevLine(line: LineNumber): LineNumber {
  return Math.max(0, line - 1) as LineNumber;
}

// =============================================================================
// Comparison Helpers
// =============================================================================

/**
 * Compare two ByteOffsets.
 * Returns negative if a < b, zero if equal, positive if a > b.
 */
export function compareByteOffsets(a: ByteOffset, b: ByteOffset): number {
  return a - b;
}

/**
 * Compare two CharOffsets.
 * Returns negative if a < b, zero if equal, positive if a > b.
 */
export function compareCharOffsets(a: CharOffset, b: CharOffset): number {
  return a - b;
}

/**
 * Clamp a ByteOffset to a valid range.
 */
export function clampByteOffset(
  offset: ByteOffset,
  min: ByteOffset,
  max: ByteOffset
): ByteOffset {
  return Math.max(min, Math.min(max, offset)) as ByteOffset;
}

/**
 * Clamp a CharOffset to a valid range.
 */
export function clampCharOffset(
  offset: CharOffset,
  min: CharOffset,
  max: CharOffset
): CharOffset {
  return Math.max(min, Math.min(max, offset)) as CharOffset;
}

// =============================================================================
// Zero Constants
// =============================================================================

/**
 * Zero byte offset - useful as a starting point.
 */
export const ZERO_BYTE_OFFSET: ByteOffset = 0 as ByteOffset;

/**
 * Zero char offset - useful as a starting point.
 */
export const ZERO_CHAR_OFFSET: CharOffset = 0 as CharOffset;

/**
 * Zero byte length.
 */
export const ZERO_BYTE_LENGTH: ByteLength = 0 as ByteLength;

/**
 * Line zero - the first line.
 */
export const LINE_ZERO: LineNumber = 0 as LineNumber;

/**
 * Column zero - the first column.
 */
export const COLUMN_ZERO: ColumnNumber = 0 as ColumnNumber;

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

/** Tag a value as O(1). Zero runtime cost — cast only. */
export function constCost<T>(value: T): ConstCost<T> {
  return value as ConstCost<T>;
}

/** Tag a value as O(log n). Zero runtime cost — cast only. */
export function logCost<T>(value: T): LogCost<T> {
  return value as LogCost<T>;
}

/** Tag a value as O(n). Zero runtime cost — cast only. */
export function linearCost<T>(value: T): LinearCost<T> {
  return value as LinearCost<T>;
}

/** Tag a value as O(n log n). Zero runtime cost — cast only. */
export function nlognCost<T>(value: T): NLogNCost<T> {
  return value as NLogNCost<T>;
}

/** Tag a value as O(n^2). Zero runtime cost — cast only. */
export function quadCost<T>(value: T): QuadCost<T> {
  return value as QuadCost<T>;
}

/**
 * Compact boundary helper for readability:
 * $('const' | 'log' | 'linear' | 'nlogn' | 'quad', () => value)
 */
export function $<T>(level: 'const', compute: () => T): ConstCost<T>;
export function $<T>(level: 'log', compute: () => T): LogCost<T>;
export function $<T>(level: 'linear', compute: () => T): LinearCost<T>;
export function $<T>(level: 'nlogn', compute: () => T): NLogNCost<T>;
export function $<T>(level: 'quad', compute: () => T): QuadCost<T>;
export function $<T>(
  level: CostLevel,
  compute: () => T
): ConstCost<T> | LogCost<T> | LinearCost<T> | NLogNCost<T> | QuadCost<T> {
  return costBoundary(level, compute);
}

/**
 * Annotate a function as O(1) without changing runtime behavior.
 */
export function constCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R
): CostFn<'const', Args, R> {
  return ((...args: Args) => constCost(fn(...args))) as CostFn<'const', Args, R>;
}

/**
 * Annotate a function as O(log n) without changing runtime behavior.
 */
export function logCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R
): CostFn<'log', Args, R> {
  return ((...args: Args) => logCost(fn(...args))) as CostFn<'log', Args, R>;
}

/**
 * Annotate a function as O(n) without changing runtime behavior.
 */
export function linearCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R
): CostFn<'linear', Args, R> {
  return ((...args: Args) => linearCost(fn(...args))) as CostFn<'linear', Args, R>;
}

/**
 * Annotate a function as O(n log n) without changing runtime behavior.
 */
export function nlognCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R
): CostFn<'nlogn', Args, R> {
  return ((...args: Args) => nlognCost(fn(...args))) as CostFn<'nlogn', Args, R>;
}

/**
 * Annotate a function as O(n^2) without changing runtime behavior.
 */
export function quadCostFn<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R
): CostFn<'quad', Args, R> {
  return ((...args: Args) => quadCost(fn(...args))) as CostFn<'quad', Args, R>;
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

/**
 * Unified boundary helper.
 * - `costBoundary(level, () => value)` casts callback result at the declared level.
 * - `costBoundary(max, ctx)` checks compile-time upper bounds for context pipelines.
 */
export function costBoundary<T>(level: 'const', compute: () => T): ConstCost<T>;
export function costBoundary<T>(level: 'log', compute: () => T): LogCost<T>;
export function costBoundary<T>(level: 'linear', compute: () => T): LinearCost<T>;
export function costBoundary<T>(level: 'nlogn', compute: () => T): NLogNCost<T>;
export function costBoundary<T>(level: 'quad', compute: () => T): QuadCost<T>;
export function costBoundary<T>(
  level: CostLevel,
  compute: () => T
): ConstCost<T> | LogCost<T> | LinearCost<T> | NLogNCost<T> | QuadCost<T>;
export function costBoundary<L extends CostLabel, C extends Cost, T>(
  _max: L,
  ctx: Ctx<C, T> & (Leq<C, CostOfLabel<L>> extends true ? unknown : never)
): T;
export function costBoundary(
  level: CostLevel,
  boundary: Ctx<Cost, unknown> | (() => unknown)
): unknown {
  if (typeof boundary === 'function') {
    const value = boundary();
    if (level === 'const') return constCost(value);
    if (level === 'log') return logCost(value);
    if (level === 'linear') return linearCost(value);
    if (level === 'nlogn') return nlognCost(value);
    return quadCost(value);
  }
  return boundary.value;
}
