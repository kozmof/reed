import type { LineIndexState, PieceTableState } from "../../types/state.js";
import { repairLineIndexWindow } from "./line-index.js";
import { pieceTableReader } from "./piece-table-reader.js";
import { codePointWindow } from "./utf8-seam.js";

/**
 * Repair the lines a chunk load or eviction touched. The splice replaced
 * [start, end) with `insertedLength` bytes to give `next`.
 *
 * The repair counts characters on each side of its window apart, so the window
 * is widened until no UTF-8 sequence of `next` crosses its edges (see
 * `codePointWindow`). Chunk bytes can complete a sequence cut at the seam.
 */
export function repairChunkLines(
  index: LineIndexState,
  next: PieceTableState,
  start: number,
  end: number,
  insertedLength: number,
  revision: number,
): LineIndexState {
  const window = codePointWindow(next, start, end, insertedLength);
  return repairLineIndexWindow(
    index,
    window.start,
    window.end,
    window.insertedLength,
    pieceTableReader(next),
    revision,
    true,
  );
}
