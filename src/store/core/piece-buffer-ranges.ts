import type { PieceNode, PieceTableState } from "../../types/state.js";
import { unwrapReadonlyUint8Array } from "./runtime-readonly.js";

/** Buffer-relative ranges, preserving each segment's identity for metric caches. */
export function* pieceBufferRanges(
  state: PieceTableState,
  node: PieceNode,
  start: number,
  end: number,
): Generator<{ bytes: Uint8Array; start: number; end: number; offset: number }> {
  if (node.bufferType === "add") {
    for (const range of state.addBuffer.ranges(start, end))
      yield { ...range, bytes: unwrapReadonlyUint8Array(range.bytes) };
    return;
  }
  const bytes =
    node.bufferType === "original" ? state.originalBuffer : state.chunkMap.get(node.chunkIndex);
  if (!bytes) throw new Error(`Chunk buffer is not loaded`);
  yield { bytes: unwrapReadonlyUint8Array(bytes), start, end, offset: start };
}
