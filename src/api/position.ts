/** The position namespace constructs, compares, and calculates branded positions. */

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

/**
 * Build a byte-offset `SelectionRange` from UTF-16 code unit offsets.
 *
 * `SET_SELECTION` accepts byte offsets. Use this factory when cursor positions
 * are measured in UTF-16 code units.
 *
 * @param charAnchor - UTF-16 offset where the selection started
 * @param charHead   - UTF-16 offset of the cursor or selection end
 * @param state      - Document state used to convert UTF-16 offsets to bytes
 * @returns A `SelectionRange` using byte offsets, suitable for `SET_SELECTION`
 *
 * @complexity O(log n + line_length) per offset
 */
function selectionRange(
  charAnchor: number,
  charHead: number,
  state: DocumentState,
): SelectionRange {
  // The explicit return type hides the internal cost brand from callers.
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
