/**
 * Scan namespace — O(n) operations.
 * All functions in this namespace perform full or partial document traversals.
 * Use `query.*` for efficient lookups when possible.
 */

import {
  getValue,
  getValueStream,
  collectPieces,
} from '../store/core/piece-table.ts';
import {
  collectLines,
  rebuildLineIndex,
} from '../store/core/line-index.ts';

export const scan = {
  /** @complexity O(n) — collects all pieces into a single string */
  getValue,
  /** @complexity O(n) — streaming variant, yields chunks */
  getValueStream,
  /** @complexity O(n) — in-order tree walk of all piece nodes */
  collectPieces,
  /** @complexity O(n) — in-order tree walk of all line nodes */
  collectLines,
  /** @complexity O(n) — full rebuild of line index from content */
  rebuildLineIndex,
} as const;
