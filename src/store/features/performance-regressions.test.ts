import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialState, createPieceTableState } from "../core/state.js";
import { documentReducer } from "./reducer.js";
import { DocumentActions } from "./actions.js";
import { byteOffset } from "../../types/branded.js";
import type { LineIndexNode, PieceNode } from "../../types/state.js";
import * as pieces from "../core/piece-table.js";
import { collectLines, getLineRangePrecise, reconcileFull } from "../core/line-index.js";
import {
  createAttention,
  createPoint,
  emptyAttentionLayerState,
  migrateDelete,
  resolveAttention,
} from "../core/attention.js";
import { getVisibleLines, lineColumnToPosition, positionToLineColumn } from "./rendering.js";
import { setValue } from "./set-value.js";
import * as replacement from "./streaming-replacement.js";
import {
  assertLineIndexInvariants,
  assertLineIndexRedBlackProperties,
} from "../../../test-utils/invariants.js";

afterEach(() => vi.restoreAllMocks());

function nodes(root: LineIndexNode | null, result = new Set<LineIndexNode>()): Set<LineIndexNode> {
  if (root) {
    result.add(root);
    nodes(root.left, result);
    nodes(root.right, result);
  }
  return result;
}
function newNodes(root: LineIndexNode | null, previous: Set<LineIndexNode>): number {
  if (!root || previous.has(root)) return 0;
  return 1 + newNodes(root.left, previous) + newNodes(root.right, previous);
}

describe("localized edit work", () => {
  it.each([0, 20_000])("shares downstream line nodes during undo/redo at byte %i", (position) => {
    let state = createInitialState({ content: "abc\n".repeat(20_000) });
    state = documentReducer(state, DocumentActions.insert(byteOffset(position), "x"));
    for (const action of [DocumentActions.undo(), DocumentActions.redo()]) {
      const before = nodes(state.lineIndex.root);
      state = documentReducer(state, action);
      expect(newNodes(state.lineIndex.root, before)).toBeLessThan(60);
      expect(getLineRangePrecise(state.lineIndex, 19_999)?.start).toBe(
        19_999 * 4 + (action.type === "REDO" ? 1 : 0),
      );
    }
  });

  it.each(["delete", "insert"])("repairs a CRLF %s locally", (kind) => {
    const state = createInitialState({ content: "abc\r\n".repeat(20_000) });
    const before = nodes(state.lineIndex.root);
    const reads = vi.spyOn(pieces, "getText");
    const result = documentReducer(
      state,
      kind === "delete"
        ? DocumentActions.delete(byteOffset(3), byteOffset(5))
        : DocumentActions.insert(byteOffset(4), "x"),
    );
    expect(newNodes(result.lineIndex.root, before)).toBeLessThan(150);
    expect(Math.max(...reads.mock.calls.map(([, start, end]) => end - start))).toBeLessThan(30);
    expect(result.lineIndex.lineCount).toBe(20_001 + (kind === "delete" ? -1 : 1));
  });

  it("matches rebuilt indexes for CR/LF replacements at every boundary", () => {
    const content = "a\r\nb\rc\nd\r\n";
    for (let start = 0; start <= content.length; start++) {
      for (let end = start; end <= content.length; end++) {
        for (const text of ["", "x", "\r", "\n", "\r\n", "漢😀\r\nx"]) {
          const original = createInitialState({ content });
          const state = documentReducer(
            original,
            DocumentActions.replace(byteOffset(start), byteOffset(end), text),
          );
          const expected = createInitialState({
            content: content.slice(0, start) + text + content.slice(end),
          });
          const actual = reconcileFull(state.lineIndex, state.revision);
          const describeLines = (root: LineIndexNode | null) =>
            collectLines(root).map((n) => [n.documentOffset, n.lineLength, n.charLength]);
          expect(describeLines(actual.root)).toEqual(describeLines(expected.lineIndex.root));
          assertLineIndexInvariants(actual.root);
          assertLineIndexRedBlackProperties(actual.root);
        }
      }
    }
  });

  it("prunes unaffected piece subtrees when migrating an annotation", () => {
    let table = createPieceTableState("ab".repeat(5_000));
    for (let i = 0; i < 2_000; i++)
      table = pieces.pieceTableInsert(table, byteOffset(i * 3 + 1), "x").state;
    const point = createPoint(table.root, byteOffset(1))!;
    const [attention, id] = createAttention(emptyAttentionLayerState, point, point);
    const next = pieces.pieceTableDelete(table, byteOffset(1), byteOffset(2));
    const visited = new Set<PieceNode>();
    const proxies = new WeakMap<PieceNode, PieceNode>();
    function counted(node: PieceNode | null): PieceNode | null {
      if (!node) return null;
      let proxy = proxies.get(node);
      if (!proxy) {
        proxy = new Proxy(
          { ...node },
          {
            get(target, key, receiver) {
              visited.add(node);
              if (key === "left" || key === "right") return counted(target[key]);
              return Reflect.get(target, key, receiver);
            },
          },
        );
        proxies.set(node, proxy);
      }
      return proxy;
    }
    const migrated = migrateDelete(attention, counted(table.root), next.root, 1, 2);
    expect(visited.size).toBeLessThan(100);
    expect(resolveAttention(next.root, migrated, id)?.startOffset).toBe(1);
  });
});

