/**
 * Myers diff algorithm implementation for computing minimal edit scripts.
 * Used for efficient bulk text replacement via setValue.
 *
 * Reference: "An O(ND) Difference Algorithm and Its Variations" by Eugene W. Myers
 * http://www.xmailserver.org/diff2.pdf
 */

import type { DocumentAction } from '../types/actions.ts';
import { byteOffset } from '../types/branded.ts';
import { DocumentActions } from './actions.ts';
import { textEncoder } from './encoding.ts';

// =============================================================================
// Types
// =============================================================================

/**
 * A single edit operation in the diff.
 */
export interface DiffEdit {
  /** Type of edit */
  type: 'insert' | 'delete' | 'equal';
  /** Text involved in this edit */
  text: string;
  /** Position in the old text (for delete/equal) */
  oldPos: number;
  /** Position in the new text (for insert/equal) */
  newPos: number;
}

/**
 * Result of a diff operation.
 */
export interface DiffResult {
  /** The sequence of edits */
  edits: DiffEdit[];
  /** Number of changes (inserts + deletes) */
  distance: number;
}

// =============================================================================
// Myers Diff Algorithm
// =============================================================================

/**
 * Compute the diff between two strings using Myers algorithm.
 * Returns the minimal edit script to transform `oldText` into `newText`.
 */
