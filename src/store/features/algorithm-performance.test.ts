import { afterEach, expect, it, vi } from "vitest";
import { byteOffset } from "../../types/branded.js";
import { pstackPush, type HistoryEntry, type LineIndexNode } from "../../types/state.js";
import { createInitialState, withState } from "../core/state.js";
import { iterateLineRange } from "../core/line-index-query.js";
import * as pieces from "../core/piece-table.js";
import { estimateTotalHeight, getVisibleLine, getVisibleLines } from "./rendering.js";
import { historyPush, makeInsertChange } from "./edit.js";
import { setValue, setValueWithDiff } from "./set-value.js";
import { documentReducer } from "./reducer.js";
import { DocumentActions } from "./actions.js";

afterEach(() => vi.restoreAllMocks());

it.each([1, 120])("estimates %i long lines without decoding their contents", (count) => {
  const line = "漢😀".repeat(100_000);
  const state = createInitialState({ content: Array(count).fill(line).join("\r\n") });
  const reads = vi.spyOn(pieces, "getText");
  const bytes = vi.spyOn(pieces, "getRawByte");
  expect(
    estimateTotalHeight(state, {
      baseLineHeight: 20,
      charWidth: 1,
      viewportWidth: 100,
      softWrap: true,
    }),
  ).toBe(count * 3000 * 20);
  expect(reads).not.toHaveBeenCalled();
  expect(bytes.mock.calls.length).toBeLessThanOrEqual(count * 2);
  // Building ~84 MB of fixture text dominates; under v8 coverage on CI it
  // exceeds the default 5s even though the estimate itself is near-instant.
}, 30_000);

it("preserves mixed terminator, Unicode, and dirty-index viewport behavior", () => {
  let state = createInitialState({ content: "a\r\n漢😀\rb\n\nlast" });
  state = documentReducer(state, DocumentActions.insert(byteOffset(0), "more\n"));
  const lines = getVisibleLines(state, { startLine: 1, visibleLineCount: 4, overscan: 0 }).lines;
  expect(lines).toEqual([1, 2, 3, 4].map((i) => getVisibleLine(state, i)));
  const config = { baseLineHeight: 10, charWidth: 1, viewportWidth: 2, softWrap: true };
  const expected = getVisibleLines(state, {
    startLine: 0,
    visibleLineCount: state.lineIndex.lineCount,
    overscan: 0,
  }).lines.reduce((sum, line) => sum + (Math.ceil(line.content.length / 2) || 1) * 10, 0);
  expect(estimateTotalHeight(state, config)).toBe(expected);
});

it("walks a line range with work proportional to its output plus tree height", () => {
  const state = createInitialState({ content: "abc\n".repeat(32768) });
  let reads = 0;
  const proxies = new WeakMap<LineIndexNode, LineIndexNode>();
  function observed(node: LineIndexNode | null): LineIndexNode | null {
    if (!node) return null;
    let proxy = proxies.get(node);
    if (!proxy) {
      proxy = new Proxy(
        { ...node },
        {
          get(target, key, receiver) {
            reads++;
            if (key === "left" || key === "right") return observed(target[key]);
            return Reflect.get(target, key, receiver);
          },
        },
      );
      proxies.set(node, proxy);
    }
    return proxy;
  }
  const lines = [...iterateLineRange(observed(state.lineIndex.root), 16000, 16999)];
  expect(lines.map(({ lineNumber, startOffset }) => [lineNumber, startOffset])).toEqual(
    Array.from({ length: 1000 }, (_, i) => [16000 + i, (16000 + i) * 4]),
  );
  expect(reads).toBeLessThan(16000);
  expect([...iterateLineRange(state.lineIndex.root, 3, 2)]).toEqual([]);
});

it("shares a large history prefix across coalescing while preserving snapshot arrays", () => {
  let state = createInitialState({ undoGroupTimeout: 1000 });
  const change = makeInsertChange(byteOffset(0), "x");
  let reads = 0;
  const changes = new Proxy(Object.freeze(Array(10000).fill(change)), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const entry: HistoryEntry = Object.freeze({
    changes,
    selectionBefore: state.selection,
    selectionAfter: state.selection,
    timestamp: 0,
  });
  state = withState(state, {
    history: Object.freeze({
      ...state.history,
      undoStack: pstackPush(null, entry),
    }),
  });
  state = historyPush(state, makeInsertChange(byteOffset(1), "y"), 1);
  const snapshot = state;
  for (let i = 2; i <= 100; i++)
    state = historyPush(state, makeInsertChange(byteOffset(i), "y"), i);
  expect(reads).toBeLessThan(10);
  const latest = state.history.undoStack!.top.changes;
  expect(latest.length).toBe(10000);
  expect(latest[0]).toBe(change);
  expect(latest[9999]!.text).toBe("x" + "y".repeat(100));
  expect(snapshot.history.undoStack!.top.changes[9999]!.text).toBe("xy");
  expect(Object.isFrozen(latest)).toBe(true);
  expect(state.history.undoStack!.top.changes).toBe(latest);
});

it.each([setValue, setValueWithDiff])(
  "compares unchanged values without materializing the document",
  (update) => {
    const content = "漢😀\uFEFFx".repeat(30000);
    const state = createInitialState({ content });
    const fullReads = vi.spyOn(pieces, "getValue");
    const copies = vi.spyOn(Uint8Array.prototype, "set");
    expect(update(state, content)).toBe(state);
    expect(fullReads).not.toHaveBeenCalled();
    expect(Math.max(0, ...copies.mock.calls.map(([source]) => source.length))).toBeLessThanOrEqual(
      65536,
    );
    fullReads.mockRestore();
    copies.mockRestore();
    expect(pieces.getValue(update(state, content + "!").pieceTable)).toBe(content + "!");
    expect(pieces.getValue(update(state, "").pieceTable)).toBe("");
  },
);
