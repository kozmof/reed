/** Lazy traversal and UTF-8-safe streaming for piece-table content. */
import type { PieceNode, PieceTableState } from "../../types/state.js";
import { unwrapReadonlyUint8Array } from "./runtime-readonly.js";

/**
 * Lazily yield pieces and their document offsets without allocating an
 * intermediate array.
 */
export function* inOrderPieces(
  root: PieceNode | null,
): Generator<{ piece: PieceNode; docOffset: number }, void, undefined> {
  if (root === null) return;
  const nodeStack: PieceNode[] = [];
  const offsetStack: number[] = [];
  let currentOffset = 0;
  let currentNode: PieceNode | null = root;

  while (currentNode !== null || nodeStack.length > 0) {
    while (currentNode !== null) {
      nodeStack.push(currentNode);
      offsetStack.push(currentOffset);
      // Do NOT add left.subtreeLength here — left child's subtree starts at the
      // same offset as the current node's subtree, so currentOffset is correct as-is.
      // (currentOffset is updated to pieceStart + n.length after each pop, which
      // correctly seeds the right child's offset.)
      currentNode = currentNode.left;
    }
    const n = nodeStack.pop()!;
    const nOffset = offsetStack.pop()!;
    const pieceStart = nOffset + (n.left?.subtreeLength ?? 0);
    yield { piece: n, docOffset: pieceStart };
    currentOffset = pieceStart + n.length;
    currentNode = n.right;
  }
}

function getPieceBufferRaw(state: PieceTableState, piece: PieceNode): Uint8Array {
  switch (piece.bufferType) {
    case "original":
      return unwrapReadonlyUint8Array(state.originalBuffer);
    case "add":
      return unwrapReadonlyUint8Array(state.addBuffer.subarray(0, state.addBuffer.length));
    case "chunk": {
      const chunk = state.chunkMap.get(piece.chunkIndex);
      if (chunk === undefined) throw new Error(`Chunk ${piece.chunkIndex} is not loaded`);
      return unwrapReadonlyUint8Array(chunk);
    }
    default: {
      const _never: never = piece;
      throw new Error(`Unknown buffer type: ${String(_never)}`);
    }
  }
}

// =============================================================================
// Streaming Operations
// =============================================================================

/**
 * Options for getValueStream.
 */
export interface StreamOptions {
  /**
   * Positive integer chunk size in bytes (default: 64KB).
   * @throws RangeError when the value is non-positive or non-integral.
   */
  chunkSize?: number;
  /** Start offset in document (default: 0) */
  start?: number;
  /** End offset in document (default: end of document) */
  end?: number;
}

/**
 * A chunk of document content with metadata.
 */
export interface DocumentChunk {
  /** The text content of this chunk */
  content: string;
  /** Byte offset where this chunk starts in the document */
  byteOffset: number;
  /** Size of this chunk in bytes */
  byteLength: number;
  /** Whether this is the last chunk */
  isLast: boolean;
}

/**
 * Stream document content in chunks for memory-efficient processing of large files.
 * Yields DocumentChunk objects containing text content and metadata.
 *
 * @param state - The piece table state
 * @param options - Optional streaming configuration
 * @yields DocumentChunk objects
 *
 * @remarks
 * Pieces are traversed lazily — no upfront O(n) array allocation.
 * UTF-8 decoder state is preserved between chunks, so concatenating `content`
 * reconstructs the selected byte range even when a character crosses a byte
 * boundary. A chunk can have empty `content` while the decoder waits for the
 * remaining bytes of a multi-byte character.
 *
 * @example
 * ```typescript
 * for (const chunk of getValueStream(state, { chunkSize: 1024 })) {
 *   process(chunk.content);
 *   console.log(`Processed ${chunk.byteOffset + chunk.byteLength} bytes`);
 * }
 * ```
 */
export function getValueStream(
  state: PieceTableState,
  options: StreamOptions = {},
): Generator<DocumentChunk, void, undefined> {
  const {
    chunkSize = 64 * 1024, // 64KB default
    start = 0,
    end = state.totalLength,
  } = options;

  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError("getValueStream: chunkSize must be a positive integer");
  }

  if (state.root === null || start >= end || start < 0) {
    return (function* () {})();
  }

  return streamChunks(state, inOrderPieces(state.root), chunkSize, start, end);
}

function* streamChunks(
  state: PieceTableState,
  pieceGen: Generator<{ piece: PieceNode; docOffset: number }, void, undefined>,
  chunkSize: number,
  start: number,
  end: number,
): Generator<DocumentChunk, void, undefined> {
  // Advance generator to the first piece that overlaps [start, end)
  let currentEntry: { piece: PieceNode; docOffset: number } | null = null;
  let offsetInCurrentPiece = 0;

  for (const entry of pieceGen) {
    const pieceEnd = entry.docOffset + entry.piece.length;
    if (pieceEnd <= start) continue; // entirely before range
    currentEntry = entry;
    offsetInCurrentPiece = start - entry.docOffset;
    if (offsetInCurrentPiece < 0) offsetInCurrentPiece = 0;
    break;
  }

  if (currentEntry === null) return;

  let documentPosition = start;
  let chunkBuffer = new Uint8Array(chunkSize);
  let chunkOffset = 0;
  let chunkStartPosition = documentPosition;
  // Decoder state must span yielded byte chunks: a fixed byte boundary can fall
  // in the middle of a multi-byte UTF-8 sequence. A decoder local to this
  // generator also keeps concurrent streams independent.
  const decoder = new TextDecoder();

  // Process pieces until we reach `end`
  while (currentEntry !== null && documentPosition < end) {
    const { piece } = currentEntry;
    const buffer = getPieceBufferRaw(state, piece);

    const pieceRemaining = piece.length - offsetInCurrentPiece;
    const documentRemaining = end - documentPosition;
    const chunkRemaining = chunkSize - chunkOffset;
    const bytesToRead = Math.min(pieceRemaining, documentRemaining, chunkRemaining);

    chunkBuffer.set(
      buffer.subarray(
        piece.start + offsetInCurrentPiece,
        piece.start + offsetInCurrentPiece + bytesToRead,
      ),
      chunkOffset,
    );

    chunkOffset += bytesToRead;
    documentPosition += bytesToRead;
    offsetInCurrentPiece += bytesToRead;

    // Advance to next piece when this one is exhausted
    if (offsetInCurrentPiece >= piece.length) {
      const next = pieceGen.next();
      currentEntry = next.done ? null : next.value;
      offsetInCurrentPiece = 0;
    }

    const isLast = documentPosition >= end || currentEntry === null;
    if (chunkOffset >= chunkSize || isLast) {
      yield {
        content: decoder.decode(chunkBuffer.subarray(0, chunkOffset), { stream: !isLast }),
        byteOffset: chunkStartPosition,
        byteLength: chunkOffset,
        isLast,
      };

      if (!isLast) {
        chunkBuffer = new Uint8Array(chunkSize);
        chunkOffset = 0;
        chunkStartPosition = documentPosition;
      }
    }
  }
}
