/**
 * Query namespace — O(log n) and O(1) operations.
 * All functions in this namespace use tree-based lookups and never scan the full document.
 */

import {
  getText,
  getLength,
  findPieceAtPosition,
  getBufferStats,
} from '../store/core/piece-table.ts';
import {
  findLineAtPosition,
  getLineRange,
  getLineRangePrecise,
  getLineCountFromIndex,
  getCharStartOffset,
  findLineAtCharPosition,
} from '../store/core/line-index.ts';
import {
  getLineContent,
  getVisibleLine,
  getVisibleLines,
  positionToLineColumn,
  lineColumnToPosition,
} from '../store/features/rendering.ts';

export const query = {
  /** @complexity O(log n + m) — tree traversal to collect byte range */
  getText,
  /** @complexity O(1) — cached totalLength on piece table state */
  getLength,
  /** @complexity O(1) — cached on piece table state */
  getBufferStats,
  /** @complexity O(log n) — tree walk to find piece at position */
  findPieceAtPosition,
  /** @complexity O(log n) — tree walk to find line at byte position */
  findLineAtPosition,
  /** @complexity O(log n) — tree walk; requires eager state */
  getLineRange,
  /** @complexity O(log n) — tree walk with dirty-range delta correction */
  getLineRangePrecise,
  /** @complexity O(1) — cached lineCount */
  getLineCount: getLineCountFromIndex,
  /** @complexity O(log n) — prefix sum via subtreeCharLength */
  getCharStartOffset,
  /** @complexity O(log n) — tree descent via subtreeCharLength */
  findLineAtCharPosition,
  /** @complexity O(log n) — line lookup + text extraction */
  getLineContent,
  /** @complexity O(log n) — single line lookup and text extraction */
  getVisibleLine,
  /** @complexity O(k * log n) — k line lookups for visible range */
  getVisibleLines,
  /** @complexity O(log n) — byte position to line/column */
  positionToLineColumn,
  /** @complexity O(log n) — line/column to byte position */
  lineColumnToPosition,
} as const;
