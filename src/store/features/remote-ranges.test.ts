import { expect, it } from "vitest";
import { transformRemoteRanges } from "./remote-ranges.js";

type Entry = { type: "insert" | "delete"; start: number; end: number };
function reference(entries: Entry[]): [number, number][] {
  return entries.map((entry, i) => {
    let { start, end } = entry;
    for (const later of entries.slice(i + 1)) {
      const length = later.end - later.start;
      if (later.type === "insert") {
        if (later.start <= start) {
          start += length;
          end += length;
        } else if (later.start < end) end += length;
      } else {
        const move = (n: number) =>
          n <= later.start ? n : n >= later.end ? n - length : later.start;
        start = move(start);
        end = move(end);
      }
    }
    return [start, Math.max(start, end)];
  });
}

it("matches sequential transforms for overlaps, collapsed ranges, and boundary insertions", () => {
  let seed = 321;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let sample = 0; sample < 300; sample++) {
    let length = 30;
    const entries: Entry[] = [];
    for (let i = 0; i < 80; i++) {
      const start = Math.floor(random() * (length + 1));
      if (random() < 0.5 || start === length) {
        const size = 1 + Math.floor(random() * 10);
        entries.push({ type: "insert", start, end: start + size });
        length += size;
      } else {
        const end = start + 1 + Math.floor(random() * (length - start));
        entries.push({ type: "delete", start, end });
        length -= end - start;
      }
    }
    expect(transformRemoteRanges(entries)).toEqual(reference(entries));
  }
});

it("handles a large remote batch with repeated collapsed coordinates", () => {
  const entries: Entry[] = Array.from({ length: 30_000 }, (_, i) =>
    i % 2 === 0 ? { type: "insert", start: 0, end: 1 } : { type: "delete", start: 0, end: 1 },
  );
  const ranges = transformRemoteRanges(entries);
  expect(ranges).toHaveLength(entries.length);
  expect(ranges.every(([start, end], i) => start === 0 && end === i % 2)).toBe(true);
  expect(ranges.at(-1)).toEqual([0, 1]);
});
