/** The diff namespace compares text and replaces document content. */

import {
  diff as diffAlgorithm,
  computeSetValueActions,
  computeSetValueActionsOptimized,
  computeSetValueActionsFromState,
  computeSetValueActionsFromStateWithDiff,
  setValue,
  setValueWithDiff,
  setValueAuto,
} from "../store/features/diff.js";
export type { SetValueOptions } from "../store/features/diff.js";

export const diff = {
  diff: diffAlgorithm,
  computeSetValueActions,
  computeSetValueActionsOptimized,
  computeSetValueActionsFromState,
  computeSetValueActionsFromStateWithDiff,
  /** Replace the changed region with one REPLACE operation in O(n). Best for interactive edits. */
  setValue,
  /** Compute a memory-bounded Myers script in O(n²). Use when finer history matters. */
  setValueWithDiff,
  /**
   * Set document content with the strategy selected by `options.strategy`.
   * The default uses `setValue` in O(n). The diff strategy uses
   * `setValueWithDiff` in O(n²). Prefer this entry point for strategy selection.
   */
  setValueAuto,
} as const;
