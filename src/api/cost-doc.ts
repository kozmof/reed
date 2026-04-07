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
} from '../types/cost-doc.ts';

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
} as const;
