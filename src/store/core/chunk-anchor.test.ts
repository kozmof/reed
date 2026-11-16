import { describe, expect, it } from "vitest";
import { NO_CHUNK, flatGapKey, gapKey, pieceKey } from "./chunk-anchor.js";
import { createDocumentStore } from "../features/store.js";
import { DocumentActions } from "../features/actions.js";
import { byteOffset } from "../../types/branded.js";
import type { PieceNode } from "../../types/state.js";

function inOrder(node: PieceNode | null, out: PieceNode[] = []): PieceNode[] {
  if (node === null) return out;
  inOrder(node.left, out);
  out.push(node);
  inOrder(node.right, out);
  return out;
}

describe("flatGapKey", () => {
  it("is NO_CHUNK for an empty list", () => {
    expect(flatGapKey([])(0)).toBe(NO_CHUNK);
  });

  it("agrees with gapKey on the piece tree at every offset", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const s = createDocumentStore({ chunkSize: 4, totalFileSize: 16, reconcileMode: "none" });
    s.dispatch(DocumentActions.loadChunk(0, enc("aaaa")));
    s.dispatch(DocumentActions.loadChunk(2, enc("cccc")));
    s.dispatch(DocumentActions.insert(byteOffset(4), "XY"));
    s.dispatch(DocumentActions.insert(byteOffset(9), "Z"));
    const { root, totalLength } = s.getSnapshot().pieceTable;
    const lookup = flatGapKey(
      inOrder(root).map((piece) => ({
        length: piece.length,
        key: pieceKey(piece),
        chunkIndex: piece.bufferType === "chunk" ? piece.chunkIndex : null,
      })),
    );
    for (let offset = 0; offset <= totalLength; offset++) {
      expect(lookup(offset), `offset ${offset}`).toBe(gapKey(root, offset));
    }
  });
});
