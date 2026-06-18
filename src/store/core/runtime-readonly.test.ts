import { describe, it, expect } from "vitest";
import {
  asReadonlyUint8Array,
  unwrapReadonlyUint8Array,
  asReadonlyMap,
  isReadonlyMapView,
  asReadonlySet,
  isReadonlySetView,
} from "./runtime-readonly.js";

describe("asReadonlyUint8Array", () => {
  it("should return the same proxy for repeated calls on the same array", () => {
    const raw = new Uint8Array([1, 2, 3]);
    const r1 = asReadonlyUint8Array(raw);
    const r2 = asReadonlyUint8Array(raw);
    expect(r1).toBe(r2);
  });

  it("should return the same object when passed an already-readonly array", () => {
    const raw = new Uint8Array([4, 5, 6]);
    const ro = asReadonlyUint8Array(raw);
    expect(asReadonlyUint8Array(ro)).toBe(ro);
  });

  it("should allow reading elements", () => {
    const raw = new Uint8Array([10, 20, 30]);
    const ro = asReadonlyUint8Array(raw);
    expect(ro[0]).toBe(10);
    expect(ro[1]).toBe(20);
    expect(ro.length).toBe(3);
  });

  it("should throw on mutating methods", () => {
    const raw = new Uint8Array([1, 2, 3]);
    const ro = asReadonlyUint8Array(raw);
    expect(() => (ro as Uint8Array).fill(0)).toThrow(TypeError);
    expect(() => (ro as Uint8Array).set([9])).toThrow(TypeError);
    expect(() => (ro as Uint8Array).copyWithin(0, 1)).toThrow(TypeError);
    expect(() => (ro as Uint8Array).reverse()).toThrow(TypeError);
    expect(() => (ro as Uint8Array).sort()).toThrow(TypeError);
  });

  it("should throw on property assignment", () => {
    const raw = new Uint8Array([1, 2, 3]);
    const ro = asReadonlyUint8Array(raw);
    expect(() => {
      (ro as unknown as Record<string, unknown>)[0] = 99;
    }).toThrow(TypeError);
  });

  it("should return a readonly subarray from subarray()", () => {
    const raw = new Uint8Array([1, 2, 3, 4]);
    const ro = asReadonlyUint8Array(raw);
    const sub = ro.subarray(1, 3);
    expect(sub[0]).toBe(2);
    expect(sub[1]).toBe(3);
  });

  it("should return a readonly slice from slice()", () => {
    const raw = new Uint8Array([1, 2, 3, 4]);
    const ro = asReadonlyUint8Array(raw);
    const sl = ro.slice(0, 2);
    expect(sl[0]).toBe(1);
    expect(sl[1]).toBe(2);
  });

  it("should return an isolated buffer copy from buffer", () => {
    const raw = new Uint8Array([1, 2, 3]);
    const ro = asReadonlyUint8Array(raw);
    const buf = ro.buffer;
    expect(buf.byteLength).toBe(3);
  });

  it("valueOf should return the proxy itself", () => {
    const raw = new Uint8Array([7]);
    const ro = asReadonlyUint8Array(raw);
    expect(ro.valueOf()).toBe(ro);
  });

  it("should throw on defineProperty", () => {
    const raw = new Uint8Array([1, 2, 3]);
    const ro = asReadonlyUint8Array(raw);
    expect(() => Object.defineProperty(ro as object, "0", { value: 99 })).toThrow(TypeError);
  });

  it("should throw on deleteProperty", () => {
    const raw = new Uint8Array([1, 2, 3]);
    const ro = asReadonlyUint8Array(raw);
    expect(() => {
      delete (ro as unknown as Record<string, unknown>)["0"];
    }).toThrow(TypeError);
  });
});

describe("unwrapReadonlyUint8Array", () => {
  it("should return the underlying raw array", () => {
    const raw = new Uint8Array([1, 2, 3]);
    const ro = asReadonlyUint8Array(raw);
    expect(unwrapReadonlyUint8Array(ro)).toBe(raw);
  });

  it("should return the array unchanged if not a readonly proxy", () => {
    const raw = new Uint8Array([1, 2, 3]);
    expect(unwrapReadonlyUint8Array(raw)).toBe(raw);
  });
});

