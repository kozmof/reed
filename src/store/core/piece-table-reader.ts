import type { PieceTableState } from "../../types/state.js";
import type { ReadTextFn } from "../../types/operations.js";
import { getText } from "./piece-table.js";
import { countPieceTableChars } from "./piece-table-metrics.js";
import { scanPieceLines, summarizePieceRange } from "./decoded-metrics.js";

export function pieceTableReader(state: PieceTableState): ReadTextFn {
  const read: ReadTextFn = (start, end) => getText(state, start, end);
  read.countChars =
    state.chunkMap.size === 0
      ? (start, end) => countPieceTableChars(state, start, end)
      : (start, end) => summarizePieceRange(state, start, end).chars;
  read.scanLines = (start, end) => scanPieceLines(state, start, end);
  return read;
}
