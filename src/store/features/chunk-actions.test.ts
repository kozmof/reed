import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./store.js";
import { DocumentActions } from "./actions.js";
import { chunkHoldReason, chunksMovedByLoads, evictionCandidate } from "./chunk-actions.js";
import { byteOffset } from "../../types/branded.js";
import type { ChunkLoad } from "../../types/actions.js";
import type { DocumentState } from "../../types/state.js";
import { makeDeterministicRng, randomInt } from "../../../test-utils/large-content.js";

const CHUNK_SIZE = 8;
const CHUNK_COUNT = 6;
const bytesOf = (chunkIndex: number) =>
  new TextEncoder().encode(String.fromCharCode(97 + chunkIndex).repeat(CHUNK_SIZE));

/** What the eviction rules say of each resident chunk of `state`. */
function standing(state: DocumentState): Map<number, string> {
  const result = new Map<number, string>();
  for (const chunk of state.pieceTable.chunkMap.keys()) {
    const candidate = evictionCandidate(state, chunk);
    result.set(
      chunk,
      JSON.stringify([
        chunkHoldReason(state, chunk),
        candidate === null ? null : [candidate.loss.undo, candidate.loss.redo],
      ]),
    );
  }
  return result;
}

describe("chunksMovedByLoads", () => {
  // ChunkManager skips chunks it found it cannot evict until history or
  // attention change, or a load moves them (see `chunksMovedByLoads`). If the
  // eviction rules gain a reason a load can change elsewhere, this fails.
  it("lists every resident chunk whose eviction standing a load changes", () => {
    const rng = makeDeterministicRng(0x5eed);
    let checkedLoads = 0;
    for (let round = 0; round < 150; round++) {
      const store = createDocumentStore({
        chunkSize: CHUNK_SIZE,
        totalFileSize: CHUNK_SIZE * CHUNK_COUNT,
        historyEvictionPolicy: "pin",
        reconcileMode: "none",
      });
      const unloaded = Array.from({ length: CHUNK_COUNT }, (_, i) => i);
      const take = () => unloaded.splice(randomInt(rng, 0, unloaded.length - 1), 1)[0]!;
      store.dispatch(DocumentActions.loadChunk(take(), bytesOf(0)));
      let now = 0;
      while (unloaded.length > 0) {
        // Edit and undo the loaded text, so add pieces touch chunks and
        // history points inside them.
        for (let step = randomInt(rng, 0, 3); step > 0; step--) {
          const length = store.getSnapshot().pieceTable.totalLength;
          const at = randomInt(rng, 0, length);
          now += 10_000;
          if (rng() < 0.6 || length === 0) {
            store.dispatch(DocumentActions.insert(byteOffset(at), "X", undefined, now));
          } else {
            const end = Math.min(length, at + randomInt(rng, 1, 3));
            store.dispatch(
              DocumentActions.delete(
                byteOffset(Math.min(at, end - 1)),
                byteOffset(end),
                undefined,
                now,
              ),
            );
          }
          if (rng() < 0.4) store.dispatch(DocumentActions.undo());
        }
        const before = store.getSnapshot();
        const loads: ChunkLoad[] = [];
        for (let n = randomInt(rng, 1, Math.min(2, unloaded.length)); n > 0; n--) {
          const chunkIndex = take();
          loads.push({ chunkIndex, data: bytesOf(chunkIndex) });
        }
        store.dispatch(DocumentActions.loadChunks(loads));
        const after = store.getSnapshot();
        // The precondition `chunksMovedByLoads` relies on.
        expect(after.history).toBe(before.history);
        expect(after.attention).toBe(before.attention);

        const moved = chunksMovedByLoads(before.pieceTable.chunkMap, after.pieceTable.chunkMap);
        const was = standing(before);
        for (const [chunk, now] of standing(after)) {
          if (!was.has(chunk)) {
            expect(moved.has(chunk)).toBe(true);
          } else if (was.get(chunk) !== now) {
            expect({ round, chunk, moved: moved.has(chunk) }).toEqual({
              round,
              chunk,
              moved: true,
            });
          }
        }
        // Passing only the indices finds the same chunks.
        const indices = new Set(before.pieceTable.chunkMap.keys());
        expect(chunksMovedByLoads(indices, after.pieceTable.chunkMap)).toEqual(moved);
        checkedLoads++;
      }
    }
    expect(checkedLoads).toBeGreaterThan(300);
  });
});
