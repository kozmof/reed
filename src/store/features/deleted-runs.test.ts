import { describe, it, expect } from "vitest";
import { deletedRuns } from "./edit.js";
import { createDocumentStore } from "./store.js";
import { DocumentActions } from "./actions.js";
import { contentDecoder } from "../core/encoding.js";
import type { KeyRun } from "../core/chunk-anchor.js";
import { makeDeterministicRng, randomInt } from "../../../test-utils/large-content.js";

// Bytes that exercise decoding: ASCII, continuation bytes, lead bytes of every
// width, bytes never valid in UTF-8, and the start of a byte order mark.
const BYTES = [0x61, 0x0a, 0x80, 0xbf, 0xa0, 0xc2, 0xe0, 0xe2, 0xed, 0xf0, 0xf4, 0xc0, 0xff, 0xef];

describe("deletedRuns", () => {
  it("gives the text of the whole range for any bytes and run edges", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rng = makeDeterministicRng(seed);
      const length = randomInt(rng, 1, 24);
      const bytes = Uint8Array.from({ length }, () => BYTES[randomInt(rng, 0, BYTES.length - 1)]!);
      const store = createDocumentStore({
        chunkSize: length,
        totalFileSize: length,
        reconcileMode: "none",
      });
      store.dispatch(DocumentActions.loadChunk(0, bytes));
      const { pieceTable } = store.getSnapshot();

      const start = randomInt(rng, 0, length - 1);
      const end = randomInt(rng, start + 1, length);
      const runs: KeyRun[] = [];
      for (let at = start; at < end; ) {
        const next = randomInt(rng, at + 1, end);
        runs.push({ start: at, end: next, key: runs.length });
        at = next;
      }
      const { text, runs: deleted } = deletedRuns(pieceTable, runs);
      expect(text, `seed ${seed}`).toBe(contentDecoder.decode(bytes.subarray(start, end)));
      expect(deleted.map((run) => run.length)).toEqual(runs.map((run) => run.end - run.start));
    }
  });
});
