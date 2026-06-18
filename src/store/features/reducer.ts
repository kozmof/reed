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
} from "../../types/state.js";
import type { DocumentAction } from "../../types/actions.js";
import type { ByteOffset } from "../../types/branded.js";
import { byteOffset, byteLength } from "../../types/branded.js";
import {
  withState,
  createChunkPieceNode,
  withPieceNode,
  withLineIndexState,
} from "../core/state.js";
import { unwrapReadonlyUint8Array } from "../core/runtime-readonly.js";
import { appendToRightmost } from "../core/rb-tree.js";
import { getText, insertChunkPieceAt, pieceTableInOrder } from "../core/piece-table.js";
import {
  lineIndexInsertLazy as liInsertLazy,
  lineIndexDeleteLazy as liDeleteLazy,
} from "../core/line-index.js";
import { textDecoder } from "../core/encoding.js";
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
} from "./edit.js";
import { historyUndo, historyRedo } from "./history.js";

/**
 * Normalize line endings in `text` to match `lineEnding`.
 * Returns the original string unchanged if it contains no CR or LF characters
 * (fast path — avoids regex overhead for typical short inserts without newlines).
 */
function normalizeLineEndings(text: string, lineEnding: "lf" | "crlf" | "cr"): string {
  if (!text.includes("\r") && !text.includes("\n")) return text;
  // Collapse every CRLF and lone CR to LF in one pass (\r\n is tried before \r),
  // then convert to the requested style with a second pass when needed.
  const lf = text.replace(/\r\n|\r/g, "\n");
  switch (lineEnding) {
    case "lf":
      return lf;
    case "crlf":
      return lf.replace(/\n/g, "\r\n");
    case "cr":
      return lf.replace(/\n/g, "\r");
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
    throw new Error("SET_SELECTION: ranges must be non-empty");
  }
  return withState(state, {
    selection: Object.freeze({
      ranges: Object.freeze(
        ranges.map((r) =>
          Object.freeze({
            anchor: validatePosition(r.anchor, state.pieceTable.totalLength),
            head: validatePosition(r.head, state.pieceTable.totalLength),
          }),
        ),
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
  return appendToRightmost(root, newLeaf, withPieceNode);
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
 * Return the current document range of a chunk only when its visible bytes still
 * exactly match the original loaded chunk bytes.
 *
 * This blocks eviction after any local edit inside the chunk:
 * - insert/replace => foreign piece appears inside the chunk span
 * - delete         => chunk pieces no longer cover byte offsets [0, chunkByteLength)
 *
 * O(n) where n is the number of pieces.
 */
function findPristineChunkRange(
  root: PieceNode | null,
  chunkIndex: number,
  chunkByteLength: number,
): { start: ByteOffset; end: ByteOffset } | null {
  if (root === null) return null;

  let rangeStart = -1;
  let rangeEnd = -1;
  let expectedChunkOffset = 0;
  let started = false;
  let complete = false;
  let invalid = false;

  pieceTableInOrder(root, (n, pieceStart) => {
    const isTargetChunk = n.bufferType === "chunk" && n.chunkIndex === chunkIndex;

    if (!started) {
      if (!isTargetChunk) return;
      started = true;
      rangeStart = pieceStart;
    } else if (complete) {
      if (isTargetChunk) {
        invalid = true;
        return true;
      }
      return;
    }

    if (!isTargetChunk) {
      invalid = true;
      return true;
    }

    if (n.start !== expectedChunkOffset || expectedChunkOffset + n.length > chunkByteLength) {
      invalid = true;
      return true;
    }

    expectedChunkOffset += n.length;
    rangeEnd = pieceStart + n.length;
    complete = expectedChunkOffset === chunkByteLength;
  });

  if (invalid || !started || !complete || expectedChunkOffset !== chunkByteLength) {
    return null;
  }

  return { start: byteOffset(rangeStart), end: byteOffset(rangeEnd) };
}

/**
 * Return true when a user-owned add piece overlaps or directly touches a chunk's
 * current document span. Boundary-touching inserts are treated conservatively as
 * non-evictable so re-loading the chunk cannot reorder unsaved local edits.
 */
function hasAddPieceTouchingRange(
  root: PieceNode | null,
  rangeStart: ByteOffset,
  rangeEnd: ByteOffset,
): boolean {
  if (root === null) return false;

  let found = false;
  pieceTableInOrder(root, (n, pieceStart) => {
    if (n.bufferType === "add" && pieceStart <= rangeEnd && pieceStart + n.length >= rangeStart) {
      found = true;
      return true;
    }
  });
  return found;
}

/**
 * Rebuild a balanced RB-tree from an in-order array of piece nodes using median-split
 * recursion. All internal nodes are black; leaves are red to give subsequent inserts
 * RB slack.
 *
 * PRECONDITION: `arr` must be a complete, contiguous in-order list produced by a
 * single-pass traversal — the median split is only perfectly balanced in that case.
 * If called with a non-contiguous or pre-filtered slice, verify that equal
 * black-heights still hold before keeping leaf nodes red.
 */
function buildBalancedPieceTree(arr: PieceNode[], lo: number, hi: number): PieceNode | null {
  if (lo > hi) return null;
  const mid = (lo + hi) >> 1;
  const src = arr[mid];
  const left = buildBalancedPieceTree(arr, lo, mid - 1);
  const right = buildBalancedPieceTree(arr, mid + 1, hi);
  const leftLen = left?.subtreeLength ?? 0;
  const rightLen = right?.subtreeLength ?? 0;
  const leftAdd = left?.subtreeAddLength ?? 0;
  const rightAdd = right?.subtreeAddLength ?? 0;
  const selfAdd = src.bufferType === "add" ? src.length : 0;
  return Object.freeze({
    ...src,
    color: (left === null && right === null ? "red" : "black") as "red" | "black",
    left,
    right,
    subtreeLength: src.length + leftLen + rightLen,
    subtreeAddLength: selfAdd + leftAdd + rightAdd,
  });
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

  const survivors: PieceNode[] = [];
  let removedLength = 0;

  pieceTableInOrder(root, (n) => {
    if (n.bufferType === "chunk" && n.chunkIndex === targetChunk) {
      removedLength += n.length;
    } else {
      survivors.push(n);
    }
  });

  if (survivors.length === 0) return { newRoot: null, removedLength };

  return { newRoot: buildBalancedPieceTree(survivors, 0, survivors.length - 1), removedLength };
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
        selectionVersion: state.selectionVersion + 1,
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
          // Normalize line endings on remote inserts the same way local inserts are treated,
          // so mixed-origin edits never silently introduce a different line-ending style.
          const insertText = newState.metadata.normalizeInsertedLineEndings
            ? normalizeLineEndings(change.text, newState.metadata.lineEnding)
            : change.text;
          if (insertText.length === 0) continue;
          didApplyChange = true;
          const position = validatePosition(change.start, newState.pieceTable.totalLength);
          newState = pieceTableInsert(newState, position, insertText).state;
          const readText = (start: ByteOffset, end: ByteOffset) =>
            getText(newState.pieceTable, start, end);
          const li = liInsertLazy(newState.lineIndex, position, insertText, nextVersion, readText);
          newState = withState(newState, { lineIndex: li });
        } else if (change.type === "delete" && change.length > 0) {
          const { start, end, valid } = validateRange(
            change.start,
            byteOffset(change.start + change.length),
            newState.pieceTable.totalLength,
          );
          if (!valid || end - start <= 0) continue;
          didApplyChange = true;
          // Capture deleted text before deleting for line index update
          const deletedText = getTextRange(newState, start, end);
          const deleteContext = getDeleteBoundaryContext(newState, start, end);
          if (shouldRebuildLineIndexForDelete(deletedText, deleteContext)) {
            newState = pieceTableDelete(newState, start, end);
            newState = rebuildLineIndexFromPieceTableState(newState);
          } else {
            const li = liDeleteLazy(
              newState.lineIndex,
              start,
              end,
              deletedText,
              nextVersion,
              deleteContext,
            );
            newState = pieceTableDelete(newState, start, end);
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

      const chunkBytes = new Uint8Array(data);
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

      const chunkBytes = chunkMap.get(chunkIndex)!;
      const range = findPristineChunkRange(state.pieceTable.root, chunkIndex, chunkBytes.length);
      // Refuse eviction if the chunk is missing pieces or has any local edits in its span.
      if (range === null) return state;
      if (hasAddPieceTouchingRange(state.pieceTable.root, range.start, range.end)) return state;
      const chunkText = textDecoder.decode(unwrapReadonlyUint8Array(chunkBytes));

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
