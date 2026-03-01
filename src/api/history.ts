/**
 * History namespace — undo/redo state queries.
 */

import {
  canUndo,
  canRedo,
  getUndoCount,
  getRedoCount,
  isHistoryEmpty,
} from '../store/features/history.ts';

export const history = {
  canUndo,
  canRedo,
  getUndoCount,
  getRedoCount,
  isHistoryEmpty,
} as const;
