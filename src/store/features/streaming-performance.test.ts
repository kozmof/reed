import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "../core/state.js";
import { documentReducer } from "./reducer.js";
import { DocumentActions } from "./actions.js";
import { byteOffset } from "../../types/branded.js";
import * as pieces from "../core/piece-table.js";
import * as metrics from "../core/decoded-metrics.js";
import { collectLines, getLineRangePrecise, reconcileFull } from "../core/line-index.js";
import type { DocumentState, LineIndexNode } from "../../types/state.js";
import {
  assertLineIndexRedBlackProperties,
  assertPieceTableInvariants,
} from "../../../test-utils/invariants.js";

afterEach(() => vi.restoreAllMocks());
function metricsOf(state: DocumentState) {
  return collectLines(state.lineIndex.root).map((n) => [n.lineLength, n.charLength]);
}
function nodes(node: LineIndexNode | null, set = new Set<LineIndexNode>()): Set<LineIndexNode> {
  if (node) {
    set.add(node);
    nodes(node.left, set);
    nodes(node.right, set);
  }
  return set;
}
function added(node: LineIndexNode | null, before: Set<LineIndexNode>): number {
  return !node || before.has(node) ? 0 : 1 + added(node.left, before) + added(node.right, before);
}

describe("incremental streaming work", () => {
  it("shares existing lines and scans only incoming bytes plus seam context", () => {
    const bytes = new TextEncoder().encode("abc\r\n".repeat(400));
    let state = createInitialState({ chunkSize: bytes.length });
    const scans = vi.spyOn(metrics, "scanPieceLines");
    const reads = vi.spyOn(pieces, "getText");
    let scanned = 0;
    for (let i = 0; i < 100; i++) {
      const before = nodes(state.lineIndex.root);
      scans.mockClear();
      reads.mockClear();
      state = documentReducer(state, DocumentActions.loadChunk(i, bytes));
      const count = scans.mock.calls.reduce((sum, [, start, end]) => sum + end - start, 0);
      expect(count).toBeLessThanOrEqual(bytes.length + 16);
      scanned += count;
      expect(added(state.lineIndex.root, before)).toBeLessThan(450);
      expect(
        Math.max(0, ...reads.mock.calls.map(([, start, end]) => end - start)),
      ).toBeLessThanOrEqual(2);
    }
    expect(scanned).toBeLessThan(100 * (bytes.length + 16));
    expect(state.lineIndex.root?.subtreeByteLength).toBe(state.pieceTable.totalLength);
    const before = nodes(state.lineIndex.root);
    scans.mockClear();
    reads.mockClear();
    state = documentReducer(state, DocumentActions.evictChunk(50));
    expect(
      scans.mock.calls.reduce((sum, [, start, end]) => sum + end - start, 0),
    ).toBeLessThanOrEqual(16);
    expect(added(state.lineIndex.root, before)).toBeLessThan(100);
    expect(state.lineIndex.root?.subtreeByteLength).toBe(state.pieceTable.totalLength);
    assertPieceTableInvariants(state.pieceTable, "streaming", true);
    assertLineIndexRedBlackProperties(state.lineIndex.root);
  });
  it("keeps long-line chunk edits bounded even on a cold snapshot", () => {
    const text = "漢😀".repeat(100_000) + "\r\n";
    const bytes = new TextEncoder().encode(text);
    const original = documentReducer(
      createInitialState({ chunkSize: bytes.length }),
      DocumentActions.loadChunk(0, bytes),
    );
    const reads = vi.spyOn(pieces, "getText");
    for (const action of [
      DocumentActions.insert(byteOffset(699993), "\n"),
      DocumentActions.insert(byteOffset(700001), "x"),
      DocumentActions.delete(byteOffset(700000), byteOffset(700002)),
    ]) {
      reads.mockClear();
      const state = documentReducer(original, action);
      expect(
        Math.max(0, ...reads.mock.calls.map(([, start, end]) => end - start)),
      ).toBeLessThanOrEqual(2);
      const reference = createInitialState({ content: pieces.getValue(state.pieceTable) });
      expect(metricsOf(state)).toEqual(metricsOf(reference));
    }
  });
  it("maintains physical byte offsets and replacement characters at arbitrary chunk seams", () => {
    const bytes = Uint8Array.of(
      0xf0,
      0x9f,
      0x8e,
      0x89,
      13,
      10,
      0xe0,
      0xa0,
      0x80,
      10,
      0xff,
      0xc2,
      0xa9,
      13,
      0x80,
      10,
    );
    for (const size of [1, 2, 3, 5]) {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
      let state = createInitialState({ chunkSize: size });
      const resident = new Set<number>();
      const order = chunks.map((_, i) => i).reverse();
      function check() {
        const raw = Uint8Array.from(
          [...resident].sort((a, b) => a - b).flatMap((i) => [...chunks[i]!]),
        );
        const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw);
        expect(state.lineIndex.root?.subtreeByteLength).toBe(raw.length);
        expect(state.lineIndex.root?.subtreeCharLength).toBe(text.length);
        const lines = text.split(/(?<=\n)|(?<=\r)(?!\n)/);
        const expectedCount = (text.match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
        expect(state.lineIndex.lineCount).toBe(expectedCount);
        const eager = reconcileFull(state.lineIndex, state.revision);
        expect(getLineRangePrecise(eager, 0)?.start).toBe(0);
        assertLineIndexRedBlackProperties(eager.root);
        expect(lines.join("")).toBe(text);
      }
      for (const i of order) {
        state = documentReducer(state, DocumentActions.loadChunk(i, chunks[i]!));
        resident.add(i);
        check();
      }
      for (const i of order) {
        state = documentReducer(state, DocumentActions.evictChunk(i));
        resident.delete(i);
        check();
      }
    }
  });
});
