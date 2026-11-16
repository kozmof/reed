/**
 * Shared TextEncoder/TextDecoder singletons for the Reed document editor.
 * Centralizes encoding instances to avoid redundant per-module instantiation.
 */

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

/**
 * Decodes a range of document bytes the way the document counts them.
 * Malformed bytes become U+FFFD as with `textDecoder`, but a leading U+FEFF is
 * kept. The document treats U+FEFF as content wherever it appears, while
 * `textDecoder` drops it at the start of its input as a byte order mark.
 */
export const contentDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

// Rejects malformed input and keeps a leading byte order mark, so it decodes
// exactly the byte sequences that `textEncoder` produces.
const exactDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * True when `text` encodes to exactly `bytes` in UTF-8. UTF-8 encoding is a
 * bijection between strings without lone surrogates and well-formed bytes, so
 * this holds exactly when `bytes` decode strictly to `text`.
 */
export function encodesTo(text: string, bytes: Uint8Array): boolean {
  try {
    return exactDecoder.decode(bytes) === text;
  } catch {
    return false;
  }
}

/**
 * Return true when the UTF-16 code units at `index` and `index + 1` form a
 * valid surrogate pair.
 */
export function isSurrogatePairAt(text: string, index: number): boolean {
  const high = text.charCodeAt(index);
  if (high < 0xd800 || high > 0xdbff) return false;
  const low = text.charCodeAt(index + 1);
  return low >= 0xdc00 && low <= 0xdfff;
}

/**
 * Count the UTF-8 byte length of a JavaScript string without allocating a buffer.
 * Matches TextEncoder semantics, including lone surrogate replacement with U+FFFD.
 */
export function utf8ByteLength(text: string): number {
  let len = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      len += 1;
    } else if (c < 0x800) {
      len += 2;
    } else if (isSurrogatePairAt(text, i)) {
      len += 4;
      i++;
    } else {
      len += 3;
    }
  }
  return len;
}
