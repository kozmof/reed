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
// Cost Typing Re-exports
// =============================================================================

export type {
  Nat,
  Cost,
  CostLabel,
  CostBigO,
  CostInputLabel,
  CostLevel,
  NormalizeCostLabel,
  CostOfLabel,
  Ctx,
  Seq,
  Nest,
  Leq,
  Assert,
  Costed,
  CostFn,
  JoinCostLevel,
  CheckedPlan,
  ConstCost,
  LogCost,
  LinearCost,
  NLogNCost,
  QuadCost,
} from './cost.ts';

export {
  $,
  $checked,
  $constCostFn,
  $logCostFn,
  $linearCostFn,
  $nlognCostFn,
  $quadCostFn,
  $composeCostFn,
  $mapCost,
  $chainCost,
  $zipCost,
  $cost,
  $fromCosted,
  $pipe,
  $andThen,
  $map,
  $binarySearch,
  $sort,
  $filter,
  $linearScan,
  $forEachN,
} from './cost.ts';
