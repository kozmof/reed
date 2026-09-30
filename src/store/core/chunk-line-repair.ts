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
  let from = Math.max(0, start - 3);
  let to = Math.min(previous.totalLength, end + 3);
  for (
    let i = 0;
    i < 3 && from > 0 && (getRawByte(previous, byteOffset(from)) & 0xc0) === 0x80;
    i++
  )
    from--;
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
