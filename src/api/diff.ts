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
} from '../store/features/diff.ts';

export const diff = {
  diff: diffAlgorithm,
  computeSetValueActions,
  computeSetValueActionsOptimized,
  computeSetValueActionsFromState,
  computeSetValueActionsFromStateWithDiff,
  setValue,
  setValueWithDiff,
} as const;