describe("bounded long-line rendering", () => {
  it("bounds cold reads and reuses distant column checkpoints", () => {
    const state = createInitialState({ content: "漢😀x".repeat(100_000) });
    const reads = vi.spyOn(pieces, "getText");
    expect(lineColumnToPosition(state, 0, 1)).toBe(3);
    expect(Math.max(...reads.mock.calls.map(([, start, end]) => end - start))).toBeLessThanOrEqual(
      4096,
    );
    const position = lineColumnToPosition(state, 0, 300_000)!;
    reads.mockClear();
    expect(lineColumnToPosition(state, 0, 300_001)).toBe(position + 3);
    expect(positionToLineColumn(state, position)).toEqual({ line: 0, column: 300_000 });
    expect(reads.mock.calls.length).toBeLessThanOrEqual(4);
    expect(Math.max(...reads.mock.calls.map(([, start, end]) => end - start))).toBeLessThanOrEqual(
      4096,
    );
  });

  it("returns bounded content with whole-line offsets and newline metadata", () => {
    const state = createInitialState({ content: "a".repeat(100_000) + "\r\n😀xyz\n" });
    const reads = vi.spyOn(pieces, "getText");
    const result = getVisibleLines(state, {
      startLine: 0,
      visibleLineCount: 2,
      overscan: 0,
      startColumn: 1,
      maxColumns: 3,
    });
    expect(result.lines[0]).toMatchObject({
      content: "aaa",
      startOffset: 0,
      endOffset: 100_002,
      contentStartColumn: 1,
      isTruncated: true,
      hasNewline: true,
    });
    expect(result.lines[1]).toMatchObject({
      content: "xy",
      contentStartColumn: 2,
      hasNewline: true,
    });
    expect(Math.max(...reads.mock.calls.map(([, start, end]) => end - start))).toBeLessThanOrEqual(
      4096,
    );
  });

  it("handles empty windows, past-end columns, and immutable snapshots", () => {
    const original = createInitialState({ content: "漢😀\r\n" });
    expect(
      getVisibleLines(original, { startLine: 0, visibleLineCount: 1, overscan: 0, maxColumns: 0 })
        .lines[0]?.content,
    ).toBe("");
    expect(
      getVisibleLines(original, { startLine: 0, visibleLineCount: 1, overscan: 0, startColumn: 99 })
        .lines[0],
    ).toMatchObject({ content: "", contentStartColumn: 3 });
    expect(lineColumnToPosition(original, 0, 3)).toBe(7);
    const edited = documentReducer(original, DocumentActions.insert(byteOffset(0), "x"));
    expect(lineColumnToPosition(edited, 0, 3)).toBe(8);
    expect(lineColumnToPosition(original, 0, 3)).toBe(7);
  });
});

it("encodes initial content once while preserving mixed Unicode line metrics", () => {
  const content = "a漢😀\r\nb\rc\n";
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  const state = createInitialState({ content });
  expect(encode.mock.calls.filter(([text]) => text === content)).toHaveLength(1);
  expect(pieces.getValue(state.pieceTable)).toBe(content);
  expect(state.lineIndex.root?.subtreeCharLength).toBe(content.length);
});

