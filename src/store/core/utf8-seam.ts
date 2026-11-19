/**
 * Where document bytes can be split so each side decodes as it does in the
 * whole document. Line-index repairs count characters on each side of such a
 * split apart, so every repair widens its window to safe splits here.
 */

import type { PieceTableState } from "../../types/state.js";
import { byteOffset, type ByteOffset } from "../../types/branded.js";
import { getRawByte } from "./piece-table.js";
import { isContinuationByte, isSurrogatePairAt, textEncoder, utf8ByteLength } from "./encoding.js";

/** Bytes a UTF-8 lead byte can own after it. */
export const MAX_CONTINUATION_BYTES = 3;

/**
 * True when splitting the bytes of `pieceTable` at `offset` leaves the decoding
 * of both sides as it is in the whole document, so their characters can be
 * counted apart.
 *
 * A decoder ends a pending sequence at a byte that is not a continuation byte,
 * just as it does at the end of its input, so splitting before such a byte is
 * safe. So is splitting before a continuation byte that follows three others:
 * no lead byte can own it, so it decodes to U+FFFD on its own either way.
 */
export function isSafeSplit(pieceTable: PieceTableState, offset: number): boolean {
  return isSafeSplitOf(
    (at) => getRawByte(pieceTable, byteOffset(at)),
    pieceTable.totalLength,
    offset,
  );
}

/** `isSafeSplit` over the `length` bytes that `byteAt` reads. */
function isSafeSplitOf(byteAt: (at: number) => number, length: number, offset: number): boolean {
  if (offset <= 0 || offset >= length) return true;
  if (!isContinuationByte(byteAt(offset))) return true;
  for (let back = 1; back <= MAX_CONTINUATION_BYTES; back++) {
    if (offset - back < 0 || !isContinuationByte(byteAt(offset - back))) return false;
  }
  return true;
}

/**
 * True when both edges of the splice that replaces [start, end) of
 * `pieceTable` with `text` will be safe splits (see `isSafeSplit`) of the
 * document after it. It reads the splice without applying it, so a caller can
 * pick how to update lines before editing.
 *
 * `text` encodes to well-formed UTF-8, so its first byte is never a
 * continuation byte and its last character is complete. A split checks the
 * continuation byte at the offset, then up to three bytes before it, stopping
 * at the first byte that is not a continuation byte. Inside the text that is
 * the lead byte of its last character at the latest, so only the bytes of
 * that last character are read. The rest of the text reads as a lead byte,
 * which is what a split checks of its first byte.
 */
export function isSafeSplice(
  pieceTable: PieceTableState,
  start: number,
  end: number,
  text: string,
): boolean {
  const length = utf8ByteLength(text);
  const lastUnits = isSurrogatePairAt(text, text.length - 2) ? 2 : 1;
  const tail = textEncoder.encode(text.slice(-lastUnits));
  const tailStart = start + length - tail.length;
  const shift = end - start - length;
  const byteAt = (at: number): number => {
    if (at < start) return getRawByte(pieceTable, byteOffset(at));
    if (at >= start + length) return getRawByte(pieceTable, byteOffset(at + shift));
    // Any byte that is not a continuation byte reads the same to a split.
    return at >= tailStart ? tail[at - tailStart]! : 0;
  };
  const total = pieceTable.totalLength - shift;
  return isSafeSplitOf(byteAt, total, start) && isSafeSplitOf(byteAt, total, start + length);
}

/**
 * Widen a splice that replaced [start, end) with `insertedLength` bytes so both
 * edges of the inserted bytes are safe splits of `pieceTable`, the document
 * after the splice (see `isSafeSplit`). `start` and `end` are offsets before
 * the splice.
 *
 * Spliced bytes can join the bytes beside them into one character, for example
 * a chunk whose leading continuation bytes complete a lead byte before it, or
 * a lead byte that undo re-inserts before such a chunk. Counted apart, those
 * bytes give one U+FFFD each. The bytes the window gains are the same in both
 * documents, so they count as deleted and re-inserted. A safe split lies
 * within four bytes of any offset.
 */
export function codePointWindow(
  pieceTable: PieceTableState,
  start: number,
  end: number,
  insertedLength: number,
): { start: ByteOffset; end: ByteOffset; insertedLength: number } {
  let before = 0;
  while (!isSafeSplit(pieceTable, start - before)) before++;
  const insertedEnd = start + insertedLength;
  let after = 0;
  while (!isSafeSplit(pieceTable, insertedEnd + after)) after++;
  return {
    start: byteOffset(start - before),
    end: byteOffset(end + after),
    insertedLength: insertedLength + before + after,
  };
}
