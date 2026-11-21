import { describe, expect, it } from "vitest";
import { lowerBound, partitionPoint } from "./binary-search.js";

describe("partitionPoint", () => {
  it("returns the first index where the predicate fails", () => {
    expect(partitionPoint(10, (i) => i < 4)).toBe(4);
  });

  it("returns 0 when the predicate fails everywhere, and count when it holds everywhere", () => {
    expect(partitionPoint(5, () => false)).toBe(0);
    expect(partitionPoint(5, () => true)).toBe(5);
    expect(partitionPoint(0, () => true)).toBe(0);
  });
});

describe("lowerBound", () => {
  const values = [1, 3, 3, 5, 9];

  it("finds the first value at least the bound", () => {
    expect(lowerBound(values, 3)).toBe(1);
    expect(lowerBound(values, 4)).toBe(3);
    expect(lowerBound(values, 9)).toBe(4);
  });

  it("returns 0 below every value and the length above every value", () => {
    expect(lowerBound(values, 0)).toBe(0);
    expect(lowerBound(values, 10)).toBe(5);
    expect(lowerBound([], 1)).toBe(0);
  });

  it("matches a linear scan", () => {
    const sorted = [0, 0, 2, 4, 4, 4, 7, 8, 8, 11];
    for (let min = -1; min <= 12; min++) {
      const expected = sorted.findIndex((value) => value >= min);
      expect(lowerBound(sorted, min)).toBe(expected === -1 ? sorted.length : expected);
    }
  });
});
