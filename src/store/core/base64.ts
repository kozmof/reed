/**
 * Base64 codec for byte payloads embedded in JSON.
 *
 * Reed serializes raw buffers (chunk data in `LOAD_CHUNK`, the original/add/chunk
 * buffers in a checkpoint) as base64 so the surrounding envelope stays plain JSON.
 * The implementation does not rely on `btoa`/`Buffer`, which are not both
 * available across the runtimes Reed targets. Encoding uses the standard
 * `Uint8Array.prototype.toBase64` when present and a self-contained fallback
 * otherwise.
 */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_DECODE_TABLE = (() => {
  const table = new Uint8Array(256);
  table.fill(255);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

const BASE64_CODES = Uint8Array.from(BASE64_ALPHABET, (char) => char.charCodeAt(0));
const PADDING = 0x3d; // "="
const asciiDecoder = new TextDecoder();

type MaybeNativeBase64 = Uint8Array & { toBase64?: () => string };

/**
 * Encode bytes as a standard, padded base64 string.
 *
 * Uses the native `Uint8Array.prototype.toBase64` where the runtime has it.
 * Otherwise writes ASCII codes into one buffer and decodes it once, which
 * avoids building the output through per-character string concatenation.
 */
export function encodeBase64(bytes: Uint8Array): string {
  const native = (bytes as MaybeNativeBase64).toBase64;
  if (typeof native === "function") return native.call(bytes);

  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let i = 0;
  let o = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const triplet = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = BASE64_CODES[(triplet >> 18) & 0x3f]!;
    out[o++] = BASE64_CODES[(triplet >> 12) & 0x3f]!;
    out[o++] = BASE64_CODES[(triplet >> 6) & 0x3f]!;
    out[o++] = BASE64_CODES[triplet & 0x3f]!;
  }

  const remaining = bytes.length - i;
  if (remaining > 0) {
    const triplet = (bytes[i]! << 16) | (remaining === 2 ? bytes[i + 1]! << 8 : 0);
    out[o++] = BASE64_CODES[(triplet >> 18) & 0x3f]!;
    out[o++] = BASE64_CODES[(triplet >> 12) & 0x3f]!;
    out[o++] = remaining === 2 ? BASE64_CODES[(triplet >> 6) & 0x3f]! : PADDING;
    out[o++] = PADDING;
  }

  return asciiDecoder.decode(out);
}

function decodeBase64Char(base64: string, index: number): number {
  const code = base64.charCodeAt(index);
  return code <= 0xff ? BASE64_DECODE_TABLE[code]! : 255;
}

/**
 * Decode a standard, padded base64 string.
 *
 * @throws Error when the payload length or any character is not valid base64.
 */
export function decodeBase64(base64: string): Uint8Array {
  if (base64.length % 4 !== 0) {
    throw new Error("Invalid base64 payload length");
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((base64.length / 4) * 3 - padding);
  let offset = 0;

  for (let i = 0; i < base64.length; i += 4) {
    const c0 = decodeBase64Char(base64, i);
    const c1 = decodeBase64Char(base64, i + 1);
    const ch2 = base64[i + 2];
    const ch3 = base64[i + 3];

    if (c0 === 255 || c1 === 255) {
      throw new Error("Invalid base64 payload");
    }
    if (i < base64.length - 4 && (ch2 === "=" || ch3 === "=")) {
      throw new Error("Invalid base64 payload");
    }
    if (ch2 === "=" && ch3 !== "=") {
      throw new Error("Invalid base64 payload");
    }

    const c2 = ch2 === "=" ? 0 : decodeBase64Char(base64, i + 2);
    const c3 = ch3 === "=" ? 0 : decodeBase64Char(base64, i + 3);
    if ((ch2 !== "=" && c2 === 255) || (ch3 !== "=" && c3 === 255)) {
      throw new Error("Invalid base64 payload");
    }

    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    output[offset++] = (triplet >> 16) & 0xff;
    if (ch2 !== "=") {
      output[offset++] = (triplet >> 8) & 0xff;
    }
    if (ch3 !== "=") {
      output[offset++] = triplet & 0xff;
    }
  }

  return output;
}
