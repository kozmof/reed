/**
 * Diff namespace — text diff algorithm and setValue operations.
 */

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
  /** O(n) — single REPLACE operation. Best for interactive edits. */
  setValue,
  /** O(n²) — memory-bounded Myers script. Use when finer history matters. */
  setValueWithDiff,
  /**
   * Unified entry point: routes to `setValue` (default, O(n)) or `setValueWithDiff`
   * (O(n²)) via `options.strategy`. Prefer this over calling the two variants directly.
   */
  setValueAuto,
} as const;
