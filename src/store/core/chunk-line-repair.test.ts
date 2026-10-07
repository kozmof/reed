/** Chunk loads repair line metrics with the decoder's counts, even for malformed UTF-8. */

import { expect, it } from "vitest";
import { createDocumentStore } from "../features/store.js";
import { DocumentActions } from "../features/actions.js";
import { collectLines } from "./line-index.js";
import { makeDeterministicRng } from "../../../test-utils/large-content.js";

/** Split raw bytes at CR, LF and CRLF, then decode each line on its own. */
function decoderLineMetrics(bytes: readonly number[]): Array<[number, number]> {
  const lines: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    const atEnd = i === bytes.length;
    if (!atEnd && bytes[i] !== 0x0a && bytes[i] !== 0x0d) continue;
    const end = atEnd ? i : bytes[i] === 0x0d && bytes[i + 1] === 0x0a ? i + 2 : i + 1;
    const line = new Uint8Array(bytes.slice(start, end));
    lines.push([line.length, new TextDecoder("utf-8", { ignoreBOM: true }).decode(line).length]);
    start = end;
    i = end - 1;
    if (atEnd) break;
  }
  return lines;
}

function loadInChunks(bytes: readonly number[], chunkSize: number, order: readonly number[]) {
  const store = createDocumentStore({ chunkSize, reconcileMode: "none" });
  for (const index of order) {
    const data = new Uint8Array(bytes.slice(index * chunkSize, (index + 1) * chunkSize));
    store.dispatch(DocumentActions.loadChunk(index, data));
  }
  return collectLines(store.getEagerSnapshot().lineIndex.root).map((line) => [
    line.lineLength,
    line.charLength,
  ]);
}

it("counts a sequence split by a long run of continuation bytes before a chunk seam", () => {
  // The last chunk completes the trailing F0 9F 8E 89. Five continuation bytes
  // precede it, more than a lead byte can claim, after an earlier F0 9F 8E 89.
  const bytes = [
    0xe6, 0x97, 0xa5, 0xf0, 0x9f, 0xf0, 0x9f, 0x8e, 0x89, 0xf0, 0x9f, 0xe6, 0x97, 0xef, 0xbb,
    0xbf, 0xf0, 0x9f, 0x8e, 0x89, 0xf0, 0x9f, 0x8e, 0x89, 0xbf, 0x80, 0x80, 0xf0, 0x9f, 0x8e,
    0x89, 0xbf, 0x0a,
  ];
  expect(loadInChunks(bytes, 7, [0, 1, 2, 3, 4])).toEqual(decoderLineMetrics(bytes));
});

it("matches decoder line metrics for malformed bytes loaded in random chunks and order", () => {
  const fragments = [
    [0x61], [0x0d], [0x0a], [0x0d, 0x0a], [0xef, 0xbb, 0xbf],
    [0xc3, 0xa9], [0xe6, 0x97, 0xa5], [0xf0, 0x9f, 0x8e, 0x89],
    [0x80], [0x80, 0x80, 0x80, 0x80], [0xbf], [0xc3], [0xe6, 0x97], [0xf0, 0x9f],
    [0xed, 0xa0, 0x80], [0xff],
  ];
  const rng = makeDeterministicRng(4242);
  for (let round = 0; round < 300; round++) {
    const bytes: number[] = [];
    const target = 20 + Math.floor(rng() * 200);
    while (bytes.length < target) bytes.push(...fragments[Math.floor(rng() * fragments.length)]!);
    const chunkSize = 1 + Math.floor(rng() * 9);
    const order = Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, i) => i);
    if (round % 2 === 1) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
    }
    expect(loadInChunks(bytes, chunkSize, order), `round ${round}`).toEqual(
      decoderLineMetrics(bytes),
    );
  }
});