describe("asReadonlyMap", () => {
  it("should return same view for repeated wraps of the same map", () => {
    const m = new Map([["a", 1]]);
    const r1 = asReadonlyMap(m);
    const r2 = asReadonlyMap(m);
    expect(r1).toBe(r2);
  });

  it("should return the same object when passed an already-readonly view", () => {
    const m = new Map([["x", 42]]);
    const ro = asReadonlyMap(m);
    expect(asReadonlyMap(ro)).toBe(ro);
  });

  it("should expose size, has, and get", () => {
    const m = new Map([["key", 99]]);
    const ro = asReadonlyMap(m);
    expect(ro.size).toBe(1);
    expect(ro.has("key")).toBe(true);
    expect(ro.get("key")).toBe(99);
    expect(ro.has("missing")).toBe(false);
  });

  it("should iterate via forEach", () => {
    const m = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const ro = asReadonlyMap(m);
    const collected: [string, number][] = [];
    ro.forEach((v, k) => collected.push([k, v]));
    expect(collected).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("should iterate via entries()", () => {
    const m = new Map([["z", 7]]);
    const ro = asReadonlyMap(m);
    expect([...ro.entries()]).toEqual([["z", 7]]);
  });

  it("should iterate via keys()", () => {
    const m = new Map([["k1", 0]]);
    const ro = asReadonlyMap(m);
    expect([...ro.keys()]).toEqual(["k1"]);
  });

  it("should iterate via values()", () => {
    const m = new Map([["v", 55]]);
    const ro = asReadonlyMap(m);
    expect([...ro.values()]).toEqual([55]);
  });

  it("should iterate via Symbol.iterator", () => {
    const m = new Map([["p", 3]]);
    const ro = asReadonlyMap(m);
    expect([...ro]).toEqual([["p", 3]]);
  });

  it("should report Symbol.toStringTag as Map", () => {
    const m = new Map<string, number>();
    const ro = asReadonlyMap(m);
    expect(ro[Symbol.toStringTag]).toBe("Map");
  });
});

describe("isReadonlyMapView", () => {
  it("should return true for a wrapped map", () => {
    const m = new Map([["a", 1]]);
    const ro = asReadonlyMap(m);
    expect(isReadonlyMapView(ro)).toBe(true);
  });

  it("should return false for a raw map", () => {
    const m = new Map([["a", 1]]);
    expect(isReadonlyMapView(m)).toBe(false);
  });
});

describe("asReadonlySet", () => {
  it("should return same view for repeated wraps of the same set", () => {
    const s = new Set([1, 2, 3]);
    const r1 = asReadonlySet(s);
    const r2 = asReadonlySet(s);
    expect(r1).toBe(r2);
  });

  it("should return the same object when passed an already-readonly view", () => {
    const s = new Set(["x"]);
    const ro = asReadonlySet(s);
    expect(asReadonlySet(ro)).toBe(ro);
  });

  it("should expose size and has", () => {
    const s = new Set([10, 20]);
    const ro = asReadonlySet(s);
    expect(ro.size).toBe(2);
    expect(ro.has(10)).toBe(true);
    expect(ro.has(99)).toBe(false);
  });

  it("should iterate via forEach", () => {
    const s = new Set([1, 2, 3]);
    const ro = asReadonlySet(s);
    const collected: number[] = [];
    ro.forEach((v) => collected.push(v));
    expect(collected).toEqual([1, 2, 3]);
  });

  it("should iterate via entries()", () => {
    const s = new Set([5]);
    const ro = asReadonlySet(s);
    expect([...ro.entries()]).toEqual([[5, 5]]);
  });

  it("should iterate via keys()", () => {
    const s = new Set(["hello"]);
    const ro = asReadonlySet(s);
    expect([...ro.keys()]).toEqual(["hello"]);
  });

  it("should iterate via values()", () => {
    const s = new Set([42]);
    const ro = asReadonlySet(s);
    expect([...ro.values()]).toEqual([42]);
  });

  it("should iterate via Symbol.iterator", () => {
    const s = new Set([7, 8]);
    const ro = asReadonlySet(s);
    expect([...ro]).toEqual([7, 8]);
  });

  it("should report Symbol.toStringTag as Set", () => {
    const s = new Set<number>();
    const ro = asReadonlySet(s);
    expect(ro[Symbol.toStringTag]).toBe("Set");
  });
});

describe("isReadonlySetView", () => {
  it("should return true for a wrapped set", () => {
    const s = new Set([1]);
    const ro = asReadonlySet(s);
    expect(isReadonlySetView(ro)).toBe(true);
  });

  it("should return false for a raw set", () => {
    const s = new Set([1]);
    expect(isReadonlySetView(s)).toBe(false);
  });
});
