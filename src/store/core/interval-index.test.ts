import { expect, it } from "vitest";
import { IntervalIndex } from "./interval-index.js";

it("matches strict overlap and half-open containment for nested and empty intervals", () => {
  const intervals = Array.from({ length: 300 }, (_, i) => ({
    start: (i * 37) % 100,
    end: ((i * 37) % 100) + (i % 31),
    value: i,
  }));
  const index = new IntervalIndex(intervals);
  for (let start = -1; start < 133; start++) {
    expect(index.query(start, start, true).sort((a, b) => a - b)).toEqual(
      intervals.filter((r) => r.start <= start && r.end > start).map((r) => r.value),
    );
    for (const end of [start - 4, start, start + 1, start + 17, Infinity]) {
      expect(index.query(start, end).sort((a, b) => a - b)).toEqual(
        intervals.filter((r) => r.start < end && r.end > start).map((r) => r.value),
      );
    }
  }
  expect(index.query(NaN, 2)).toEqual([]);
  expect(new IntervalIndex([]).query(0, 1)).toEqual([]);
});

it("reads only boundary paths and matches for a sparse query", () => {
  let reads = 0;
  const intervals = Array.from({ length: 32768 }, (_, i) => ({
    get start() {
      reads++;
      return i * 4;
    },
    get end() {
      reads++;
      return i * 4 + 2;
    },
    value: i,
  }));
  const index = new IntervalIndex(intervals);
  reads = 0;
  expect(index.query(64000, 64001)).toEqual([16000]);
  expect(reads).toBeLessThan(100);
});
