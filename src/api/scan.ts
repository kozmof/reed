/**
 * Scan namespace — O(n) operations.
 *
 * Every function here walks the full document (or a large portion of it).
 * **Do not call `scan.*` inside a hot rendering loop or on every keystroke.**
 * Use `query.*` for line lookups, cursor positioning, and bounded range reads.
 * Its selectors use cached values and tree prefix sums. Range reads also depend
 * on the amount of text returned.
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