it("migrates a local anchor repeatedly without enumerating unrelated annotations", async () => {
  const { PersistentMap } = await import("../core/persistent-map.js");
  const { insertWithAttention, deleteAttention } = await import("../core/attention.js");
  let table = createPieceTableState("abcdefgh".repeat(100));
  // Put unrelated annotations on a separate piece from the edited span.
  table = pieces.pieceTableInsert(table, byteOffset(0), "other").state;
  let layer = emptyAttentionLayerState;
  const unrelated = createPoint(table.root, byteOffset(1))!;
  for (let i = 0; i < 10000; i++) [layer] = createAttention(layer, unrelated, unrelated);
  const point = createPoint(table.root, byteOffset(700))!;
  let id;
  [layer, id] = createAttention(layer, point, point);
  const old = layer;
  const oldTable = table;
  const iteration = vi.spyOn(PersistentMap.prototype, Symbol.iterator);
  const writes = vi.spyOn(PersistentMap.prototype, "with");
  for (let i = 0; i < 20; i++) {
    iteration.mockClear();
    writes.mockClear();
    const result = insertWithAttention(table, layer, byteOffset(600 + i * 2), "x");
    table = result.pieceTableState;
    layer = result.attentionState;
    expect(iteration).not.toHaveBeenCalled();
    expect(writes.mock.calls.length).toBeLessThan(30);
    expect(resolveAttention(table.root, layer, id)?.startOffset).toBe(701 + i);
  }
  expect(resolveAttention(oldTable.root, old, id)?.startOffset).toBe(700);
  expect(deleteAttention(layer, id).attentions.has(id)).toBe(false);
  expect(old.attentions.has(id)).toBe(true);
});

it("reuses text metrics across edits, buffer growth, and snapshot branches", () => {
  const content = "漢😀x".repeat(100_000) + "\nother";
  const original = createInitialState({ content });
  const reads = vi.spyOn(pieces, "getText");
  const position = lineColumnToPosition(original, 0, 300_000)!;
  let state = original;
  for (let i = 0; i < 12; i++) {
    state = documentReducer(
      state,
      DocumentActions.insert(byteOffset(state.pieceTable.totalLength), "tail"),
    );
    reads.mockClear();
    expect(lineColumnToPosition(state, 0, 300_000)).toBe(position);
    expect(positionToLineColumn(state, position)).toEqual({ line: 0, column: 300_000 });
    expect(reads).not.toHaveBeenCalled();
  }
  const branch = documentReducer(original, DocumentActions.insert(byteOffset(0), "😀"));
  expect(lineColumnToPosition(branch, 0, 300_002)).toBe(position + 4);
  expect(lineColumnToPosition(original, 0, 300_000)).toBe(position);
});

it.each(["\n", "\r", "\r\n", "x"])(
  "bounds existing-text reads for long-line boundary edits with %j",
  (text) => {
    const content = "漢😀".repeat(100_000) + "\r\n" + "abc".repeat(100_000) + "\r\n";
    const original = createInitialState({ content });
    const reads = vi.spyOn(pieces, "getText");
    for (const action of [
      DocumentActions.insert(byteOffset(700_000), text),
      DocumentActions.insert(byteOffset(700_001), text),
      DocumentActions.delete(byteOffset(700_000), byteOffset(700_002)),
      DocumentActions.replace(byteOffset(700_000), byteOffset(700_001), text),
    ]) {
      reads.mockClear();
      const state = documentReducer(original, action);
      expect(
        Math.max(0, ...reads.mock.calls.map(([, start, end]) => end - start)),
      ).toBeLessThanOrEqual(4);
      const expected = createInitialState({ content: pieces.getValue(state.pieceTable) });
      const metrics = (value: typeof state) =>
        collectLines(value.lineIndex.root).map((n) => [n.lineLength, n.charLength]);
      expect(metrics(state)).toEqual(metrics(expected));
    }
  },
);

