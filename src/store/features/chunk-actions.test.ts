import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./store.js";
import { DocumentActions } from "./actions.js";
import { hasAttentionAnchoredToChunk } from "./chunk-actions.js";
import { hasAttentionForPiece } from "../core/attention.js";
import { byteOffset } from "../../types/branded.js";
import type { DocumentState, PieceNode } from "../../types/state.js";
import { makeDeterministicRng, randomInt } from "../../../test-utils/large-content.js";

const CHUNK_SIZE = 8;
const CHUNK_COUNT = 6;
const bytesOf = (chunkIndex: number) =>
  new TextEncoder().encode(String.fromCharCode(97 + chunkIndex).repeat(CHUNK_SIZE));

/** The chunks with an attention anchored to one of their pieces, by walking every piece. */
function anchoredChunks(state: DocumentState): Set<number> {
  const result = new Set<number>();
  const walk = (node: PieceNode | null) => {
    if (!node) return;
    walk(node.left);
    if (node.bufferType === "chunk" && hasAttentionForPiece(state.attention, node.id)) {
      result.add(node.chunkIndex);
    }
    walk(node.right);
  };
  walk(state.pieceTable.root);
  return result;
}

describe("hasAttentionAnchoredToChunk", () => {
  // The lookup prunes subtrees by their chunk range, which loads, evictions,
  // and edits keep up to date.
  it("matches a walk of every piece across loads, evictions, edits, and attention changes", () => {
    const rng = makeDeterministicRng(0xa77e);
    let checks = 0;
    let anchoredSeen = 0;
    for (let round = 0; round < 60; round++) {
      const store = createDocumentStore({
        chunkSize: CHUNK_SIZE,
        totalFileSize: CHUNK_SIZE * CHUNK_COUNT,
        historyEvictionPolicy: "drop",
        reconcileMode: "none",
      });
      let now = 0;
      for (let step = 0; step < 40; step++) {
        const state = store.getSnapshot();
        const length = state.pieceTable.totalLength;
        const roll = rng();
        if (roll < 0.3) {
          const chunk = randomInt(rng, 0, CHUNK_COUNT - 1);
          if (!state.pieceTable.chunkMap.has(chunk)) {
            store.dispatch(DocumentActions.loadChunk(chunk, bytesOf(chunk)));
          }
        } else if (roll < 0.45) {
          store.dispatch(DocumentActions.evictChunk(randomInt(rng, 0, CHUNK_COUNT - 1), true));
        } else if (roll < 0.65 && length > 0) {
          now += 10_000;
          const at = randomInt(rng, 0, length);
          store.dispatch(DocumentActions.insert(byteOffset(at), "X", undefined, now));
        } else if (roll < 0.75 && length > 1) {
          now += 10_000;
          const at = randomInt(rng, 0, length - 1);
          store.dispatch(
            DocumentActions.delete(byteOffset(at), byteOffset(at + 1), undefined, now),
          );
        } else if (roll < 0.9 && length > 0) {
          const start = randomInt(rng, 0, length - 1);
          const end = randomInt(rng, start + 1, length);
          store.dispatch(DocumentActions.createAttention(byteOffset(start), byteOffset(end)));
        } else {
          const ids = [...state.attention.attentions.keys()];
          if (ids.length > 0) {
            store.dispatch(
              DocumentActions.deleteAttention(ids[randomInt(rng, 0, ids.length - 1)]!),
            );
          }
        }
        const after = store.getSnapshot();
        const expected = anchoredChunks(after);
        for (let chunk = 0; chunk < CHUNK_COUNT; chunk++) {
          expect({
            round,
            step,
            chunk,
            anchored: hasAttentionAnchoredToChunk(after, chunk),
          }).toEqual({ round, step, chunk, anchored: expected.has(chunk) });
          checks++;
          if (expected.has(chunk)) anchoredSeen++;
        }
      }
    }
    expect(checks).toBe(60 * 40 * CHUNK_COUNT);
    expect(anchoredSeen).toBeGreaterThan(checks / 10);
  });
});
