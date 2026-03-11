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
} from '../types/branded.ts';

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
} as const;
