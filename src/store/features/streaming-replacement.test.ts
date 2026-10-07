import { afterEach, expect, it, vi } from "vitest";
import { createInitialState } from "../core/state.js";
import * as pieces from "../core/piece-table.js";
import { setValue, computeSetValueActionsFromState } from "./set-value.js";
import { computeSetValueActionsOptimized } from "./text-diff.js";
import { documentReducer } from "./reducer.js";
import { DocumentActions } from "./actions.js";
import { byteOffset } from "../../types/branded.js";

afterEach(() => vi.restoreAllMocks());

it.each(["start", "middle", "end"])(
  "replaces a small change at the %s without flattening old content",
  (where) => {
    const content = "漢😀x".repeat(100000);
    const position = where === "start" ? 0 : where === "middle" ? 200000 : content.length;
    const updated = content.slice(0, position) + "changed" + content.slice(position);
    const state = createInitialState({ content });
    const flatten = vi.spyOn(pieces, "getValue");
    const reads = vi.spyOn(pieces, "getText");
    const copies = vi.spyOn(Uint8Array.prototype, "set");
    const result = setValue(state, updated);
    expect(flatten).not.toHaveBeenCalled();
    expect(
      Math.max(0, ...reads.mock.calls.map(([, start, end]) => end - start)),
    ).toBeLessThanOrEqual(16);
    expect(Math.max(0, ...copies.mock.calls.map(([source]) => source.length))).toBeLessThanOrEqual(
      65536,
    );
    vi.restoreAllMocks();
    expect(pieces.getValue(result.pieceTable)).toBe(updated);
    expect(pieces.getValue(state.pieceTable)).toBe(content);
  },
);

it("matches contiguous replacement boundaries across Unicode and fragmented pieces", () => {
  vi.spyOn(Date, "now").mockReturnValue(1);
  const fixtures = [
    ["", "😀"],
    ["😀", ""],
    ["a😀b", "a😂b"],
    ["a😀b", "a😀xb"],
    ["漢字", "漢文"],
    ["same", "same"],
    ["abcd", "bc"],
    ["bc", "abcd"],
    ["a\ud800x", "a\ud800y"],
    ["a\uFEFFb", "a\uFEFFc"],
  ];
  let seed = 429;
  const alphabet = ["a", "b", "\r", "\n", "漢", "😀", "😂", "\uFEFF", "\ud800", "\udc00"];
  function randomText(): string {
    let text = "";
    for (let i = 0; i < 20; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += alphabet[seed % alphabet.length];
    }
    return text;
  }
  for (let i = 0; i < 100; i++) fixtures.push([randomText(), randomText()]);
  const decoder = new TextDecoder();
  for (const [original, desired] of fixtures) {
    let state = createInitialState({ content: original! });
    // Produce a fragmented table without changing its value.
    state = documentReducer(state, DocumentActions.insert(byteOffset(0), "prefix"));
    state = documentReducer(state, DocumentActions.delete(byteOffset(0), byteOffset(6)));
    const oldText = pieces.getValue(state.pieceTable);
    const normalized = decoder.decode(new TextEncoder().encode(desired!));
    const actions = computeSetValueActionsFromState(state.pieceTable, desired!);
    let result = state;
    for (const action of actions) result = documentReducer(result, action);
    expect(pieces.getValue(result.pieceTable)).toBe(normalized);
    // Compare exact boundaries on canonical inputs; lone surrogates are
    // normalized by encoding, and a leading BOM has separate read semantics.
    if (
      !desired!.includes("\ud800") &&
      !desired!.includes("\udc00") &&
      !original!.startsWith("\uFEFF") &&
      !desired!.startsWith("\uFEFF")
    )
      expect(actions).toEqual(computeSetValueActionsOptimized(oldText, desired!));
  }
});

it("preserves raw byte offsets across split and malformed chunk sequences", () => {
  const bytes = Uint8Array.of(0xff, 0x61, 0xf0, 0x9f, 0x98, 0x80, 0x62);
  let state = createInitialState({ chunkSize: 2 });
  for (let start = 0; start < bytes.length; start += 2)
    state = documentReducer(
      state,
      DocumentActions.loadChunk(start / 2, bytes.slice(start, start + 2)),
    );
  expect(
    computeSetValueActionsFromState(state.pieceTable, pieces.getValue(state.pieceTable)),
  ).toEqual([]);
  expect(setValue(state, pieces.getValue(state.pieceTable))).toBe(state);
  expect(pieces.getValue(setValue(state, "�a😂b").pieceTable)).toBe("�a😂b");
  const bom = createInitialState({ content: "\uFEFFhello" });
  expect(setValue(bom, "hello")).toBe(bom);
});

it("matches exact replacement boundaries on fragmented documents larger than one scan chunk", () => {
  vi.spyOn(Date, "now").mockReturnValue(1);
  let seed = 977;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const alphabet = ["a", "b", "\n", "\r\n", "漢", "😀", "😂", "é"];
  const randomText = (count: number) =>
    Array.from({ length: count }, () => alphabet[next() % alphabet.length]).join("");
  for (let round = 0; round < 40; round++) {
    const original = "x" + randomText(20_000); // ~40k UTF-16 units across chunks
    let state = createInitialState({ content: original });
    // Fragment the table without changing its value.
    for (let i = 0; i < 30; i++) {
      const at = byteOffset(pieces.getLength(state.pieceTable) - 1 - (next() % 1000));
      if (!pieces.isUtf8Boundary(state.pieceTable, at)) continue;
      state = documentReducer(state, DocumentActions.insert(at, "zz"));
      state = documentReducer(state, DocumentActions.delete(at, byteOffset(at + 2)));
    }
    const oldText = pieces.getValue(state.pieceTable);
    // Edit at the ends, at the 16k scan-chunk seams, or anywhere.
    const anchors = [0, oldText.length, 16384, 16383, 32768, next() % oldText.length];
    let at = anchors[next() % anchors.length]!;
    if (at > 0 && at < oldText.length && /[\udc00-\udfff]/.test(oldText[at]!)) at--;
    const removed = next() % 4 === 0 ? 0 : next() % 50;
    let cut = Math.min(oldText.length, at + removed);
    if (cut < oldText.length && /[\udc00-\udfff]/.test(oldText[cut]!)) cut++;
    const desired = oldText.slice(0, at) + randomText(next() % 30) + oldText.slice(cut);

    const actions = computeSetValueActionsFromState(state.pieceTable, desired);
    let result = state;
    for (const action of actions) result = documentReducer(result, action);
    expect(pieces.getValue(result.pieceTable), `round ${round}`).toBe(desired);
    expect(actions, `round ${round}`).toEqual(computeSetValueActionsOptimized(oldText, desired));
  }
});