it("encodes a paste once and does not encode deleted text for history", () => {
  let state = createInitialState({ content: "before😀after" });
  const text = "漢😀\n".repeat(10_000);
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  state = documentReducer(state, DocumentActions.replace(byteOffset(6), byteOffset(10), text));
  expect(encode.mock.calls.filter(([value]) => value === text)).toHaveLength(1);
  expect(encode.mock.calls.filter(([value]) => value === "😀")).toHaveLength(0);
  expect(pieces.getValue(documentReducer(state, DocumentActions.undo()).pieceTable)).toBe(
    "before😀after",
  );
});

it("preserves U+FEFF metrics when CRLF repair reads an inserted range", () => {
  const original = createInitialState({ content: "abc\r\ndef" });
  const state = documentReducer(original, DocumentActions.insert(byteOffset(4), "\uFEFF"));
  const expected = createInitialState({ content: "abc\r\uFEFF\ndef" });
  const metrics = (value: typeof state) =>
    collectLines(value.lineIndex.root).map((n) => [n.lineLength, n.charLength]);
  expect(metrics(state)).toEqual(metrics(expected));
});

it.each([1000, 15000])("shares surviving line subtrees when deleting %i lines", (removed) => {
  const state = createInitialState({ content: "abc\n".repeat(20000) });
  const before = nodes(state.lineIndex.root);
  const result = documentReducer(
    state,
    DocumentActions.delete(byteOffset(400), byteOffset(400 + removed * 4)),
  );
  expect(newNodes(result.lineIndex.root, before)).toBeLessThan(120);
  expect(result.lineIndex.lineCount).toBe(20001 - removed);
  expect(getLineRangePrecise(result.lineIndex, 20000 - removed)?.start).toBe((20000 - removed) * 4);
  assertLineIndexInvariants(result.lineIndex.root);
  assertLineIndexRedBlackProperties(result.lineIndex.root);
});

it("reuses annotation query indexes and isolates edited and deleted snapshots", async () => {
  const { findAttentionsAt, findAttentionsOverlapping, deleteAttention, insertWithAttention } =
    await import("../core/attention.js");
  const { PersistentMap } = await import("../core/persistent-map.js");
  const table = createPieceTableState("x".repeat(30000));
  let layer = emptyAttentionLayerState;
  const ids = [];
  for (let i = 0; i < 10000; i++) {
    const point = createPoint(table.root, byteOffset(i * 3))!;
    const end = createPoint(table.root, byteOffset(i * 3 + 2))!;
    const result = createAttention(layer, point, end);
    layer = result[0];
    ids.push(result[1]);
  }
  expect(findAttentionsAt(layer, table.root, 15000)).toEqual([ids[5000]]);
  const iteration = vi.spyOn(PersistentMap.prototype, Symbol.iterator);
  expect(findAttentionsOverlapping(layer, table.root, 14999, 15002)).toEqual([ids[5000]]);
  expect(iteration).not.toHaveBeenCalled();
  const edited = insertWithAttention(table, layer, byteOffset(0), "hello");
  expect(findAttentionsAt(edited.attentionState, edited.pieceTableState.root, 15005)).toEqual([
    ids[5000],
  ]);
  const removed = deleteAttention(edited.attentionState, ids[5000]!);
  expect(findAttentionsAt(removed, edited.pieceTableState.root, 15005)).toEqual([]);
  expect(findAttentionsAt(layer, table.root, 15000)).toEqual([ids[5000]]);
});

it("detects an unchanged setValue without the byte-level replacement scan", () => {
  let state = createInitialState({ content: "line 😀\n".repeat(5_000) });
  for (let i = 0; i < 200; i++) {
    // Each line is 10 bytes; earlier inserts shift line starts by one each.
    state = documentReducer(state, DocumentActions.insert(byteOffset(i * 101), "x"));
  }
  const content = pieces.getValue(state.pieceTable);
  const scan = vi.spyOn(replacement, "streamingReplacement");

  expect(setValue(state, content)).toBe(state);
  expect(scan).not.toHaveBeenCalled();

  const changed = setValue(state, content.slice(0, -1));
  expect(scan).toHaveBeenCalledTimes(1);
  expect(pieces.getValue(changed.pieceTable)).toBe(content.slice(0, -1));
});
