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
} from "../store/features/rendering.js";
import { $uncostedFn } from "../types/cost-doc.js";
import type { RenderingApi } from "./interfaces.js";

export const rendering: RenderingApi = {
  /** @complexity O(1) */
  getVisibleLineRange: $uncostedFn(getVisibleLineRange),
  /** @complexity O(n) over the returned viewport lines */
  getVisibleLines: $uncostedFn(getVisibleLines),
  /** @complexity O(n) over the requested line content */
  getVisibleLine: $uncostedFn(getVisibleLine),
  /** @complexity O(n) over the requested line content */
  getLineContent: $uncostedFn(getLineContent),
  /** @complexity O(1) */
  estimateLineHeight: $uncostedFn(estimateLineHeight),
  /** @complexity O(n) over document lines */
  estimateTotalHeight: $uncostedFn(estimateTotalHeight),
  /** @complexity O(log n + line length) */
  positionToLineColumn: $uncostedFn(positionToLineColumn),
  /** @complexity O(log n + line length) */
  lineColumnToPosition: $uncostedFn(lineColumnToPosition),
  /** @complexity O(log n + line length) per offset */
  selectionToCharOffsets: $uncostedFn(selectionToCharOffsets),
  /** @complexity O(log n + line length) per offset */
  charOffsetsToSelection: $uncostedFn(charOffsetsToSelection),
};
