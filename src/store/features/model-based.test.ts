import { describe, expect, it } from "vitest";
import { attentionID, byteOffset } from "../../types/branded.js";
import { getTextForAttention } from "../core/attention.js";
import { createDocumentStore } from "./store.js";
import { DocumentActions } from "./actions.js";
import {
  assertDocumentMatchesModel,
  assertPieceTableInvariants,
} from "../../../test-utils/invariants.js";

function rngFor(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function int(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

describe("model-based document transitions", () => {
  it("matches a plain string across long seeded edit sequences", () => {
    const inserts = ["a", "XYZ", "\n", "\r", "\r\n", "two\nlines", ""];
    for (const seed of [1, 7, 19, 41, 83, 167, 337, 677, 1361, 2729, 5471, 10949]) {
      const rng = rngFor(seed);
      const store = createDocumentStore({ content: "seed\ntext", reconcileMode: "none" });
      let model = "seed\ntext";

      for (let step = 0; step < 350; step++) {
        const operation = int(rng, 0, 2);
        if (operation === 0 || model.length === 0) {
          const position = int(rng, 0, model.length);
          const text = inserts[int(rng, 0, inserts.length - 1)]!;
          store.dispatch(DocumentActions.insert(byteOffset(position), text, undefined, step));
          model = model.slice(0, position) + text + model.slice(position);
        } else {
          const start = int(rng, 0, model.length - 1);
          const end = int(rng, start + 1, model.length);
          if (operation === 1) {
            store.dispatch(
              DocumentActions.delete(byteOffset(start), byteOffset(end), undefined, step),
            );
            model = model.slice(0, start) + model.slice(end);
          } else {
            const text = inserts[int(rng, 0, inserts.length - 1)]!;
            store.dispatch(
              DocumentActions.replace(byteOffset(start), byteOffset(end), text, undefined, step),
            );
            model = model.slice(0, start) + text + model.slice(end);
          }
        }

        if (step % 25 === 0) {
          assertDocumentMatchesModel(store.reconcileNow(), model, `seed=${seed} step=${step}`);
        }
      }
      assertDocumentMatchesModel(store.reconcileNow(), model, `seed=${seed} final`);
      store.dispose();
    }
  });

  it("keeps an anchored span stable through randomized edits around it", () => {
    const store = createDocumentStore({ content: "prefix|TARGET|suffix", reconcileMode: "none" });
    store.dispatch(DocumentActions.createAttention(byteOffset(7), byteOffset(13)));
    const id = attentionID("a0");
    const rng = rngFor(0xa77e1710);
    let targetStart = 7;
    let model = "prefix|TARGET|suffix";

    for (let step = 0; step < 250; step++) {
      const before = rng() < 0.5;
      const text = ["x", "\n", "π", "終"][int(rng, 0, 3)]!;
      const position = before
        ? int(rng, 0, Math.max(0, targetStart - 1))
        : int(rng, targetStart + 6, model.length);
      const bytePosition = new TextEncoder().encode(model.slice(0, position)).length;
      store.dispatch(DocumentActions.insert(byteOffset(bytePosition), text, undefined, step));
      model = model.slice(0, position) + text + model.slice(position);
      if (before) targetStart += text.length;

      const snapshot = store.getSnapshot();
      expect(getTextForAttention(snapshot.pieceTable, snapshot.attention, id), `step=${step}`).toBe(
        "TARGET",
      );
      assertPieceTableInvariants(snapshot.pieceTable, `attention step=${step}`);
    }
    assertDocumentMatchesModel(store.reconcileNow(), model, "attention final");
  });
});

describe("chunk boundary model", () => {
  it("survives seeded out-of-order UTF-8/CRLF load, eviction, and reload cycles", () => {
    const text = "Aπ\r\n終🙂\nB\rC";
    const bytes = new TextEncoder().encode(text);
    const chunkSize = 3;
    const chunks = Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, index) =>
      bytes.slice(index * chunkSize, Math.min(bytes.length, (index + 1) * chunkSize)),
    );

    for (const seed of [3, 17, 97, 389]) {
      const store = createDocumentStore({
        chunkSize,
        totalFileSize: bytes.length,
        reconcileMode: "none",
      });
      const resident = new Set<number>();
      const rng = rngFor(seed);

      for (let step = 0; step < 180; step++) {
        const index = int(rng, 0, chunks.length - 1);
        if (resident.has(index) && rng() < 0.55) {
          const before = store.getSnapshot();
          const after = store.dispatch(DocumentActions.evictChunk(index));
          if (after !== before) resident.delete(index);
        } else if (!resident.has(index)) {
          const before = store.getSnapshot();
          const after = store.dispatch(DocumentActions.loadChunk(index, chunks[index]!));
          if (after !== before) resident.add(index);
        }

        const expectedBytes = new Uint8Array(
          [...resident].sort((a, b) => a - b).flatMap((chunk) => [...chunks[chunk]!]),
        );
        const expected = new TextDecoder().decode(expectedBytes);
        assertDocumentMatchesModel(store.reconcileNow(), expected, `seed=${seed} step=${step}`);
      }
      store.dispose();
    }
  });
});
