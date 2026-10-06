import { describe, expect, it, vi } from "vitest";
import { PersistentMap } from "./persistent-map.js";

describe("persistent ordered map", () => {
  it("matches Map through updates, deletions, reinsertion and branching", () => {
    let actual = PersistentMap.empty<string, number | undefined>();
    const expected = new Map<string, number | undefined>();
    const snapshots: Array<[typeof actual, Array<[string, number | undefined]>]> = [];
    let seed = 17;
    for (let i = 0; i < 3000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const key = String(seed % 300);
      if (i % 3 === 0) {
        expected.delete(key);
        actual = actual.without(key);
      } else {
        const value = i % 7 === 0 ? undefined : i;
        expected.set(key, value);
        actual = actual.with(key, value);
      }
      expect(actual.size).toBe(expected.size);
      expect(actual.has(key)).toBe(expected.has(key));
      expect(actual.get(key)).toBe(expected.get(key));
      if (i % 50 === 0) {
        expect([...actual]).toEqual([...expected]);
        snapshots.push([actual, [...expected]]);
      }
    }
    for (const [snapshot, entries] of snapshots) {
      expect([...snapshot]).toEqual(entries);
      expect([...snapshot.with("branch", 1).without("branch")]).toEqual(entries);
    }
    expect([...actual.keys()]).toEqual([...expected.keys()]);
    expect([...actual.values()]).toEqual([...expected.values()]);
    const visited: Array<[string, number | undefined]> = [];
    actual.forEach(function (this: unknown, value, key, map) {
      expect(map).toBe(actual);
      expect(this).toBe(visited);
      visited.push([key, value]);
    }, visited);
    expect(visited).toEqual([...expected]);
    expect(PersistentMap.from(actual)).toBe(actual);
    expect([...PersistentMap.from(expected)]).toEqual([...expected]);
    expect(actual.without("absent")).toBe(actual);
    expect(actual.with("same", 1).with("same", 1).get("same")).toBe(1);
    expect(Object.prototype.toString.call(actual)).toBe("[object Map]");
    expect(() => (actual as unknown as Map<string, number>).set("x", 1)).toThrow();
  });
});

it("merges unrelated insertion orders without repeated AVL lookups", () => {
  const original = new Map<string, number>(Array.from({ length: 4000 }, (_, i) => [`k${i}`, i]));
  const reordered = new Map([...original].reverse());
  reordered.delete("k1");
  reordered.set("k2", -1);
  reordered.set("new", 1);
  const previous = PersistentMap.from(original);
  const next = PersistentMap.from(reordered);
  const get = vi.spyOn(PersistentMap.prototype, "get");
  const has = vi.spyOn(PersistentMap.prototype, "has");
  try {
    expect(next.changedKeys(previous)).toEqual(["k2", "new", "k1"]);
    expect(get).not.toHaveBeenCalled();
    expect(has).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
    has.mockRestore();
  }
});

it("skips shared subtrees for a localized change in a large map", () => {
  let previous = PersistentMap.empty<number, number>();
  for (let i = 0; i < 16_000; i++) previous = previous.with(i, i);
  const next = previous.with(8000, -1);
  const pops = vi.spyOn(Array.prototype, "pop");
  let changed: number[];
  let work: number;
  try {
    changed = next.changedKeys(previous);
    work = pops.mock.calls.length;
  } finally {
    pops.mockRestore();
  }
  expect(changed).toEqual([8000]);
  expect(work).toBeLessThan(200);
});

it("diffs shared maps through rotations, deletions, undefined values, and branches", () => {
  let previous = PersistentMap.empty<string, number | undefined>();
  let seed = 31;
  for (let round = 0; round < 100; round++) {
    let next = previous;
    for (let i = 0; i < 30; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const key = String(seed % 200);
      next = i % 3 === 0 ? next.without(key) : next.with(key, i % 5 === 0 ? undefined : round);
    }
    const expected = [...next]
      .filter(([key, value]) => !previous.has(key) || previous.get(key) !== value)
      .map(([key]) => key);
    expected.push(...[...previous.keys()].filter((key) => !next.has(key)));
    expect(next.changedKeys(previous)).toEqual(expected);
    expect(previous.changedKeys(previous)).toEqual([]);
    previous = round % 5 === 0 ? previous.with("branch", round) : next;
  }
});
