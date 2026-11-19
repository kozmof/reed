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

/** Number of U+FFFD characters in `text`. */
function replacementCharCount(text: string): number {
  let count = 0;
  for (let i = text.indexOf("\uFFFD"); i >= 0; i = text.indexOf("\uFFFD", i + 1)) count++;
  return count;
}

/** Number of UTF-8 encoded U+FFFD sequences (EF BF BD) in `bytes`. */
function encodedReplacementCount(bytes: Uint8Array): number {
  let count = 0;
  for (let i = bytes.indexOf(0xef); i >= 0; i = bytes.indexOf(0xef, i + 1)) {
    if (bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd) count++;
  }
  return count;
}

/**
 * `bytes` decoded as the document decodes them (see `contentDecoder`), and
 * whether the text encodes back to exactly those bytes. History keeps a run's
 * bytes beside its text when it does not, such as where a run edge cuts a
 * character.
 *
 * `contentDecoder` keeps a byte order mark, so decoding changes bytes only by
 * replacing malformed sequences with U+FFFD. Text without U+FFFD, which one
 * native scan finds, is therefore exact. Bytes may also hold a genuine
 * U+FFFD. EF never continues a sequence, so the decoder starts a new one at
 * every EF, and each EF BF BD decodes to one U+FFFD. Every other U+FFFD
 * replaced malformed bytes, so the text is exact when it holds as many U+FFFD
 * as the bytes hold EF BF BD. Both counts are native scans, without decoding
 * the bytes a second time.
 */
export function decodeRun(bytes: Uint8Array): { readonly text: string; readonly exact: boolean } {
  const text = contentDecoder.decode(bytes);
  if (!text.includes("\uFFFD")) return { text, exact: true };
  return { text, exact: replacementCharCount(text) === encodedReplacementCount(bytes) };
}

/** True for a UTF-8 continuation byte (`10xxxxxx`). */
export function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
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
