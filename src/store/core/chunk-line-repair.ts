import type { LineIndexState, PieceTableState } from "../../types/state.js";
import { byteOffset } from "../../types/branded.js";
import { getRawByte } from "./piece-table.js";
import { repairLineIndexWindow } from "./line-index.js";
import { pieceTableReader } from "./piece-table-reader.js";

/** Include the decoder's at-most-three bytes of state on both sides of a raw splice. */
export function repairChunkLines(
  index: LineIndexState,
  previous: PieceTableState,
  next: PieceTableState,
  start: number,
  end: number,
  insertedLength: number,
  revision: number,
): LineIndexState {
  // Metrics are counted separately on each side of `from` and `to`, so no
  // sequence may cross them. A seam is safe on a non-continuation byte, or on
  // a continuation byte whose three predecessors are continuation bytes: a
  // lead claims at most three, so none can reach it. Malformed input can hold
  // longer continuation runs; stopping inside one after three steps could
  // split a sequence that starts before the run.
  let from = Math.max(0, start - 3);
  let to = Math.min(previous.totalLength, end + 3);
  const isContinuation = (offset: number) =>
    (getRawByte(previous, byteOffset(offset)) & 0xc0) === 0x80;
  // Step back to a non-continuation byte (or the document start) within three
  // bytes. If all four bytes are continuations, `from` itself is already safe.
  for (let k = 0; k <= 3; k++) {
    if (from - k === 0 || !isContinuation(from - k)) {
      from -= k;
      break;
    }
  }
  for (
    let i = 0;
    i < 3 && to < previous.totalLength && (getRawByte(previous, byteOffset(to)) & 0xc0) === 0x80;
    i++
  )
    to++;
  return repairLineIndexWindow(
    index,
    byteOffset(from),
    byteOffset(to),
    insertedLength + start - from + to - end,
    pieceTableReader(next),
    revision,
    true,
  );
}
