/**
 * Memory-bounded Myers diff implementation for bulk text replacement.
 * Produces a minimal edit script while its trace fits the configured budget,
 * then safely falls back to a coarse replacement.
 *
 * Reference: "An O(ND) Difference Algorithm and Its Variations" by Eugene W. Myers
 * http://www.xmailserver.org/diff2.pdf
 */

import type { DocumentAction } from "../../types/actions.js";
import { byteOffset } from "../../types/branded.js";
import { DocumentActions } from "./actions.js";
import { textEncoder } from "../core/encoding.js";
import { charToByteOffset } from "../core/piece-table-offset-convert.js";
import { $beginCost, $proveCtx, type LinearCost, type QuadCost } from "../../types/cost-doc.js";

// =============================================================================
// Types
// =============================================================================

/**
 * A single edit operation in the diff.
 */
export interface DiffEdit {
  /** Type of edit */
  type: "insert" | "delete" | "equal";
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
 * Hard ceiling for the Myers frontier plus its backtracking snapshots.
 *
 * Myers is fast for nearby texts, but retaining every frontier is O((N + M)D)
 * memory and becomes unsafe for large, unrelated inputs. Once this budget is
 * exhausted we return a correct coarse replacement instead of risking process
 * termination. The fast setValue path is unaffected.
 */
const MAX_MYERS_MEMORY_BYTES = 16 * 1024 * 1024;

/**
 * Compute the diff between two strings using Myers algorithm.
 * Returns a minimal edit script when it fits the memory budget, otherwise a
 * correct coarse replacement.
 */
export function diff(oldText: string, newText: string): QuadCost<DiffResult> {
  // Handle trivial cases
  if (oldText === newText) {
    return $proveCtx($beginCost("O(n^2)"), {
      edits: oldText.length > 0 ? [{ type: "equal", text: oldText, oldPos: 0, newPos: 0 }] : [],
      distance: 0,
    } satisfies DiffResult);
  }

  if (oldText.length === 0) {
    return $proveCtx($beginCost("O(n^2)"), {
      edits: [{ type: "insert", text: newText, oldPos: 0, newPos: 0 }],
      distance: newText.length,
    } satisfies DiffResult);
  }

  if (newText.length === 0) {
    return $proveCtx($beginCost("O(n^2)"), {
      edits: [{ type: "delete", text: oldText, oldPos: 0, newPos: 0 }],
      distance: oldText.length,
    } satisfies DiffResult);
  }

  // Find common prefix
  let prefixLen = 0;
  while (
    prefixLen < oldText.length &&
    prefixLen < newText.length &&
    oldText[prefixLen] === newText[prefixLen]
  ) {
    prefixLen++;
  }

  // Find common suffix (but don't overlap with prefix)
  let suffixLen = 0;
  while (
    suffixLen < oldText.length - prefixLen &&
    suffixLen < newText.length - prefixLen &&
    oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
  ) {
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
      type: "equal",
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
      type: "equal",
      text: oldText.slice(oldText.length - suffixLen),
      oldPos: oldText.length - suffixLen,
      newPos: newText.length - suffixLen,
    });
  }

  // Calculate distance
  let distance = 0;
  for (const edit of edits) {
    if (edit.type !== "equal") {
      distance += edit.text.length;
    }
  }

  return $proveCtx($beginCost("O(n^2)"), { edits, distance });
}

/**
 * Core Myers diff algorithm.
 * Returns edits for transforming oldText into newText.
 */
