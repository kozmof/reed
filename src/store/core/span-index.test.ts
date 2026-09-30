import { describe, expect, it } from "vitest";
import { SpanIndex } from "./span-index.js";

describe("copied-span containment", () => {
  it("bounds lookup work for thousands of disjoint spans in one former bucket", () => {
    const index = new SpanIndex<{ sourceStart: number; length: number }>();
    let comparisons = 0;
    for (let i = 0; i < 10_000; i++)
      index.add({
        get sourceStart() {
          comparisons++;
          return i * 3;
        },
        length: 1,
      });
    comparisons = 0;
    for (let i = 0; i < 10_000; i++) {
      expect(index.containing(i * 3, 1)?.sourceStart).toBe(i * 3);
      expect(index.containing(i * 3 + 1, 1)).toBeUndefined();
    }
    expect(comparisons).toBeLessThan(2_000_000); // logarithmic paths, not 100M bucket comparisons
  });
  it("finds containing reservations among overlaps and duplicate starts", () => {
    const spans = [
      { sourceStart: 100, length: 100 },
      { sourceStart: 0, length: 400 },
      { sourceStart: 300, length: 50 },
      { sourceStart: 100, length: 400 },
      { sourceStart: 200, length: 2 },
      { sourceStart: 50, length: 10 },
    ];
    const index = new SpanIndex<(typeof spans)[number]>();
    for (const span of spans) index.add(span);
    for (let start = 0; start < 550; start += 7) {
      for (let length = 0; length < 200; length += 13) {
        const found = index.containing(start, length);
        expect(found !== undefined).toBe(
          spans.some((s) => s.sourceStart <= start && s.sourceStart + s.length >= start + length),
        );
        if (found) expect(found.sourceStart + found.length).toBeGreaterThanOrEqual(start + length);
      }
    }
  });
});
