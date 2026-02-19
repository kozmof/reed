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
// Algorithmic Cost Brands
// =============================================================================

/**
 * Phantom symbol for cost-level branding.
 * Never exists at runtime — zero overhead.
 */
declare const costLevel: unique symbol;

/**
 * Declarative cost levels for algorithmic complexity.
 */
export type CostLevel = 'const' | 'log' | 'linear';

/**
 * Cost brand with level labels for natural widening through unions.
 *
 * Widening is automatic via TypeScript's union assignability:
 * - `CostBrand<'const'>` is assignable to `CostBrand<'const' | 'log'>`
 * - `CostBrand<'const' | 'log'>` is assignable to `CostBrand<'const' | 'log' | 'linear'>`
 *
 * This means a value from an O(1) function can be used wherever an O(log n)
 * or O(n) result is expected.
 */
type CostBrand<Level extends CostLevel> = { readonly [costLevel]: Level };

/** Value from an O(1) operation. Assignable to LogCost and LinearCost. */
export type ConstCost<T> = T & CostBrand<'const'>;

/** Value from an O(log n) operation. Assignable to LinearCost. */
export type LogCost<T> = T & CostBrand<'const' | 'log'>;

/** Value from an O(n) operation. */
export type LinearCost<T> = T & CostBrand<'const' | 'log' | 'linear'>;

/**
 * Map a cost level to its branded value shape.
 */
export type Costed<Level extends CostLevel, T> =
  Level extends 'const' ? ConstCost<T> :
  Level extends 'log' ? LogCost<T> :
  LinearCost<T>;

/**
 * Function contract with declarative cost level.
 */
export type CostFn<Level extends CostLevel, Args extends readonly unknown[], R> =
  (...args: Args) => Costed<Level, R>;

/**
 * Join two cost levels to the dominant one.
 */
export type JoinCostLevel<A extends CostLevel, B extends CostLevel> =
  A extends 'linear' ? 'linear' :
  B extends 'linear' ? 'linear' :
  A extends 'log' ? 'log' :
  B extends 'log' ? 'log' :
  'const';

/** Tag a value as O(1). Zero runtime cost — cast only. */
export function constCost<T>(value: T): ConstCost<T> {
  return value as ConstCost<T>;
}

/**
 * Mark a computation boundary as O(1).
 * Useful when the computation is guaranteed constant-time.
 */
export function constCostBoundary<T>(compute: () => T): ConstCost<T> {
  return constCost(compute());
}

/** Tag a value as O(log n). Zero runtime cost — cast only. */
export function logCost<T>(value: T): LogCost<T> {
  return value as LogCost<T>;
}

/**
 * Mark a computation boundary as O(log n).
 * Useful when internal work is intentionally hidden behind one complexity tier.
 */
export function logCostBoundary<T>(compute: () => T): LogCost<T> {
  return logCost(compute());
}

/** Tag a value as O(n). Zero runtime cost — cast only. */
export function linearCost<T>(value: T): LinearCost<T> {
  return value as LinearCost<T>;
}

/**
 * Mark a computation boundary as O(n).
 * Useful when internal work is intentionally grouped behind linear complexity.
 */
export function linearCostBoundary<T>(compute: () => T): LinearCost<T> {
  return linearCost(compute());
}

/**
 * Compact boundary helper for readability:
 * $('const' | 'log' | 'linear', () => value)
 */
export function $<T>(level: 'const', compute: () => T): ConstCost<T>;
export function $<T>(level: 'log', compute: () => T): LogCost<T>;
export function $<T>(level: 'linear', compute: () => T): LinearCost<T>;
export function $<T>(level: CostLevel, compute: () => T): Costed<CostLevel, T> {
  if (level === 'const') return constCostBoundary(compute);
  if (level === 'log') return logCostBoundary(compute);
  return linearCostBoundary(compute);
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
 *
 * Example: LogCost + LogCost = LogCost, LogCost + LinearCost = LinearCost.
 */
export function chainCost<T extends CostBrand<CostLevel>, U extends CostBrand<CostLevel>>(
  value: T,
  f: (value: T) => U
): U & CostBrand<CostOf<T> | CostOf<U>> {
  return f(value) as U & CostBrand<CostOf<T> | CostOf<U>>;
}
