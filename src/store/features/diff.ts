/**
 * Backward-compatible diff surface. Pure text differencing and document-state
 * application live in separate modules so each can evolve independently.
 */
export { diff, computeSetValueActions, computeSetValueActionsOptimized } from "./text-diff.js";
export type { DiffEdit, DiffResult } from "./text-diff.js";

export {
  setValue,
  setValueAuto,
  setValueWithDiff,
  computeSetValueActionsFromState,
  computeSetValueActionsFromStateWithDiff,
} from "./set-value.js";
export type { SetValueOptions } from "./set-value.js";
