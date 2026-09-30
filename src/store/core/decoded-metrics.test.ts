import { describe, expect, it } from "vitest";
import { decodedCharLength, summarizeBytes, joinDecoded } from "./decoded-metrics.js";
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

describe("composable decoding counts", () => {
  it("matches replacement decoding for malformed and split UTF-8", () => {
    let seed = 9173;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed >>> 24;
    };
    const fixtures = [
      new TextEncoder().encode("漢😀\uFEFF\r\nx".repeat(1000)),
      Uint8Array.of(0xf0, 0x90, 0x80, 0x80),
      Uint8Array.of(0xed, 0xa0, 0x80),
      Uint8Array.of(0xe0, 0x80, 0x80),
      Uint8Array.of(0xf4, 0x90, 0x80, 0x80),
    ];
    for (let i = 0; i < 100; i++) fixtures.push(Uint8Array.from({ length: 100 }, random));
    for (const bytes of fixtures) {
      expect(decodedCharLength(bytes)).toBe(decoder.decode(bytes).length);
      for (
        let split = 0;
        split <= bytes.length;
        split += Math.max(1, Math.floor(bytes.length / 50))
      ) {
        const left = summarizeBytes(bytes, 0, split),
          right = summarizeBytes(bytes, split);
        expect(joinDecoded(left, right).chars).toBe(decoder.decode(bytes).length);
      }
      for (
        let start = 0;
        start < bytes.length;
        start += Math.max(1, Math.floor(bytes.length / 20))
      ) {
        const end = Math.min(bytes.length, start + 4099);
        expect(summarizeBytes(bytes, start, end).chars).toBe(
          decoder.decode(bytes.subarray(start, end)).length,
        );
      }
    }
  });
});
