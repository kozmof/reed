import { expect, it } from "vitest";
import { PersistentHashMap } from "./persistent-hash-map.js";

it("preserves snapshots through hash collisions, removals and branching", () => {
  // Polynomial-31 hashes collide for every equal-length combination of Aa/BB.
  const keys = Array.from({ length: 256 }, (_, n) =>
    Array.from({ length: 8 }, (_, bit) => (n & (1 << bit) ? "Aa" : "BB")).join(""),
  );
  let map = PersistentHashMap.empty<string, number>();
  for (let i = 0; i < keys.length; i++) map = map.with(keys[i]!, i);
  const snapshot = map;
  for (let i = 0; i < keys.length; i += 2) map = map.without(keys[i]!);
  for (let i = 0; i < keys.length; i++) {
    expect(map.get(keys[i]!)).toBe(i % 2 ? i : undefined);
    expect(snapshot.get(keys[i]!)).toBe(i);
  }
  expect(map.with(keys[1]!, 1)).toBe(map);
  expect(map.without("missing")).toBe(map);
  expect(snapshot.with(keys[0]!, 99).get(keys[0]!)).toBe(99);
  expect(snapshot.get(keys[0]!)).toBe(0);
});

it("matches Map across mixed hash paths and complete deletion", () => {
  let actual = PersistentHashMap.empty<string, number | undefined>();
  const expected = new Map<string, number | undefined>();
  let seed = 73;
  for (let i = 0; i < 5000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const key = `p${seed % 1000}`;
    if (i % 3 === 0) {
      actual = actual.without(key);
      expected.delete(key);
    } else {
      const value = i % 7 === 0 ? undefined : i;
      actual = actual.with(key, value);
      expected.set(key, value);
    }
    expect(actual.get(key)).toBe(expected.get(key));
  }
  const snapshot = actual;
  for (const [key, value] of expected) {
    expect(actual.get(key)).toBe(value);
    actual = actual.without(key);
    expect(actual.get(key)).toBeUndefined();
    expect(snapshot.get(key)).toBe(value);
  }
  expect(actual.without("missing")).toBe(actual);
  expect(actual.with("new", 42).get("new")).toBe(42);
});
