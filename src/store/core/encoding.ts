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
 * True when `text`, the decoding of `length` bytes, is known to encode back to
 * them without comparing bytes.
 *
 * `contentDecoder` keeps a byte order mark, so decoding changes bytes only by
 * replacing malformed sequences with U+FFFD. Text `decoded` by it from those
 * very bytes is therefore exact when it has no U+FFFD, which one native scan
 * finds. Text from elsewhere must also have the right length. A replacement
 * can keep the length (three malformed bytes become one 3-byte U+FFFD), so
 * text containing U+FFFD has to be compared byte for byte.
 */
export function isExactDecoding(text: string, length: number, decoded: boolean): boolean {
  return !text.includes("�") && (decoded || utf8ByteLength(text) === length);
}

/**
 * `bytes` decoded as the document decodes them (see `contentDecoder`), and
 * whether the text encodes back to exactly those bytes. History keeps a run's
 * bytes beside its text when it does not, such as where a run edge cuts a
 * character.
 */
export function decodeRun(bytes: Uint8Array): { readonly text: string; readonly exact: boolean } {
  const text = contentDecoder.decode(bytes);
  return { text, exact: isExactDecoding(text, bytes.length, true) || encodesTo(text, bytes) };
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
