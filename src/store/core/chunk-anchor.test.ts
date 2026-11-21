import { describe, expect, it } from "vitest";
import { loadedLengthAtOrBelow } from "./chunk-anchor.js";
import { createDocumentStore } from "../features/store.js";
import { DocumentActions } from "../features/actions.js";

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
    }
  });
});
