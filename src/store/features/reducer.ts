/**
 * Document reducer for the Reed document editor.
 * Pure reducer function for document state transitions.
 * No side effects - produces new state from old state + action.
 *
 * The heavy lifting (edit pipeline, history push, undo/redo application) is
 * delegated to `edit.ts` and `history.ts`. This file is an orchestrator that
 * maps DocumentActions to the correct pipeline function.
 */

import type {
  DocumentState,
  SelectionRange,
  NonEmptyReadonlyArray,
  PieceNode,
} from "../../types/state.ts";
import type { DocumentAction } from "../../types/actions.ts";
import type { ByteOffset } from "../../types/branded.ts";
import { byteOffset, byteLength } from "../../types/branded.ts";
import {
  withState,
  createChunkPieceNode,
  withPieceNode,
  withLineIndexState,
} from "../core/state.ts";
import { fixRedViolations } from "../core/rb-tree.ts";
import { getText, insertChunkPieceAt, pieceTableInOrder } from "../core/piece-table.ts";
import {
  lineIndexInsertLazy as liInsertLazy,
  lineIndexDeleteLazy as liDeleteLazy,
} from "../core/line-index.ts";
import { textDecoder } from "../core/encoding.ts";
import {
  validatePosition,
  validateRange,
  getTextRange,
  pieceTableInsert,
  pieceTableDelete,
  applyEdit,
  getDeleteBoundaryContext,
  shouldRebuildLineIndexForDelete,
  rebuildLineIndexFromPieceTableState,
} from "./edit.ts";
import { historyUndo, historyRedo } from "./history.ts";

// Regex patterns used for line-ending normalisation.
const CRLF_RE = /\r\n/gu;
const LONE_CR_RE = /\r(?!\n)/gu;
const LONE_LF_RE = /(?<!\r)\n/gu;

/**
 * Normalize line endings in `text` to match `lineEnding`.
 * Returns the original string unchanged if it contains no CR or LF characters
 * (fast path — avoids regex overhead for typical short inserts without newlines).
 */
function normalizeLineEndings(text: string, lineEnding: "lf" | "crlf" | "cr"): string {
  // Fast path: no line-break characters at all
  if (!text.includes("\r") && !text.includes("\n")) return text;

  switch (lineEnding) {
    case "lf":
      // Normalise CRLF → LF first, then any remaining lone CR → LF
      return text.replace(CRLF_RE, "\n").replace(LONE_CR_RE, "\n");
    case "crlf":
      // Normalise lone CR → LF first (to avoid double-processing), then lone LF → CRLF
      return text.replace(LONE_CR_RE, "\n").replace(LONE_LF_RE, "\r\n");
    case "cr":
      // Normalise CRLF → CR first, then any remaining lone LF → CR
      return text.replace(CRLF_RE, "\r").replace(LONE_LF_RE, "\r");
  }
}

// =============================================================================
// Selection Operations
// =============================================================================

/**
 * Update selection state.
 */
function setSelection(state: DocumentState, ranges: readonly SelectionRange[]): DocumentState {
  if (ranges.length === 0) {
    console.warn("SET_SELECTION: ranges must be non-empty; action ignored");
    return state;
  }
  return withState(state, {
    selection: Object.freeze({
      ranges: Object.freeze(
        ranges.map((r) => Object.freeze({ ...r })),
      ) as NonEmptyReadonlyArray<SelectionRange>,
      primaryIndex: 0,
    }),
  });
}

// =============================================================================
// Chunk Loading Helpers (Phase 3)
// =============================================================================

/**
 * Append a new chunk piece as the rightmost leaf of the piece tree.
 * Sequential loading guarantees the chunk always belongs at the document end,
 * so we walk the right spine, graft the new red leaf, then fix any red-red
 * violations bottom-up and ensure the root is black.
 */
