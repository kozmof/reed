/**
 * History namespace — undo/redo state queries.
 */

import { $constCostFn } from "../types/cost-doc.js";
import {
  canUndo,
  canRedo,
  getUndoCount,
  getRedoCount,
  isHistoryEmpty,
} from "../store/features/history.js";
import type { HistoryApi } from "./interfaces.js";

export const history = {
  canUndo: $constCostFn(canUndo),
  canRedo: $constCostFn(canRedo),
  getUndoCount: $constCostFn(getUndoCount),
  getRedoCount: $constCostFn(getRedoCount),
  isHistoryEmpty: $constCostFn(isHistoryEmpty),
} satisfies HistoryApi;
