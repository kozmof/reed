/**
 * History namespace — undo/redo state queries.
 */

import {
  canUndo,
  canRedo,
  getUndoCount,
  getRedoCount,
  isHistoryEmpty,
} from "../store/features/history.js";
import type { HistoryApi } from "./interfaces.js";

export const history: HistoryApi = {
  /** @complexity O(1) — checks undo stack depth */
  canUndo,
  /** @complexity O(1) — checks redo stack depth */
  canRedo,
  /** @complexity O(1) — reads undo stack length */
  getUndoCount,
  /** @complexity O(1) — reads redo stack length */
  getRedoCount,
  /** @complexity O(1) — both stacks empty */
  isHistoryEmpty,
};
