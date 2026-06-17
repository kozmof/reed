/**
 * Cost namespace — cost algebra for annotating and verifying algorithmic complexity.
 */

import {
  $declare,
  $prove,
  $proveCtx,
  $checked,
  $constCostFn,
  $logCostFn,
  $linearCostFn,
  $nlognCostFn,
  $quadCostFn,
  $from,
  $lift,
  $pipe,
  $andThen,
  $map,
  $zipCtx,
  $binarySearch,
  $linearScan,
  $forEachN,
  $mapN,
  $value,
} from "../types/cost-doc.js";

export const cost = {
  $declare,
  $prove,
  $proveCtx,
  $checked,
  $constCostFn,
  $logCostFn,
  $linearCostFn,
  $nlognCostFn,
  $quadCostFn,
  $from,
  $lift,
  $pipe,
  $andThen,
  $map,
  $zipCtx,
  $binarySearch,
  $linearScan,
  $forEachN,
  $mapN,
  /** Extract the plain value from a cost-branded result. Identity at runtime. */
  $value,
} as const;
