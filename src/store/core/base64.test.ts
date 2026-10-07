/** Native and fallback base64 encoding agree with a reference and round-trip. */

import { describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64 } from "./base64.js";

/** Hide the native encoder on one instance so encodeBase64 takes its fallback. */
function withoutNative(bytes: Uint8Array): Uint8Array {
  Object.defineProperty(bytes, "toBase64", { value: undefined });
  return bytes;
}

const reference = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

function patterned(length: number, seed = 7): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 131 + seed) & 0xff);
}

const hasNative =
  typeof (Uint8Array.prototype as { toBase64?: unknown }).toBase64 === "function";

describe.each([
  ["native", (bytes: Uint8Array) => bytes],
  ["fallback", withoutNative],
])("encodeBase64 (%s)", (path, prepare) => {
  it.skipIf(path === "native" && !hasNative)("covers every padding remainder", () => {
    for (let length = 0; length <= 10; length++) {
      const bytes = patterned(length);
      expect(encodeBase64(prepare(bytes))).toBe(reference(bytes));
    }
  });

  it.skipIf(path === "native" && !hasNative)("encodes all byte values and large payloads", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(encodeBase64(prepare(all))).toBe(reference(all));
    const large = patterned(300_001, 3);
    expect(encodeBase64(prepare(large))).toBe(reference(large));
  });

  it.skipIf(path === "native" && !hasNative)("encodes only the bytes a view covers", () => {
    const view = patterned(100).subarray(17, 62);
    expect(encodeBase64(prepare(view))).toBe(reference(view));
  });

  it.skipIf(path === "native" && !hasNative)("round-trips through decodeBase64", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 1_000, 65_537]) {
      const bytes = patterned(length, length);
      expect(Array.from(decodeBase64(encodeBase64(prepare(bytes))))).toEqual(Array.from(bytes));
    }
  });
});
