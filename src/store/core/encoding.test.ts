import { describe, it, expect } from "vitest";
import { utf8ByteLength, isSurrogatePairAt } from "./encoding.js";

describe("utf8ByteLength", () => {
  it("returns 0 for empty string", () => {
    expect(utf8ByteLength("")).toBe(0);
  });

  it("counts 1 byte per ASCII character", () => {
    expect(utf8ByteLength("hello")).toBe(5);
  });

  it("counts 2 bytes for Latin-extended characters (U+0080–U+07FF)", () => {
    // 'é' = U+00E9 → 2 UTF-8 bytes
    expect(utf8ByteLength("é")).toBe(2);
    // 'ñ' = U+00F1 → 2 bytes; 'café' = 4 + 1 extra = 5 bytes total
    expect(utf8ByteLength("café")).toBe(5);
  });

  it("counts 3 bytes for BMP characters outside the 2-byte range (U+0800–U+D7FF)", () => {
    // '世' = U+4E16 → 3 UTF-8 bytes
    expect(utf8ByteLength("世")).toBe(3);
    expect(utf8ByteLength("世界")).toBe(6);
  });

  it("counts 4 bytes for emoji (surrogate pairs, U+10000+)", () => {
    // '😀' = U+1F600 → surrogate pair in JS, 4 UTF-8 bytes
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("A😀B")).toBe(6);
  });

  it("matches TextEncoder byte count", () => {
    const enc = new TextEncoder();
    const samples = ["", "abc", "café", "世界", "😀🚀", "hello world\n"];
    for (const s of samples) {
      expect(utf8ByteLength(s)).toBe(enc.encode(s).length);
    }
  });
});

describe("isSurrogatePairAt", () => {
  it("returns true for a valid surrogate pair", () => {
    const emoji = "😀"; // U+1F600 = U+D83D U+DE00
    expect(isSurrogatePairAt(emoji, 0)).toBe(true);
  });

  it("returns false for regular characters", () => {
    expect(isSurrogatePairAt("abc", 0)).toBe(false);
    expect(isSurrogatePairAt("世界", 0)).toBe(false);
  });

  it("returns false for a lone high surrogate at end of string", () => {
    const lone = "\uD83D"; // high surrogate only
    expect(isSurrogatePairAt(lone, 0)).toBe(false);
  });
});
