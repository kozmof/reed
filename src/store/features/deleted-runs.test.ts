import { describe, it, expect } from "vitest";
import { createDocumentStore } from "./store.js";
import { DocumentActions } from "./actions.js";
import { byteOffset } from "../../types/branded.js";
import { getValue, isUtf8Boundary } from "../core/piece-table.js";
import { collectLines, rebuildLineIndex } from "../core/line-index.js";
import { makeDeterministicRng, randomInt } from "../../../test-utils/large-content.js";

// Bytes that exercise decoding: ASCII, continuation bytes, lead bytes of every
// width, bytes never valid in UTF-8, and the start of a byte order mark.
const BYTES = [0x61, 0x0a, 0x80, 0xbf, 0xa0, 0xc2, 0xe0, 0xe2, 0xed, 0xf0, 0xf4, 0xc0, 0xff, 0xef];

const lines = (root: Parameters<typeof collectLines>[0]) =>
  collectLines(root).map((line) => line.charLength);

describe("a delete over several runs", () => {
  // Bytes of different chunks have different placement keys, so a delete
  // across chunk edges splits into runs whose edges can cut a character. The
  // line index counts the deleted text, which must be the whole range's.
  it("counts the lines of the whole range for any bytes and run edges", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rng = makeDeterministicRng(seed);
      const chunkSize = randomInt(rng, 1, 6);
      const chunkCount = randomInt(rng, 2, 4);
      const length = chunkSize * chunkCount;
      const store = createDocumentStore({
        chunkSize,
        totalFileSize: length,
        reconcileMode: "none",
      });
      for (let chunk = 0; chunk < chunkCount; chunk++) {
        const bytes = Uint8Array.from(
          { length: chunkSize },
          () => BYTES[randomInt(rng, 0, BYTES.length - 1)]!,
        );
        store.dispatch(DocumentActions.loadChunk(chunk, bytes));
      }
      // A delete must start and end on code-point boundaries.
      const { pieceTable: loaded } = store.getSnapshot();
      const boundaries = Array.from({ length: length + 1 }, (_, at) => at).filter((at) =>
        isUtf8Boundary(loaded, byteOffset(at)),
      );
      const first = randomInt(rng, 0, boundaries.length - 2);
      const start = boundaries[first]!;
      const end = boundaries[randomInt(rng, first + 1, boundaries.length - 1)]!;
      store.dispatch(DocumentActions.delete(byteOffset(start), byteOffset(end)));

      const { pieceTable, lineIndex } = store.getSnapshot();
      expect(lines(lineIndex.root), `seed ${seed}`).toEqual(
        lines(rebuildLineIndex(getValue(pieceTable)).root),
      );
    }
  });
});