function myersDiff(
  oldText: string,
  newText: string,
  oldOffset: number,
  newOffset: number,
): DiffEdit[] {
  const n = oldText.length;
  const m = newText.length;

  if (n === 0 && m === 0) {
    return [];
  }

  if (n === 0) {
    return [{ type: "insert", text: newText, oldPos: oldOffset, newPos: newOffset }];
  }

  if (m === 0) {
    return [{ type: "delete", text: oldText, oldPos: oldOffset, newPos: newOffset }];
  }

  // For small strings, use simple DP approach (threshold: n*m < 10000 cells)
  if (n * m < 10000) {
    return simpleDiff(oldText, newText, oldOffset, newOffset);
  }

  // Myers algorithm
  const max = n + m;
  const vSize = 2 * max + 1;
  const frontierBytes = vSize * Int32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(frontierBytes) || frontierBytes > MAX_MYERS_MEMORY_BYTES) {
    return coarseReplacement(oldText, newText, oldOffset, newOffset);
  }

  const v = new Int32Array(vSize);
  const trace: Int32Array[] = [];
  let allocatedBytes = frontierBytes;

  // Forward phase - find the path
  for (let d = 0; d <= max; d++) {
    if (allocatedBytes + frontierBytes > MAX_MYERS_MEMORY_BYTES) {
      return coarseReplacement(oldText, newText, oldOffset, newOffset);
    }
    trace.push(v.slice());
    allocatedBytes += frontierBytes;

    for (let k = -d; k <= d; k += 2) {
      const kIndex = k + max;

      let x: number;
      if (k === -d || (k !== d && v[kIndex - 1]! < v[kIndex + 1]!)) {
        x = v[kIndex + 1]!; // Move down
      } else {
        x = v[kIndex - 1]! + 1; // Move right
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

  // Defensive fallback: the edit graph should always reach (n, m).
  return coarseReplacement(oldText, newText, oldOffset, newOffset);
}

/**
 * Return a correct, non-minimal replacement when retaining a minimal Myers
 * trace would exceed the memory budget.
 */
function coarseReplacement(
  oldText: string,
  newText: string,
  oldOffset: number,
  newOffset: number,
): DiffEdit[] {
  return [
    { type: "delete", text: oldText, oldPos: oldOffset, newPos: newOffset },
    {
      type: "insert",
      text: newText,
      // computeSetValueActions applies edits sequentially. Positioning the
      // insert after the deleted old span makes its adjusted byte offset equal
      // the start of that span.
      oldPos: oldOffset + oldText.length,
      newPos: newOffset,
    },
  ];
}

/**
 * Backtrack through the trace to build the edit list.
 */
function backtrack(
  trace: readonly Int32Array[],
  oldText: string,
  newText: string,
  oldOffset: number,
  newOffset: number,
  d: number,
  max: number,
): DiffEdit[] {
  const edits: DiffEdit[] = [];
  let x = oldText.length;
  let y = newText.length;

  for (let i = d; i > 0; i--) {
    const vPrev = trace[i - 1]!;
    const k = x - y;
    const kIndex = k + max;

    let prevK: number;
    if (k === -i || (k !== i && vPrev[kIndex - 1]! < vPrev[kIndex + 1]!)) {
      prevK = k + 1; // Came from above (insert)
    } else {
      prevK = k - 1; // Came from left (delete)
    }

    const prevX = vPrev[prevK + max]!;
    const prevY = prevX - prevK;

    // Add diagonal (equal) moves
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }

    if (i > 0) {
      if (x === prevX) {
        // Insert
        edits.push({
          type: "insert",
          text: newText[y - 1]!,
          oldPos: oldOffset + x,
          newPos: newOffset + y - 1,
        });
        y--;
      } else {
        // Delete
        edits.push({
          type: "delete",
          text: oldText[x - 1]!,
          oldPos: oldOffset + x - 1,
          newPos: newOffset + y,
        });
        x--;
      }
    }
  }

  // Backtracking walks root→leaf, so edits are in reverse document order — reverse before consolidating.
  edits.reverse();
  return consolidateEdits(edits);
}

/**
 * Simple diff for small strings - easier to understand and debug.
 */
function simpleDiff(
  oldText: string,
  newText: string,
  oldOffset: number,
  newOffset: number,
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
        dp[i * cols + j] = dp[(i - 1) * cols + (j - 1)]! + 1;
      } else {
        dp[i * cols + j] = Math.max(dp[(i - 1) * cols + j]!, dp[i * cols + (j - 1)]!);
      }
    }
  }

  // Backtrack, accumulating consecutive same-type characters into runs to avoid a separate pass.
  const edits: DiffEdit[] = [];
  let i = n;
  let j = m;
  let runType: DiffEdit["type"] | null = null;
  let runText = "";
  let runOldPos = 0;
  let runNewPos = 0;

  function flushRun() {
    if (runType !== null) {
      edits.push({ type: runType, text: runText, oldPos: runOldPos, newPos: runNewPos });
      runType = null;
      runText = "";
    }
  }

  while (i > 0 || j > 0) {
    let type: DiffEdit["type"];
    let char: string;
    let oldPos: number;
    let newPos: number;

    if (i > 0 && j > 0 && oldText[i - 1] === newText[j - 1]) {
      type = "equal";
      char = oldText[i - 1]!;
      oldPos = oldOffset + i - 1;
      newPos = newOffset + j - 1;
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i * cols + (j - 1)]! >= dp[(i - 1) * cols + j]!)) {
      type = "insert";
      char = newText[j - 1]!;
      oldPos = oldOffset + i;
      newPos = newOffset + j - 1;
      j--;
    } else {
      type = "delete";
      char = oldText[i - 1]!;
      oldPos = oldOffset + i - 1;
      newPos = newOffset + j;
      i--;
    }

    if (type === runType) {
      // Prepend to accumulate in forward document order (backtrack walks end→start).
      runText = char + runText;
      runOldPos = oldPos;
      runNewPos = newPos;
    } else {
      flushRun();
      runType = type;
      runText = char;
      runOldPos = oldPos;
      runNewPos = newPos;
    }
  }

  flushRun();
  // Backtracking walks from end→start, so runs are in reverse document order — reverse.
  edits.reverse();
  return edits;
}

