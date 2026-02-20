/**
 * Tests for branded position types.
 */

import { describe, it, expect } from 'vitest';
import {
  $,
  byteOffset,
  charOffset,
  lineNumber,
  columnNumber,
  isValidOffset,
  isValidLineNumber,
  addByteOffset,
  diffByteOffset,
  addCharOffset,
  nextLine,
  prevLine,
  clampByteOffset,
  clampCharOffset,
  ZERO_BYTE_OFFSET,
  ZERO_CHAR_OFFSET,
  LINE_ZERO,
  COLUMN_ZERO,
  constCostFn,
  constCost,
  logCostFn,
  logCost,
  linearCostFn,
  linearCost,
  nlognCostFn,
  nlognCost,
  quadCostFn,
  quadCost,
  composeCostFn,
  checked,
  start,
  pipe,
  map,
  binarySearch,
  linearScan,
  forEachN,
  type ConstCost,
  type CostFn,
  type LogCost,
  type LinearCost,
  type NLogNCost,
  type QuadCost,
  type ByteOffset,
  type CharOffset,
  type LineNumber,
} from './branded.ts';

describe('Branded Types', () => {
  describe('constructor functions', () => {
    it('should create ByteOffset from number', () => {
      const offset = byteOffset(42);
      expect(offset).toBe(42);
    });

    it('should create CharOffset from number', () => {
      const offset = charOffset(10);
      expect(offset).toBe(10);
    });

    it('should create LineNumber from number', () => {
      const line = lineNumber(5);
      expect(line).toBe(5);
    });

    it('should create ColumnNumber from number', () => {
      const col = columnNumber(20);
      expect(col).toBe(20);
    });
  });

  describe('validation functions', () => {
    it('should validate valid offsets', () => {
      expect(isValidOffset(0)).toBe(true);
      expect(isValidOffset(100)).toBe(true);
      expect(isValidOffset(1000000)).toBe(true);
    });

    it('should reject invalid offsets', () => {
      expect(isValidOffset(-1)).toBe(false);
      expect(isValidOffset(-100)).toBe(false);
      expect(isValidOffset(1.5)).toBe(false);
      expect(isValidOffset(NaN)).toBe(false);
      expect(isValidOffset(Infinity)).toBe(false);
    });

    it('should validate valid line numbers', () => {
      expect(isValidLineNumber(0)).toBe(true);
      expect(isValidLineNumber(1)).toBe(true);
      expect(isValidLineNumber(1000)).toBe(true);
    });

    it('should reject invalid line numbers', () => {
      expect(isValidLineNumber(-1)).toBe(false);
      expect(isValidLineNumber(0.5)).toBe(false);
    });
  });

  describe('arithmetic helpers', () => {
    it('should add to ByteOffset', () => {
      const offset = byteOffset(10);
      const result = addByteOffset(offset, 5);
      expect(result).toBe(15);
    });

    it('should compute ByteOffset difference', () => {
      const a = byteOffset(20);
      const b = byteOffset(15);
      expect(diffByteOffset(a, b)).toBe(5);
    });

    it('should add to CharOffset', () => {
      const offset = charOffset(10);
      const result = addCharOffset(offset, 3);
      expect(result).toBe(13);
    });

    it('should increment line number', () => {
      const line = lineNumber(5);
      expect(nextLine(line)).toBe(6);
    });

    it('should decrement line number', () => {
      const line = lineNumber(5);
      expect(prevLine(line)).toBe(4);
    });

    it('should not go below zero for line number', () => {
      const line = lineNumber(0);
      expect(prevLine(line)).toBe(0);
    });
  });

  describe('clamping', () => {
    it('should clamp ByteOffset to range', () => {
      const min = byteOffset(5);
      const max = byteOffset(15);

      expect(clampByteOffset(byteOffset(0), min, max)).toBe(5);
      expect(clampByteOffset(byteOffset(10), min, max)).toBe(10);
      expect(clampByteOffset(byteOffset(20), min, max)).toBe(15);
    });

    it('should clamp CharOffset to range', () => {
      const min = charOffset(0);
      const max = charOffset(100);

      expect(clampCharOffset(charOffset(-5), min, max)).toBe(0);
      expect(clampCharOffset(charOffset(50), min, max)).toBe(50);
      expect(clampCharOffset(charOffset(200), min, max)).toBe(100);
    });
  });

  describe('zero constants', () => {
    it('should provide zero constants', () => {
      expect(ZERO_BYTE_OFFSET).toBe(0);
      expect(ZERO_CHAR_OFFSET).toBe(0);
      expect(LINE_ZERO).toBe(0);
      expect(COLUMN_ZERO).toBe(0);
    });
  });

  describe('type safety', () => {
    // These tests verify that the branded types work at runtime
    // The actual type safety is enforced at compile time by TypeScript
    it('should allow using branded types as numbers', () => {
      const byte: ByteOffset = byteOffset(10);
      const char: CharOffset = charOffset(5);
      const line: LineNumber = lineNumber(3);

      // Branded types can be used in arithmetic
      expect(byte + char).toBe(15);
      expect(line * 2).toBe(6);
    });

    it('should support comparison operations', () => {
      const a = byteOffset(10);
      const b = byteOffset(20);

      expect(a < b).toBe(true);
      expect(a === byteOffset(10)).toBe(true);
      expect(b > a).toBe(true);
    });
  });

  describe('cost boundaries', () => {
    it('should wrap callback result as ConstCost', () => {
      const result: ConstCost<number> = $('const', () => constCost(7));
      expect(result).toBe(7);
    });

    it('should wrap callback result as LogCost', () => {
      const result: LogCost<number> = $('log', () => logCost(42));
      expect(result).toBe(42);
    });

    it('should wrap callback result as LinearCost', () => {
      const result: LinearCost<number> = $('linear', () => linearCost(100));
      expect(result).toBe(100);
    });

    it('should wrap callback result as NLogNCost', () => {
      const result: NLogNCost<number> = $('nlogn', () => nlognCost(8));
      expect(result).toBe(8);
    });

    it('should wrap callback result as QuadCost', () => {
      const result: QuadCost<number> = $('quad', () => quadCost(9));
      expect(result).toBe(9);
    });

    it('should execute callback exactly once', () => {
      let calls = 0;
      const result = $('log', () => {
        calls += 1;
        return logCost('value');
      });
      expect(result).toBe('value');
      expect(calls).toBe(1);
    });

    it('should support compact $ boundary helper', () => {
      const c: ConstCost<number> = $('const', () => constCost(1));
      const l: LogCost<number> = $('log', () => logCost(2));
      const n: LinearCost<number> = $('linear', () => linearCost(3));
      expect(c + l + n).toBe(6);
    });
  });

  describe('cost function contracts', () => {
    it('should annotate function output with log cost', () => {
      const fn: CostFn<'log', [number], number> = logCostFn((value: number) => value + 1);
      const result = fn(41);
      expect(result).toBe(42);
    });

    it('should compose functions and preserve dominant cost', () => {
      const first: CostFn<'const', [number], number> = constCostFn((value: number) => value + 1);
      const second = (value: number) => $('linear', () => linearCost(value * 2));

      const composed: CostFn<'linear', [number], number> = composeCostFn(first, second);
      expect(composed(5)).toBe(12);
    });

    it('should support direct linear function annotation', () => {
      const fn: CostFn<'linear', [number], string> = linearCostFn((value: number) => String(value));
      expect(fn(7)).toBe('7');
    });

    it('should support nlogn and quad function annotation', () => {
      const nlogn: CostFn<'nlogn', [readonly number[]], number[]> =
        nlognCostFn((values: readonly number[]) => [...values].sort((a, b) => a - b));
      const quad: CostFn<'quad', [number], number> =
        quadCostFn((value: number) => value * value);

      expect(nlogn([3, 1, 2])).toEqual([1, 2, 3]);
      expect(quad(4)).toBe(16);
    });
  });

  describe('cost context pipeline', () => {
    it('should validate checked plan boundaries', () => {
      const checkedLogPlan = checked(() => pipe(
        start([1, 2, 3]),
        binarySearch(2),
      ));

      expect($('log', checkedLogPlan)).toBe(1);
      // @ts-expect-error log is not <= const
      $('const', checkedLogPlan);
    });

    it('should model sequential composition as dominant cost', () => {
      const seqLog = pipe(
        start([1, 2, 3]),
        binarySearch(2),
        map((index: number) => index + 10),
      );

      expect($('log', seqLog)).toBe(11);
      // @ts-expect-error log is not <= const
      $('const', seqLog);
    });

    it('should infer nlogn for linear nesting with log body', () => {
      const nestedNlogn = pipe(
        start([1, 2, 3, 4]),
        forEachN((x: number) =>
          pipe(
            start([1, 2, 3, 4, 5]),
            binarySearch(x),
          )
        ),
        map((xs: readonly number[]) => xs.length),
      );

      expect($('nlogn', nestedNlogn)).toBe(4);
      // @ts-expect-error nlogn is not <= linear
      $('linear', nestedNlogn);
    });

    it('should infer quad for linear nesting with linear body', () => {
      const nestedQuad = pipe(
        start([1, 2, 3, 4]),
        forEachN((x: number) =>
          pipe(
            start([1, 2, 3, 4, 5]),
            linearScan((y: number) => y === x),
          )
        ),
      );

      expect($('quad', nestedQuad)).toEqual([1, 2, 3, 4]);
      // @ts-expect-error quad is not <= nlogn
      $('nlogn', nestedQuad);
    });
  });
});
