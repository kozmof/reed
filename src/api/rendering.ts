/**
 * Rendering namespace — viewport calculations, line content retrieval, and position conversion.
 */

import {
  getVisibleLineRange,
  getVisibleLines,
  getVisibleLine,
  getLineContent,
  estimateLineHeight,
  estimateTotalHeight,
  positionToLineColumn,
  lineColumnToPosition,
  selectionToCharOffsets,
  charOffsetsToSelection,
} from '../store/features/rendering.ts';

export const rendering = {
  getVisibleLineRange,
  getVisibleLines,
  getVisibleLine,
  getLineContent,
  estimateLineHeight,
  estimateTotalHeight,
  positionToLineColumn,
  lineColumnToPosition,
  selectionToCharOffsets,
  charOffsetsToSelection,
} as const;