function appendChunkPiece(
  root: PieceNode | null,
  chunkIndex: number,
  chunkByteLength: number,
): PieceNode {
  const newLeaf = createChunkPieceNode(
    chunkIndex,
    byteOffset(0),
    byteLength(chunkByteLength),
    "red",
  );

  if (root === null) {
    return withPieceNode(newLeaf, { color: "black" });
  }

  // Walk the right spine collecting ancestors (root → rightmost parent).
  const path: PieceNode[] = [];
  let cur: PieceNode = root;
  while (cur.right !== null) {
    path.push(cur);
    cur = cur.right;
  }

  // Attach leaf to the rightmost node, then fix any red-red violation at that level.
  let updated: PieceNode = fixRedViolations(withPieceNode(cur, { right: newLeaf }), withPieceNode);

  // Walk back up, applying fixup at each ancestor level.
  for (let i = path.length - 1; i >= 0; i--) {
    updated = fixRedViolations(withPieceNode(path[i], { right: updated }), withPieceNode);
  }

  // Ensure the root is always black.
  return updated.color === "black" ? updated : withPieceNode(updated, { color: "black" });
}

/**
 * Find the document byte offset at which a re-loaded chunk should be inserted.
 * Returns the start position of the first piece whose chunkIndex > targetChunkIndex,
 * or the current total document length if no such piece exists (append).
 *
 * O(n) traversal — only used for re-loading evicted chunks, which is rare.
 */
function findReloadInsertionPos(root: PieceNode | null, targetChunkIndex: number): number {
  if (root === null) return 0;
  let result = root.subtreeLength;
  pieceTableInOrder(root, (n, pieceStart) => {
    if (n.bufferType === "chunk" && n.chunkIndex > targetChunkIndex) {
      result = pieceStart;
      return true;
    }
  });
  return result;
}

/**
 * Walk the tree in document order to find the contiguous document-position range
 * covered by all pieces belonging to `chunkIndex`.
 *
 * Returns `{ start, end }` byte offsets in document space, or null if the chunk
 * has no pieces in the tree (already evicted or never loaded).
 *
 * O(n) where n is the number of pieces.
 */
function findChunkDocumentRange(
  root: PieceNode | null,
  chunkIndex: number,
): { start: ByteOffset; end: ByteOffset } | null {
  if (root === null) return null;
  let rangeStart = -1;
  let rangeEnd = -1;
  pieceTableInOrder(root, (n, pieceStart) => {
    if (n.bufferType === "chunk" && n.chunkIndex === chunkIndex) {
      if (rangeStart === -1) rangeStart = pieceStart;
      rangeEnd = pieceStart + n.length;
    }
  });
  if (rangeStart === -1) return null;
  return { start: byteOffset(rangeStart), end: byteOffset(rangeEnd) };
}

/**
 * Walk the tree in document order to check whether any 'add' piece overlaps
 * the byte range [rangeStart, rangeEnd) in document space.
 *
 * O(n) where n is the number of pieces.
 */
function hasAddPiecesInRange(
  root: PieceNode | null,
  rangeStart: ByteOffset,
  rangeEnd: ByteOffset,
): boolean {
  if (root === null) return false;
  let found = false;
  pieceTableInOrder(root, (n, pieceStart) => {
    if (n.bufferType === "add" && pieceStart < rangeEnd && pieceStart + n.length > rangeStart) {
      found = true;
      return true;
    }
  });
  return found;
}

/**
 * Rebuild the RB-tree omitting all pieces whose chunkIndex matches `targetChunk`.
 * Returns the new root and the total byte length removed.
 *
 * Strategy: collect surviving pieces in document order via in-order traversal,
 * then rebuild a balanced black-height-correct tree from them.
 * O(n) traversal + O(n log n) rebuild (n = number of pieces).
 */
