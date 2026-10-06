/** Snapshot isolation, writable tails, and shared immutable buffer segments. */

import { describe, expect, it } from "vitest";
import { GrowableBuffer } from "./growable-buffer.js";
import { unwrapReadonlyUint8Array } from "./runtime-readonly.js";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const textOf = (buffer: GrowableBuffer): string =>
  new TextDecoder().decode(unwrapReadonlyUint8Array(buffer.bytes));

describe("writable tail ownership", () => {
  it("reuses spare capacity for sequential appends", () => {
    const base = GrowableBuffer.empty(64);
    const first = base.append(bytesOf("abc"));
    const second = first.append(bytesOf("def"));

    expect(textOf(second)).toBe("abcdef");
    // The prefix view of each ancestor stays at its own length.
    expect(textOf(first)).toBe("abc");
    expect(textOf(base)).toBe("");
  });

  it("does not let a branch overwrite bytes visible through a newer snapshot", () => {
    const base = GrowableBuffer.empty(64).append(bytesOf("shared"));
    const mainline = base.append(bytesOf("-MAIN"));

    // `base` is no longer the tail owner, so this must share its prefix rather than write
    // over the bytes `mainline` can see.
    const branch = base.append(bytesOf("-BRANCH"));

    expect(textOf(mainline), "mainline is unaffected by the branch").toBe("shared-MAIN");
    expect(textOf(branch)).toBe("shared-BRANCH");
    expect(textOf(base), "the shared ancestor is unchanged").toBe("shared");
  });

  it("keeps every version stable across a long branch-and-extend sequence", () => {
    const root = GrowableBuffer.empty(8).append(bytesOf("r"));
    const versions: GrowableBuffer[] = [root];

    // Interleave extending the newest version with branching from the oldest,
    // which is the rollback-then-edit shape the ownership check exists for.
    for (let i = 0; i < 24; i++) {
      versions.push(versions[versions.length - 1]!.append(bytesOf(String(i % 10))));
      versions.push(root.append(bytesOf("!")));
    }

    expect(textOf(root), "root never changes").toBe("r");
    for (const version of versions) {
      // Every snapshot must still decode to exactly its own recorded prefix.
      expect(textOf(version).length).toBe(version.length);
    }
  });

  it("transfers ownership when growth allocates a new backing array", () => {
    // Capacity 4 forces a reallocation on the second append.
    const small = GrowableBuffer.empty(4).append(bytesOf("abcd"));
    const grown = small.append(bytesOf("efgh"));
    const alsoFromSmall = small.append(bytesOf("XY"));

    expect(textOf(grown)).toBe("abcdefgh");
    expect(textOf(alsoFromSmall)).toBe("abcdXY");
    expect(textOf(small)).toBe("abcd");
  });

  it("preserves restored bytes on first append after serialization", () => {
    const original = GrowableBuffer.empty(64).append(bytesOf("persisted"));

    // A buffer rebuilt from bytes — as checkpoint restore or a worker message
    // does — has independent storage from the original.
    const rebuilt = new GrowableBuffer(
      Uint8Array.from(unwrapReadonlyUint8Array(original.bytes)),
      original.length,
    );
    const extended = rebuilt.append(bytesOf("-more"));

    expect(textOf(extended)).toBe("persisted-more");
    expect(textOf(original), "the original is untouched").toBe("persisted");
  });

  it("exposes a stable prefix view that later appends cannot extend", () => {
    const first = GrowableBuffer.empty(64).append(bytesOf("abc"));
    const view = first.bytes;
    first.append(bytesOf("def"));

    expect(view.length, "an old snapshot's view keeps its length").toBe(3);
    expect(new TextDecoder().decode(unwrapReadonlyUint8Array(view))).toBe("abc");
  });

  it("refuses mutation through the exposed view", () => {
    const buffer = GrowableBuffer.empty(64).append(bytesOf("abc"));
    expect(() => (buffer.bytes as unknown as Uint8Array).set([120], 0)).toThrow(TypeError);
  });
});

it("shares the prefix across branches and reads small ranges without flattening", () => {
  const original = GrowableBuffer.empty().append(bytesOf("x".repeat(2_000_000)));
  const mainline = original.append(bytesOf("MAIN"));
  const branch = original.append(bytesOf("BRANCH"));
  const originalRange = [...original.ranges(0, 1)][0]!;
  const branchRange = [...branch.ranges(0, 1)][0]!;
  expect(unwrapReadonlyUint8Array(branchRange.bytes).buffer).toBe(
    unwrapReadonlyUint8Array(originalRange.bytes).buffer,
  );
  expect(
    new TextDecoder().decode(unwrapReadonlyUint8Array(branch.subarray(1_999_998, branch.length))),
  ).toBe("xxBRANCH");
  expect(textOf(mainline)).toBe("x".repeat(2_000_000) + "MAIN");
  expect(branch.length).toBe(2_000_006);
  expect(original.length).toBe(2_000_000);
});

it("balances many sealed segments and keeps both sides of a fork readable", () => {
  let buffer = GrowableBuffer.empty();
  let expected = "";
  for (let i = 0; i < 2000; i++) {
    const stale = buffer;
    buffer.append(bytesOf("discard"));
    const text = `漢😀${i},`;
    buffer = stale.append(bytesOf(text));
    expected += text;
  }
  expect(textOf(buffer)).toBe(expected);
  const bytes = bytesOf(expected);
  for (let start = 0; start < bytes.length; start += 997)
    expect([...buffer.subarray(start, Math.min(start + 1500, bytes.length))]).toEqual([
      ...bytes.subarray(start, start + 1500),
    ]);
  expect(() => buffer.subarray(-1, 1)).toThrow();
  expect(() => buffer.subarray(0, buffer.length + 1)).toThrow();
  expect(buffer.append(new Uint8Array())).toBe(buffer);
});
