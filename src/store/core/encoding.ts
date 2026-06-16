/**
 * Shared TextEncoder/TextDecoder singletons for the Reed document editor.
 * Centralizes encoding instances to avoid redundant per-module instantiation.
 */

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

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
