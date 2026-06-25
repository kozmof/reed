/**
 * UTF-8 byte ↔ UTF-16 character offset conversion.
 *
 * The piece table stores UTF-8 byte offsets while JavaScript strings are indexed
 * by UTF-16 code units. These two helpers translate between the two encodings for
 * a given text. They are pure string functions with no piece-table state, so they
 * live in this leaf module; `piece-table.ts` re-exports them to preserve the
 * public import surface.
 */

import { $proveCtx, $lift, type LinearCost } from "../../types/cost-doc.js";
import { textEncoder } from "./encoding.js";

/**
 * Convert a character offset to byte offset within a given text.
 *
 * Use this when converting user input (string indices) to piece table positions.
 * The piece table internally uses UTF-8 byte offsets, but JavaScript strings
 * use UTF-16 code unit indices.
 *
 * @param text - The text to measure
 * @param charOffset - Character offset (UTF-16 code units, i.e. string index)
 * @returns Byte offset (UTF-8 bytes)
 *
 * @example
 * ```typescript
 * charToByteOffset('Hello', 2);     // Returns 2 (ASCII: 1 byte per char)
 * charToByteOffset('你好', 1);       // Returns 3 (CJK: 3 bytes per char)
 * charToByteOffset('Hello 😀', 7);  // Returns 8 (emoji: 4 bytes)
 * ```
 */
export function charToByteOffset(text: string, charOffset: number): LinearCost<number> {
  const clampedOffset = Math.max(0, Math.min(charOffset, text.length));
  let bytes = 0;
  for (let i = 0; i < clampedOffset; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate: lone encodes as 3 bytes; full pair adds 1 more (4 total).
      bytes += 3;
      const lo = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        bytes += 1;
        i++;
      }
    } else {
      bytes += 3;
    }
  }
  return $proveCtx("O(n)", $lift("O(n)", bytes));
}

/**
 * Convert a byte offset to character offset within a given text.
 *
 * Use this when converting piece table positions to user-visible indices.
 * Returns the character index that corresponds to (or is just before) the given byte offset.
 *
 * @param text - The text to measure
 * @param byteOffset - Byte offset (UTF-8 bytes)
 * @returns Character offset (UTF-16 code units, i.e. string index)
 *
 * @example
 * ```typescript
 * byteToCharOffset('Hello', 2);     // Returns 2 (ASCII: 1 byte per char)
 * byteToCharOffset('你好', 3);       // Returns 1 (CJK: 3 bytes per char)
 * byteToCharOffset('你好', 4);       // Returns 1 (mid-character, returns start)
 * ```
 */
export function byteToCharOffset(text: string, byteOffset: number): LinearCost<number> {
  if (byteOffset <= 0) return $proveCtx("O(n)", $lift("O(n)", 0));

  const bytes = textEncoder.encode(text);
  if (byteOffset >= bytes.length) return $proveCtx("O(n)", $lift("O(n)", text.length));

  // Single encode + byte scanning using UTF-8 sequence length detection
  let charPos = 0;
  let bytePos = 0;

  while (bytePos < byteOffset) {
    const b = bytes[bytePos];
    let seqLen: number;
    if (b < 0x80) seqLen = 1;
    else if ((b & 0xe0) === 0xc0) seqLen = 2;
    else if ((b & 0xf0) === 0xe0) seqLen = 3;
    else seqLen = 4;

    if (bytePos + seqLen > byteOffset) break;
    bytePos += seqLen;
    // 4-byte UTF-8 sequences map to 2 JS chars (surrogate pairs)
    charPos += seqLen === 4 ? 2 : 1;
  }

  return $proveCtx("O(n)", $lift("O(n)", charPos));
}
