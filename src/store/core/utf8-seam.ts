/**
 * Where document bytes can be split so each side decodes as it does in the
 * whole document. Line-index repairs count characters on each side of such a
 * split apart, so every repair widens its window to safe splits here.
 */

import type { PieceTableState } from "../../types/state.js";
import { byteOffset, type ByteOffset } from "../../types/branded.js";
import { getRawByte } from "./piece-table.js";

/** Bytes a UTF-8 lead byte can own after it. */
export const MAX_CONTINUATION_BYTES = 3;

/** True for a UTF-8 continuation byte (`10xxxxxx`). */
export function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

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
  if (offset <= 0 || offset >= pieceTable.totalLength) return true;
  const continuationAt = (at: number) => isContinuationByte(getRawByte(pieceTable, byteOffset(at)));
  if (!continuationAt(offset)) return true;
  for (let back = 1; back <= MAX_CONTINUATION_BYTES; back++) {
    if (offset - back < 0 || !continuationAt(offset - back)) return false;
  }
  return true;
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