/**
 * Consolidate consecutive edits of the same type.
 */
function consolidateEdits(edits: DiffEdit[]): DiffEdit[] {
  if (edits.length === 0) return [];

  const result: DiffEdit[] = [];
  let current = { ...edits[0]! };

  for (let i = 1; i < edits.length; i++) {
    const edit = edits[i]!;

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
  newContent: string,
): QuadCost<DocumentAction[]> {
  if (oldContent === newContent) {
    return $proveCtx($beginCost("O(n^2)"), []);
  }

  // Myers operates on JavaScript string indices (UTF-16 code units). A diff can
  // therefore align on only one half of a surrogate pair — for example 😀 and
  // 😂 share their high surrogate. Converting that interior code-unit boundary
  // to a UTF-8 byte offset would produce an edit in the middle of a four-byte
  // sequence and corrupt the document. The optimized single-range strategy
  // explicitly normalizes surrogate boundaries, so use it whenever either
  // input contains surrogate code units. This intentionally trades fine-grained
  // history for byte correctness on astral and malformed-surrogate input.
  if (containsSurrogateCodeUnit(oldContent) || containsSurrogateCodeUnit(newContent)) {
    return $proveCtx(
      $beginCost("O(n^2)"),
      computeSetValueActionsOptimized(oldContent, newContent) as DocumentAction[],
    );
  }

  const diffResult = diff(oldContent, newContent);
  const actions: DocumentAction[] = [];

  // Convert diff edits to document actions
  // We need to process in reverse order for deletes to maintain correct positions
  // Or we need to track position offsets

  // First pass: collect all operations with their positions
  interface PendingOp {
    type: "insert" | "delete";
    position: number; // String position in original
    text: string;
  }

  const ops: PendingOp[] = [];

  for (const edit of diffResult.edits) {
    if (edit.type === "delete") {
      ops.push({
        type: "delete",
        position: edit.oldPos,
        text: edit.text,
      });
    } else if (edit.type === "insert") {
      ops.push({
        type: "insert",
        position: edit.oldPos,
        text: edit.text,
      });
    }
  }

  // Build the char-to-byte offset map once (O(n)) to avoid repeated encode() allocations.
  const charToByteMap = buildCharToByteMap(oldContent);

  // Process operations, adjusting byte positions as earlier edits change the document.
  let byteOffsetDelta = 0;

  for (const op of ops) {
    // Convert string position to byte position using the pre-built map (O(1))
    const bytePos = charToByteMap[op.position]! + byteOffsetDelta;

    if (op.type === "delete") {
      const deleteByteLen = textEncoder.encode(op.text).length;
      actions.push(
        DocumentActions.delete(byteOffset(bytePos), byteOffset(bytePos + deleteByteLen)),
      );
      byteOffsetDelta -= deleteByteLen;
    } else if (op.type === "insert") {
      actions.push(DocumentActions.insert(byteOffset(bytePos), op.text));
      byteOffsetDelta += textEncoder.encode(op.text).length;
    }
  }

  return $proveCtx($beginCost("O(n^2)"), actions);
}

/**
 * Convert a single string index to a byte index.
 * Used by computeSetValueActionsOptimized which calls it at most twice per invocation.
 *
 * Goes through charToByteOffset rather than encoding a slice: slicing mid-surrogate-pair leaves
 * a lone high surrogate that TextEncoder turns into U+FFFD, which would put the result inside a
 * code point instead of on a boundary.
 */
function stringIndexToByteIndex(str: string, index: number): number {
  return charToByteOffset(str, index);
}

/**
 * Build a cumulative char-to-byte offset map in a single O(n) pass.
 * map[i] equals the UTF-8 byte length of str.slice(0, i), matching what
 * repeated textEncoder.encode(str.slice(0, i)).length calls would return.
 *
 * Surrogate-pair handling:
 *   - str.slice(0, highIndex+1) contains a lone high surrogate → U+FFFD → 3 bytes
 *   - str.slice(0, highIndex+2) contains the full pair → 4 bytes total (+1 over lone high)
 */
function buildCharToByteMap(str: string): number[] {
  const map = Array.from<number>({ length: str.length + 1 });
  map[0] = 0;
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate: lone slice encodes as U+FFFD (3 bytes)
      bytes += 3;
      map[i + 1] = bytes;
      const lo = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        // Full pair adds 1 byte over the lone-high-surrogate count (3 + 1 = 4 total)
        bytes += 1;
        i++;
      }
    } else {
      bytes += 3;
    }
    map[i + 1] = bytes;
  }
  return map;
}