export function diff(oldText: string, newText: string): DiffResult {
  // Handle trivial cases
  if (oldText === newText) {
    return {
      edits: oldText.length > 0 ? [{ type: 'equal', text: oldText, oldPos: 0, newPos: 0 }] : [],
      distance: 0,
    };
  }

  if (oldText.length === 0) {
    return {
      edits: [{ type: 'insert', text: newText, oldPos: 0, newPos: 0 }],
      distance: newText.length,
    };
  }

  if (newText.length === 0) {
    return {
      edits: [{ type: 'delete', text: oldText, oldPos: 0, newPos: 0 }],
      distance: oldText.length,
    };
  }

  // Find common prefix
  let prefixLen = 0;
  while (prefixLen < oldText.length && prefixLen < newText.length &&
         oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (but don't overlap with prefix)
  let suffixLen = 0;
  while (suffixLen < oldText.length - prefixLen &&
         suffixLen < newText.length - prefixLen &&
         oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]) {
    suffixLen++;
  }

  // Extract the parts that actually differ
  const oldMiddle = oldText.slice(prefixLen, oldText.length - suffixLen);
  const newMiddle = newText.slice(prefixLen, newText.length - suffixLen);

  // Compute diff on the middle part
  const middleEdits = myersDiff(oldMiddle, newMiddle, prefixLen, prefixLen);

  // Build the complete edit list
  const edits: DiffEdit[] = [];

  // Add prefix as equal
  if (prefixLen > 0) {
    edits.push({
      type: 'equal',
      text: oldText.slice(0, prefixLen),
      oldPos: 0,
      newPos: 0,
    });
  }

  // Add middle edits
  edits.push(...middleEdits);

  // Add suffix as equal
  if (suffixLen > 0) {
    edits.push({
      type: 'equal',
      text: oldText.slice(oldText.length - suffixLen),
      oldPos: oldText.length - suffixLen,
      newPos: newText.length - suffixLen,
    });
  }

  // Calculate distance
  let distance = 0;
  for (const edit of edits) {
    if (edit.type !== 'equal') {
      distance += edit.text.length;
    }
  }

  return { edits, distance };
}

/**
 * Core Myers diff algorithm.
 * Returns edits for transforming oldText into newText.
 */
function myersDiff(
  oldText: string,
  newText: string,
  oldOffset: number,
  newOffset: number
): DiffEdit[] {
  const n = oldText.length;
  const m = newText.length;

  if (n === 0 && m === 0) {
    return [];
  }

  if (n === 0) {
    return [{ type: 'insert', text: newText, oldPos: oldOffset, newPos: newOffset }];
  }

  if (m === 0) {
    return [{ type: 'delete', text: oldText, oldPos: oldOffset, newPos: newOffset }];
  }

  // For small strings, use simple DP approach (threshold: n*m < 10000 cells)
  if (n * m < 10000) {
    return simpleDiff(oldText, newText, oldOffset, newOffset);
  }

  // Myers algorithm
  const max = n + m;
  const vSize = 2 * max + 1;
  const v = new Int32Array(vSize);
  const trace: Int32Array[] = [];

  // Forward phase - find the path
  for (let d = 0; d <= max; d++) {
    trace.push(new Int32Array(v));

    for (let k = -d; k <= d; k += 2) {
      const kIndex = k + max;

      let x: number;
      if (k === -d || (k !== d && v[kIndex - 1] < v[kIndex + 1])) {
        x = v[kIndex + 1]; // Move down
      } else {
        x = v[kIndex - 1] + 1; // Move right
      }

      let y = x - k;

      // Follow diagonal (matching characters)
      while (x < n && y < m && oldText[x] === newText[y]) {
        x++;
        y++;
      }

      v[kIndex] = x;

      // Check if we've reached the end
      if (x >= n && y >= m) {
        return backtrack(trace, oldText, newText, oldOffset, newOffset, d, max);
      }
    }
  }

  // Should not reach here
  return simpleDiff(oldText, newText, oldOffset, newOffset);
}

/**
 * Backtrack through the trace to build the edit list.
 */
function backtrack(
  trace: Int32Array[],
  oldText: string,
  newText: string,
  oldOffset: number,
  newOffset: number,
  d: number,
  max: number
): DiffEdit[] {
  const edits: DiffEdit[] = [];
  let x = oldText.length;
  let y = newText.length;

  for (let i = d; i > 0; i--) {
    const vPrev = trace[i - 1];
    const k = x - y;
    const kIndex = k + max;

    let prevK: number;
    if (k === -i || (k !== i && vPrev[kIndex - 1] < vPrev[kIndex + 1])) {
      prevK = k + 1; // Came from above (insert)
    } else {
      prevK = k - 1; // Came from left (delete)
    }

    const prevX = vPrev[prevK + max];
    const prevY = prevX - prevK;

    // Add diagonal (equal) moves
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }

    if (i > 0) {
      if (x === prevX) {
        // Insert
        edits.unshift({
          type: 'insert',
          text: newText[y - 1],
          oldPos: oldOffset + x,
          newPos: newOffset + y - 1,
        });
        y--;
      } else {
        // Delete
        edits.unshift({
          type: 'delete',
          text: oldText[x - 1],
          oldPos: oldOffset + x - 1,
          newPos: newOffset + y,
        });
        x--;
      }
    }
  }

  // Consolidate consecutive edits of the same type
  return consolidateEdits(edits);
}

/**
 * Simple diff for small strings - easier to understand and debug.
 */
function simpleDiff(
  oldText: string,
  newText: string,
  oldOffset: number,
  newOffset: number
): DiffEdit[] {
  // Use dynamic programming LCS approach with flat typed array
  const n = oldText.length;
  const m = newText.length;
  const cols = m + 1;

  // Flat Int32Array: dp[i][j] accessed as dp[i * cols + j], zero-initialized
  const dp = new Int32Array((n + 1) * cols);

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldText[i - 1] === newText[j - 1]) {
        dp[i * cols + j] = dp[(i - 1) * cols + (j - 1)] + 1;
      } else {
        dp[i * cols + j] = Math.max(dp[(i - 1) * cols + j], dp[i * cols + (j - 1)]);
      }
    }
  }

  // Backtrack to find edits
  const edits: DiffEdit[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldText[i - 1] === newText[j - 1]) {
      edits.unshift({
        type: 'equal',
        text: oldText[i - 1],
        oldPos: oldOffset + i - 1,
        newPos: newOffset + j - 1,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i * cols + (j - 1)] >= dp[(i - 1) * cols + j])) {
      edits.unshift({
        type: 'insert',
        text: newText[j - 1],
        oldPos: oldOffset + i,
        newPos: newOffset + j - 1,
      });
      j--;
    } else {
      edits.unshift({
        type: 'delete',
        text: oldText[i - 1],
        oldPos: oldOffset + i - 1,
        newPos: newOffset + j,
      });
      i--;
    }
  }

  return consolidateEdits(edits);
}