function removeChunkPiecesFromTree(
  root: PieceNode | null,
  targetChunk: number,
): { newRoot: PieceNode | null; removedLength: number } {
  if (root === null) return { newRoot: null, removedLength: 0 };

  // Collect surviving pieces in document order
  const survivors: PieceNode[] = [];
  let removedLength = 0;

  const nodeStack: PieceNode[] = [];
  let currentNode: PieceNode | null = root;

  while (currentNode !== null || nodeStack.length > 0) {
    while (currentNode !== null) {
      nodeStack.push(currentNode);
      currentNode = currentNode.left;
    }
    const n = nodeStack.pop()!;
    if (n.bufferType === "chunk" && n.chunkIndex === targetChunk) {
      removedLength += n.length;
    } else {
      survivors.push(n);
    }
    currentNode = n.right;
  }

  if (survivors.length === 0) return { newRoot: null, removedLength };

  // Rebuild a balanced tree from survivors using median-split recursion.
  // All nodes black so the black-height invariant holds for a balanced tree.
  function buildTree(arr: PieceNode[], lo: number, hi: number): PieceNode | null {
    if (lo > hi) return null;
    const mid = (lo + hi) >> 1;
    const src = arr[mid];
    const left = buildTree(arr, lo, mid - 1);
    const right = buildTree(arr, mid + 1, hi);
    const leftLen = left?.subtreeLength ?? 0;
    const rightLen = right?.subtreeLength ?? 0;
    const leftAdd = left?.subtreeAddLength ?? 0;
    const rightAdd = right?.subtreeAddLength ?? 0;
    const selfAdd = src.bufferType === "add" ? src.length : 0;
    // Color leaves red so subsequent inserts have RB slack; internal nodes black.
    // All paths from root to null pass through the same black count because the
    // tree is a perfectly-balanced median split, so no consecutive reds are possible.
    return Object.freeze({
      ...src,
      color: (left === null && right === null ? "red" : "black") as "red" | "black",
      left,
      right,
      subtreeLength: src.length + leftLen + rightLen,
      subtreeAddLength: selfAdd + leftAdd + rightAdd,
    });
  }

  return { newRoot: buildTree(survivors, 0, survivors.length - 1), removedLength };
}

// =============================================================================
// Main Reducer
// =============================================================================

/**
 * Core reducer implementation with structural sharing.
 * Handles all document actions and returns new immutable state.
 */
