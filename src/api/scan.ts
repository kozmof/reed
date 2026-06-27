/**
 * Scan namespace — O(n) operations.
 *
 * Every function here walks the full document (or a large portion of it).
 * **Do not call `scan.*` inside a hot rendering loop or on every keystroke.**
 * Hot paths — line lookups, cursor positioning, range reads — belong in
 * `query.*`, which provides O(1) and tree-height-bounded alternatives backed by the
 * piece-tree and line-index prefix sums.
 *
 * Appropriate uses of `scan.*`:
 * - One-time export / serialisation of the whole document
 * - Background analysis (spell-check, word-count, diff)
 * - Test assertions that need the complete document string
 *
 * @see query — O(1) and tree-height-bounded read operations
 */

import { $uncostedFn } from "../types/cost-doc.js";
import { getValue, getValueStream, collectPieces } from "../store/core/piece-table.js";
import { collectLines, rebuildLineIndex } from "../store/core/line-index.js";
import type { ScanApi } from "./interfaces.js";

export const scan: ScanApi = {
  /** @complexity O(n) — collects all pieces into a single string */
  getValue: $uncostedFn(getValue),
  /** @complexity O(n) — streaming variant, yields chunks */
  getValueStream,
  /** @complexity O(n) — in-order tree walk of all piece nodes */
  collectPieces: $uncostedFn(collectPieces),
  /** @complexity O(n) — in-order tree walk of all line nodes */
  collectLines: $uncostedFn(collectLines),
  /** @complexity O(n) — full rebuild of line index from content */
  rebuildLineIndex: $uncostedFn(rebuildLineIndex),
};
