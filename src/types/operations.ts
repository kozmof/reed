/**
 * Operational parameter types for Reed document editor functions.
 * These are callback/context shapes passed to line-index and reducer functions,
 * not persistent state structures.
 */

import type { ByteOffset } from "./branded.ts";

/**
 * Callback to read text from the piece table.
 * Used by line index operations to compute char lengths during line splits.
 */
export type ReadTextFn = (start: ByteOffset, end: ByteOffset) => string;

/**
 * Optional context around a delete range for accurate mixed line-ending handling.
 * Needed for partial CRLF edits (deleting only '\r' or only '\n').
 */
export interface DeleteBoundaryContext {
  prevChar?: string;
  nextChar?: string;
}