export function documentReducer(state: DocumentState, action: DocumentAction): DocumentState {
  switch (action.type) {
    case "INSERT": {
      const position = validatePosition(action.start, state.pieceTable.totalLength);
      if (action.text.length === 0) return state;
      const insertText = state.metadata.normalizeInsertedLineEndings
        ? normalizeLineEndings(action.text, state.metadata.lineEnding)
        : action.text;
      return applyEdit(state, {
        kind: "insert",
        position,
        insertText,
        timestamp: action.timestamp,
        selection: action.selection,
      });
    }

    case "DELETE": {
      const { start, end, valid } = validateRange(
        action.start,
        action.end,
        state.pieceTable.totalLength,
      );
      if (!valid) return state;
      if (end - start <= 0) return state;
      const deletedText = getTextRange(state, start, end);
      return applyEdit(state, {
        kind: "delete",
        position: start,
        deleteEnd: end,
        deletedText,
        timestamp: action.timestamp,
        selection: action.selection,
      });
    }

    case "REPLACE": {
      const { start, end, valid } = validateRange(
        action.start,
        action.end,
        state.pieceTable.totalLength,
      );
      if (!valid) return state;
      const oldText = getTextRange(state, start, end);
      const replaceText = state.metadata.normalizeInsertedLineEndings
        ? normalizeLineEndings(action.text, state.metadata.lineEnding)
        : action.text;
      return applyEdit(state, {
        kind: "replace",
        position: start,
        deleteEnd: end,
        deletedText: oldText,
        insertText: replaceText,
        timestamp: action.timestamp,
        selection: action.selection,
      });
    }

    case "SET_SELECTION": {
      return withState(setSelection(state, action.ranges), {
        version: state.version + 1,
      });
    }

    case "UNDO": {
      const nextVersion = state.version + 1;
      const newState = historyUndo(state, nextVersion);
      if (newState === state) return state; // No undo available
      return withState(newState, {
        version: nextVersion,
      });
    }

    case "REDO": {
      const nextVersion = state.version + 1;
      const newState = historyRedo(state, nextVersion);
      if (newState === state) return state; // No redo available
      return withState(newState, {
        version: nextVersion,
      });
    }

    case "HISTORY_CLEAR": {
      // Clear both undo and redo stacks while preserving config
      return withState(state, {
        history: Object.freeze({
          undoStack: null,
          redoStack: null,
          limit: state.history.limit,
          coalesceTimeout: state.history.coalesceTimeout,
        }),
        version: state.version + 1,
      });
    }

    case "APPLY_REMOTE": {
      // Apply remote changes from collaboration
      const nextVersion = state.version + 1;
      let newState = state;
      let didApplyChange = false;
      for (const change of action.changes) {
        if (change.type === "insert" && change.text.length > 0) {
          didApplyChange = true;
          // Normalize line endings on remote inserts the same way local inserts are treated,
          // so mixed-origin edits never silently introduce a different line-ending style.
          const insertText = newState.metadata.normalizeInsertedLineEndings
            ? normalizeLineEndings(change.text, newState.metadata.lineEnding)
            : change.text;
          newState = pieceTableInsert(newState, change.start, insertText).state;
          const readText = (start: ByteOffset, end: ByteOffset) =>
            getText(newState.pieceTable, start, end);
          const li = liInsertLazy(
            newState.lineIndex,
            change.start,
            insertText,
            nextVersion,
            readText,
          );
          newState = withState(newState, { lineIndex: li });
        } else if (change.type === "delete" && change.length > 0) {
          didApplyChange = true;
          // Capture deleted text before deleting for line index update
          const endPosition = byteOffset(change.start + change.length);
          const deletedText = getTextRange(newState, change.start, endPosition);
          const deleteContext = getDeleteBoundaryContext(newState, change.start, endPosition);
          if (shouldRebuildLineIndexForDelete(deletedText, deleteContext)) {
            newState = pieceTableDelete(newState, change.start, endPosition);
            newState = rebuildLineIndexFromPieceTableState(newState);
          } else {
            const li = liDeleteLazy(
              newState.lineIndex,
              change.start,
              endPosition,
              deletedText,
              nextVersion,
              deleteContext,
            );
            newState = pieceTableDelete(newState, change.start, endPosition);
            newState = withState(newState, { lineIndex: li });
          }
        }
      }
      if (!didApplyChange) {
        return state;
      }
      // Remote changes don't push to history (they come from network)
      const metadata = newState.metadata.isDirty
        ? newState.metadata
        : Object.freeze({
            ...newState.metadata,
            isDirty: true,
          });
      return withState(newState, {
        version: nextVersion,
        metadata,
      });
    }

    case "DECLARE_CHUNK_METADATA": {
      if (state.pieceTable.chunkSize === 0) return state; // non-chunked mode

      const { loadedChunks, chunkMetadata } = state.pieceTable;
      const newChunkMetadata = new Map(chunkMetadata);
      const newUnloadedCounts = new Map(state.lineIndex.unloadedLineCountsByChunk);
      let changed = false;

      for (const m of action.metadata) {
        // Ignore metadata for chunks already in memory; their real lines are in the tree.
        if (loadedChunks.has(m.chunkIndex)) continue;
        newChunkMetadata.set(m.chunkIndex, m);
        newUnloadedCounts.set(m.chunkIndex, m.lineCount);
        changed = true;
      }

      if (!changed) return state;

      // DECLARE_CHUNK_METADATA does not bump version or emit content-change.
      return withState(state, {
        pieceTable: Object.freeze({ ...state.pieceTable, chunkMetadata: newChunkMetadata }),
        lineIndex: withLineIndexState(state.lineIndex, {
          unloadedLineCountsByChunk: newUnloadedCounts,
        }),
      });
    }

    case "LOAD_CHUNK": {
      const { chunkIndex, data } = action;
      const { chunkSize, nextExpectedChunk, chunkMap, loadedChunks, totalLength } =
        state.pieceTable;

      // Non-chunked mode: chunkSize must be set in the store config
      if (chunkSize === 0) return state;
      // Reject if this chunk is already in memory (duplicate dispatch or double-load).
      // A chunk that was evicted is no longer in chunkMap, so re-loads are allowed.
      if (chunkMap.has(chunkIndex)) return state;

      const chunkBytes = data as Uint8Array;
      if (chunkBytes.length === 0) return state;

      const chunkText = textDecoder.decode(chunkBytes);

      // Determine whether this is a first-time load or a re-load after eviction.
      // loadedChunks persists across evictions, so a chunk absent from chunkMap but
      // present in loadedChunks is a re-load.
      const isFirstLoad = !loadedChunks.has(chunkIndex);

      // For sequential first-time loads (next in order), use the O(log n) append path.
      // For out-of-order first-time loads and all re-loads, find the correct insertion
      // position via an O(n) walk that places the new piece before any higher-indexed chunk.
      const isSequentialFirst = isFirstLoad && chunkIndex === nextExpectedChunk;
      const insertionPos = isSequentialFirst
        ? byteOffset(totalLength)
        : byteOffset(findReloadInsertionPos(state.pieceTable.root, chunkIndex));

      const newChunkMap = new Map(chunkMap);
      newChunkMap.set(chunkIndex, chunkBytes);

      const newRoot = isSequentialFirst
        ? appendChunkPiece(state.pieceTable.root, chunkIndex, chunkBytes.length)
        : insertChunkPieceAt(state.pieceTable.root, insertionPos, chunkIndex, chunkBytes.length);

      // Update loadedChunks on first load; advance the high-water mark.
      const newLoadedChunks = isFirstLoad ? new Set([...loadedChunks, chunkIndex]) : loadedChunks;

      const newPieceTable = Object.freeze({
        ...state.pieceTable,
        root: newRoot,
        chunkMap: newChunkMap,
        totalLength: totalLength + chunkBytes.length,
        // High-water mark: always advances to max(prev, chunkIndex + 1).
        nextExpectedChunk: Math.max(nextExpectedChunk, chunkIndex + 1),
        loadedChunks: newLoadedChunks,
      });

      const nextVersion = state.version + 1;
      // Remove this chunk's pre-declared line count from the side-cache now that
      // real lines are being inserted into the line index tree.
      let newLineIndex = state.lineIndex;
      if (state.lineIndex.unloadedLineCountsByChunk.has(chunkIndex)) {
        const newMap = new Map(state.lineIndex.unloadedLineCountsByChunk);
        newMap.delete(chunkIndex);
        newLineIndex = withLineIndexState(newLineIndex, { unloadedLineCountsByChunk: newMap });
      }
      // The store schedules background reconciliation when lineIndex.rebuildPending is true.
      newLineIndex = liInsertLazy(newLineIndex, insertionPos, chunkText, nextVersion);

      return withState(state, {
        version: nextVersion,
        pieceTable: newPieceTable,
        lineIndex: newLineIndex,
      });
    }

    case "EVICT_CHUNK": {
      const { chunkIndex } = action;
      const { chunkMap } = state.pieceTable;

      // Cannot evict a chunk that is not loaded
      if (!chunkMap.has(chunkIndex)) return state;

      const range = findChunkDocumentRange(state.pieceTable.root, chunkIndex);
      // No pieces found — tree is out of sync with chunkMap; safe no-op
      if (range === null) return state;

      // Refuse eviction if user edits overlap the chunk's document range
      if (hasAddPiecesInRange(state.pieceTable.root, range.start, range.end)) return state;

      const chunkBytes = chunkMap.get(chunkIndex)!;
      const chunkText = textDecoder.decode(chunkBytes);

      const { newRoot, removedLength } = removeChunkPiecesFromTree(
        state.pieceTable.root,
        chunkIndex,
      );

      const newChunkMap = new Map(chunkMap);
      newChunkMap.delete(chunkIndex);

      const newPieceTable = Object.freeze({
        ...state.pieceTable,
        root: newRoot,
        chunkMap: newChunkMap,
        totalLength: state.pieceTable.totalLength - removedLength,
      });

      const nextVersion = state.version + 1;
      let newLineIndex = liDeleteLazy(
        state.lineIndex,
        range.start,
        range.end,
        chunkText,
        nextVersion,
      );

      // If metadata was pre-declared for this chunk, restore its line count to the
      // side-cache so getLineCountFromIndex continues to return the total expected count.
      const metadata = state.pieceTable.chunkMetadata.get(chunkIndex);
      if (metadata !== undefined) {
        const newMap = new Map(newLineIndex.unloadedLineCountsByChunk);
        newMap.set(chunkIndex, metadata.lineCount);
        newLineIndex = withLineIndexState(newLineIndex, {
          unloadedLineCountsByChunk: newMap,
        }) as typeof newLineIndex;
      }

      return withState(state, {
        version: nextVersion,
        pieceTable: newPieceTable,
        lineIndex: newLineIndex,
      });
    }

    default: {
      // Exhaustive check - TypeScript will error if we miss an action type
      const exhaustiveCheck: never = action;
      return exhaustiveCheck;
    }
  }
}
