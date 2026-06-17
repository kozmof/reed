/**
 * Position namespace — branded position type constructors, arithmetic, comparison, and constants.
 */

import {
  byteOffset,
  byteLength,
  charOffset,
  lineNumber,
  columnNumber,
  isValidOffset,
  isValidLineNumber,
  addByteOffset,
  diffByteOffset,
  addCharOffset,
  diffCharOffset,
  nextLine,
  prevLine,
  compareByteOffsets,
  compareCharOffsets,
  clampByteOffset,
  clampCharOffset,
  ZERO_BYTE_OFFSET,
  ZERO_BYTE_LENGTH,
  ZERO_CHAR_OFFSET,
  LINE_ZERO,
  COLUMN_ZERO,
  rawByteOffset,
  rawCharOffset,
} from "../types/branded.js";
import { charOffsetsToSelection } from "../store/features/rendering.js";
import type { DocumentState, SelectionRange } from "../types/state.js";
import type { LinearCost } from "../types/cost-doc.js";

/**
 * Build a `SelectionRange` (byte offsets) from character (UTF-16 code unit) offsets.
 *
 * `SET_SELECTION` accepts byte-offset `SelectionRange[]`, which is easy to confuse
 * with char offsets. Use this factory when constructing a selection from user-visible
 * cursor positions — it performs the char→byte conversion for you.
 *
 * @param charAnchor - Anchor char offset (where the selection started)
 * @param charHead   - Head char offset (cursor position / end of selection)
 * @param state      - Current document state (used for char→byte conversion)
 * @returns A `SelectionRange` using byte offsets, suitable for `SET_SELECTION`
 *
 * @complexity O(log n + line_length) per offset
 */
function selectionRange(
  charAnchor: number,
  charHead: number,
  state: DocumentState,
): LinearCost<SelectionRange> {
  return charOffsetsToSelection(state, {
    anchor: charOffset(charAnchor),
    head: charOffset(charHead),
  });
}

export const position = {
  // Constructors
  byteOffset,
  byteLength,
  charOffset,
  lineNumber,
  columnNumber,

  // Validators
  isValidOffset,
  isValidLineNumber,

  // Arithmetic
  addByteOffset,
  diffByteOffset,
  addCharOffset,
  diffCharOffset,

  // Navigation
  nextLine,
  prevLine,

  // Comparison
  compareByteOffsets,
  compareCharOffsets,
  clampByteOffset,
  clampCharOffset,

  // Constants
  ZERO_BYTE_OFFSET,
  ZERO_BYTE_LENGTH,
  ZERO_CHAR_OFFSET,
  LINE_ZERO,
  COLUMN_ZERO,

  // Extraction
  rawByteOffset,
  rawCharOffset,

  // Selection factory
  /** Build a byte-offset SelectionRange from char offsets. Use with SET_SELECTION. */
  selectionRange,
} as const;