/**
 * Consolidate consecutive edits of the same type.
 */
function consolidateEdits(edits: DiffEdit[]): DiffEdit[] {
  if (edits.length === 0) return [];

  const result: DiffEdit[] = [];
  let current = { ...edits[0] };

  for (let i = 1; i < edits.length; i++) {
    const edit = edits[i];

    if (edit.type === current.type) {
      // Merge with current
      current.text += edit.text;
    } else {
      // Push current and start new
      result.push(current);
      current = { ...edit };
    }
  }

  result.push(current);
  return result;
}

// =============================================================================
// Document Actions from Diff
// =============================================================================

/**
 * Compute the document actions needed to transform old content to new content.
 * Returns an array of actions that can be dispatched to the store.
 *
 * @param oldContent - The current document content
 * @param newContent - The desired new content
 * @returns Array of DocumentActions to apply
 */
export function computeSetValueActions(
  oldContent: string,
  newContent: string
): DocumentAction[] {
  if (oldContent === newContent) {
    return [];
  }

  const diffResult = diff(oldContent, newContent);
  const actions: DocumentAction[] = [];

  // Convert diff edits to document actions
  // We need to process in reverse order for deletes to maintain correct positions
  // Or we need to track position offsets

  // First pass: collect all operations with their positions
  interface PendingOp {
    type: 'insert' | 'delete';
    position: number;  // String position in original
    text: string;
  }

  const ops: PendingOp[] = [];

  for (const edit of diffResult.edits) {
    if (edit.type === 'delete') {
      ops.push({
        type: 'delete',
        position: edit.oldPos,
        text: edit.text,
      });
    } else if (edit.type === 'insert') {
      ops.push({
        type: 'insert',
        position: edit.oldPos,
        text: edit.text,
      });
    }
  }

  // Process operations, adjusting positions as we go
  // We need to track both string offset and byte offset
  let stringOffset = 0;
  let byteOffsetDelta = 0;

  for (const op of ops) {
    // Convert string position to byte position
    const bytePos = stringIndexToByteIndex(oldContent, op.position) + byteOffsetDelta;

    if (op.type === 'delete') {
      const deleteByteLen = textEncoder.encode(op.text).length;
      actions.push(DocumentActions.delete(byteOffset(bytePos), byteOffset(bytePos + deleteByteLen)));
      stringOffset -= op.text.length;
      byteOffsetDelta -= deleteByteLen;
    } else if (op.type === 'insert') {
      actions.push(DocumentActions.insert(byteOffset(bytePos), op.text));
      stringOffset += op.text.length;
      byteOffsetDelta += textEncoder.encode(op.text).length;
    }
  }

  return actions;
}

/**
 * Convert a string index to a byte index.
 * This is needed because the piece table works with bytes, not characters.
 */
function stringIndexToByteIndex(str: string, index: number): number {
  return textEncoder.encode(str.slice(0, index)).length;
}

/**
 * Check if a character code is a low surrogate (second half of surrogate pair).
 */
function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}

/**
 * Check if a character code is a high surrogate (first half of surrogate pair).
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF;
}

/**
 * Compute actions using REPLACE operations where possible.
 * This can be more efficient for contiguous changes.
 */
