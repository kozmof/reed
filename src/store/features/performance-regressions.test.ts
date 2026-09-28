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
