/**
 * Writable-tail ownership.
 *
 * `GrowableBuffer` lets sequential appends reuse spare capacity in a shared
 * backing array instead of copying the valid prefix on every keystroke. What
 * makes that safe is a module-level `WeakMap` recording which `GrowableBuffer`
 * currently owns the writable tail of each backing array. Only the owner may
 * write in place; anything else copies first.
 *
 * That ownership lives in process memory, not in `DocumentState`. These tests
 * pin the consequences, because the invariant is not visible in the serialized
 * state and is easy to break while refactoring:
 *
 * - branching from a stale version must not disturb the newer snapshot;
 * - ownership is per backing array, so growth transfers it;
 * - a buffer that crosses a serialization boundary (checkpoint, worker message)
 *   arrives with no ownership entry and must simply copy on first append.
 */

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

    // `base` is no longer the tail owner, so this must copy rather than write
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

  it("copies on first append after crossing a serialization boundary", () => {
    const original = GrowableBuffer.empty(64).append(bytesOf("persisted"));

    // A buffer rebuilt from bytes — as checkpoint restore or a worker message
    // does — shares no identity with the original, so it owns nothing and must
    // copy before writing.
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