export function computeSetValueActionsOptimized(
  oldContent: string,
  newContent: string
): DocumentAction[] {
  if (oldContent === newContent) {
    return [];
  }

  // Find the differing region (in string indices)
  let start = 0;
  while (start < oldContent.length && start < newContent.length &&
         oldContent[start] === newContent[start]) {
    start++;
  }

  // Don't split surrogate pairs - if we stopped at a low surrogate, back up
  if (start > 0 && isLowSurrogate(oldContent.charCodeAt(start))) {
    start--;
  }

  let oldEnd = oldContent.length;
  let newEnd = newContent.length;
  while (oldEnd > start && newEnd > start &&
         oldContent[oldEnd - 1] === newContent[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  // Don't split surrogate pairs at the end either
  if (oldEnd < oldContent.length && isHighSurrogate(oldContent.charCodeAt(oldEnd - 1))) {
    oldEnd++;
  }
  if (newEnd < newContent.length && isHighSurrogate(newContent.charCodeAt(newEnd - 1))) {
    newEnd++;
  }

  // Now we have the range that differs
  const deletedText = oldContent.slice(start, oldEnd);
  const insertedText = newContent.slice(start, newEnd);

  if (deletedText.length === 0 && insertedText.length === 0) {
    return [];
  }

  // Convert string indices to byte indices for the piece table
  const byteStart = byteOffset(stringIndexToByteIndex(oldContent, start));
  const byteOldEnd = byteOffset(stringIndexToByteIndex(oldContent, oldEnd));

  if (deletedText.length === 0) {
    // Pure insert
    return [DocumentActions.insert(byteStart, insertedText)];
  }

  if (insertedText.length === 0) {
    // Pure delete
    return [DocumentActions.delete(byteStart, byteOldEnd)];
  }

  // Replace
  return [DocumentActions.replace(byteStart, byteOldEnd, insertedText)];
}

// =============================================================================
// High-level setValue function
// =============================================================================

import type { DocumentState, PieceTableState } from '../types/state.ts';
import { documentReducer } from './reducer.ts';
import { getValue } from './piece-table.ts';

/**
 * Options for setValue operation.
 */
export interface SetValueOptions {
  /** Use optimized single REPLACE action instead of minimal diff */
  useReplace?: boolean;
  /** Wrap all changes in a transaction (single undo unit) */
  asTransaction?: boolean;
}

/**
 * Set the entire document value to new content.
 * Uses diff to compute minimal changes and applies them.
 *
 * @param state - Current document state
 * @param newContent - The new content to set
 * @param options - Options for the operation
 * @returns New document state with the content changed
 */
export function setValue(
  state: DocumentState,
  newContent: string,
  options: SetValueOptions = {}
): DocumentState {
  const { useReplace = true, asTransaction = true } = options;

  // Get current content
  const oldContent = getValue(state.pieceTable);

  if (oldContent === newContent) {
    return state;
  }

  // Compute actions
  const actions = useReplace
    ? computeSetValueActionsOptimized(oldContent, newContent)
    : computeSetValueActions(oldContent, newContent);

  if (actions.length === 0) {
    return state;
  }

  // Apply actions
  let newState = state;

  if (asTransaction && actions.length > 1) {
    // Wrap in transaction for single undo
    newState = documentReducer(newState, DocumentActions.transactionStart());
  }

  for (const action of actions) {
    newState = documentReducer(newState, action);
  }

  if (asTransaction && actions.length > 1) {
    newState = documentReducer(newState, DocumentActions.transactionCommit());
  }

  return newState;
}

/**
 * Set value on a piece table state directly.
 * Returns the actions that would be applied.
 */
export function computeSetValueActionsFromState(
  pieceTable: PieceTableState,
  newContent: string,
  useReplace: boolean = true
): DocumentAction[] {
  const oldContent = getValue(pieceTable);

  if (oldContent === newContent) {
    return [];
  }

  return useReplace
    ? computeSetValueActionsOptimized(oldContent, newContent)
    : computeSetValueActions(oldContent, newContent);
}
