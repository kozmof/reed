import { describe, expect, it } from "vitest";
import {
  NO_CHUNK,
  flatGapKey,
  gapKey,
  hasUnloadedChunkBetween,
  loadedLengthAtOrBelow,
  pieceKey,
} from "./chunk-anchor.js";
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
    expect(flatGapKey([])(0, "before")).toBe(NO_CHUNK);
    expect(flatGapKey([])(0, "after")).toBe(NO_CHUNK);
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
      for (const side of ["before", "after"] as const) {
        expect(lookup(offset, side), `offset ${offset} ${side}`).toBe(gapKey(root, offset, side));
      }
    }
  });
});

describe("loaded-chunk lengths", () => {
  it("match a direct sum through random loads and evictions", () => {
    const chunkSize = 4;
    const chunkCount = 24;
    const s = createDocumentStore({
      chunkSize,
      totalFileSize: chunkSize * chunkCount - 1,
      reconcileMode: "none",
    });
    const chunk = (i: number) => new Uint8Array(i === chunkCount - 1 ? chunkSize - 1 : chunkSize);
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % chunkCount;
    for (let step = 0; step < 300; step++) {
      const index = next();
      const { pieceTable } = s.getSnapshot();
      if (pieceTable.chunkMap.has(index)) s.dispatch(DocumentActions.evictChunk(index));
      else if (step % 5 === 0) {
        s.dispatch(
          DocumentActions.loadChunks([
            { chunkIndex: index, data: chunk(index) },
            {
              chunkIndex: (index + 3) % chunkCount,
              data: chunk((index + 3) % chunkCount),
            },
          ]),
        );
      } else s.dispatch(DocumentActions.loadChunk(index, chunk(index)));

      const table = s.getSnapshot().pieceTable;
      const loaded = [...table.chunkMap].map(([i, bytes]) => [i, bytes.length] as const);
      for (let key = -2; key <= chunkCount; key++) {
        const expected = loaded.filter(([i]) => i <= key).reduce((sum, [, n]) => sum + n, 0);
        expect(loadedLengthAtOrBelow(table, key), `step ${step} key ${key}`).toBe(expected);
      }
      for (let low = -1; low < chunkCount; low += 3) {
        for (let high = low; high < chunkCount; high += 2) {
          const unloaded = Array.from({ length: high - low }, (_, k) => low + 1 + k).some(
            (i) => !table.chunkMap.has(i),
          );
          expect(hasUnloadedChunkBetween(table, low, high)).toBe(unloaded);
        }
      }
    }
  });
});