/**
 * Check if a character code is a low surrogate (second half of surrogate pair).
 */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Check if a character code is a high surrogate (first half of surrogate pair).
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function containsSurrogateCodeUnit(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isHighSurrogate(code) || isLowSurrogate(code)) return true;
  }
  return false;
}

/**
 * Compute actions using REPLACE operations where possible.
 * This can be more efficient for contiguous changes.
 */
export function computeSetValueActionsOptimized(
  oldContent: string,
  newContent: string,
): LinearCost<DocumentAction[]> {
  if (oldContent === newContent) {
    return $proveCtx($beginCost("O(n)"), []);
  }

  // Find the differing region (in string indices)
  let start = 0;
  while (
    start < oldContent.length &&
    start < newContent.length &&
    oldContent[start] === newContent[start]
  ) {
    start++;
  }

  // Don't split surrogate pairs - if we stopped at a low surrogate that completes a pair, back
  // up. A lone low surrogate is already a character on its own, and backing up over it could land
  // inside the pair that precedes it.
  if (
    start > 0 &&
    isLowSurrogate(oldContent.charCodeAt(start)) &&
    isHighSurrogate(oldContent.charCodeAt(start - 1))
  ) {
    start--;
  }

  let oldEnd = oldContent.length;
  let newEnd = newContent.length;
  while (oldEnd > start && newEnd > start && oldContent[oldEnd - 1] === newContent[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  // Don't split surrogate pairs at the end either. Extend only when the high surrogate we
  // stopped after is actually paired with the code unit at the end index; a lone high surrogate is
  // its own character, and extending over it could land inside the pair that follows.
  if (
    oldEnd < oldContent.length &&
    isHighSurrogate(oldContent.charCodeAt(oldEnd - 1)) &&
    isLowSurrogate(oldContent.charCodeAt(oldEnd))
  ) {
    oldEnd++;
  }
  if (
    newEnd < newContent.length &&
    isHighSurrogate(newContent.charCodeAt(newEnd - 1)) &&
    isLowSurrogate(newContent.charCodeAt(newEnd))
  ) {
    newEnd++;
  }

  // Now we have the range that differs
  const deletedText = oldContent.slice(start, oldEnd);
  const insertedText = newContent.slice(start, newEnd);

  if (deletedText.length === 0 && insertedText.length === 0) {
    return $proveCtx($beginCost("O(n)"), []);
  }

  // Convert string indices to byte indices for the piece table
  const byteStart = byteOffset(stringIndexToByteIndex(oldContent, start));
  const byteOldEnd = byteOffset(stringIndexToByteIndex(oldContent, oldEnd));

  if (deletedText.length === 0) {
    // Pure insert
    return $proveCtx($beginCost("O(n)"), [DocumentActions.insert(byteStart, insertedText)]);
  }

  if (insertedText.length === 0) {
    // Pure delete
    return $proveCtx($beginCost("O(n)"), [DocumentActions.delete(byteStart, byteOldEnd)]);
  }

  // Replace
  return $proveCtx($beginCost("O(n)"), [
    DocumentActions.replace(byteStart, byteOldEnd, insertedText),
  ]);
}
