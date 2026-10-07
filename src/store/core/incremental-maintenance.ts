import { pieceBufferRanges } from "./piece-buffer-ranges.js";
import { SpanIndex } from "./span-index.js";
/** Resumable maintenance. Intermediate trees stay private until the job finishes. */
import type {
  LineIndexNode,
  LineIndexState,
  PieceNode,
  PieceTableState,
} from "../../types/state.js";
import { byteOffset } from "../../types/branded.js";
import {
  asEagerLineIndex,
  freezePieceTableState,
  withLineIndexNodeOffsets,
  withLineIndexState,
  withPieceNode,
} from "./state.js";
import { GrowableBuffer } from "./growable-buffer.js";

/** Completed shared subtrees remain useful when a later edit restarts a job. */
export type ReconciliationCache = WeakMap<LineIndexNode, { offset: number; root: LineIndexNode }>;

export function* reconcileIncrementally(
  state: LineIndexState,
  revision: number,
  cache: ReconciliationCache = new WeakMap(),
): Generator<void, LineIndexState<"eager">> {
  const ranges = state.dirtyRanges;
  function intersects(first: number, end: number): boolean {
    if (ranges === "full-rebuild-needed") return true;
    let lo = 0,
      hi = ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ranges[mid]!.endLine < first) lo = mid + 1;
      else hi = mid;
    }
    return lo < ranges.length && ranges[lo]!.startLine < end;
  }
  function* visit(
    node: LineIndexNode | null,
    offset: number,
    first: number,
  ): Generator<void, LineIndexNode | null> {
    if (!node || !intersects(first, first + node.subtreeLineCount)) return node;
    yield;
    const cached = cache.get(node);
    if (cached?.offset === offset) return cached.root;
    const left = yield* visit(node.left, offset, first);
    const documentOffset = offset + (node.left?.subtreeByteLength ?? 0);
    const right = yield* visit(
      node.right,
      documentOffset + node.lineLength,
      first + (node.left?.subtreeLineCount ?? 0) + 1,
    );
    const root =
      left === node.left && right === node.right && documentOffset === node.documentOffset
        ? node
        : withLineIndexNodeOffsets(node, { left, right, documentOffset });
    cache.set(node, { offset, root });
    return root;
  }
  const root = yield* visit(state.root, 0, 0);
  return asEagerLineIndex(
    withLineIndexState(state, {
      root,
      dirtyRanges: Object.freeze([]),
      rebuildPending: false,
      lastReconciledRevision: revision,
    }),
  );
}

interface CopiedSpan {
  start: number;
  copied: number;
  sourceStart: number;
  length: number;
}
export interface CompactionWorkspace {
  published: boolean;
  pages: Uint8Array[];
  length: number;
  nodes: WeakMap<PieceNode, PieceNode>;
  spans: WeakMap<ArrayBufferLike, SpanIndex<CopiedSpan>>;
}

const COMPACTION_PAGE_BYTES = 65536;

export function createCompactionWorkspace(_state: PieceTableState): CompactionWorkspace {
  return {
    pages: [],
    published: false,
    length: 0,
    nodes: new WeakMap(),
    spans: new WeakMap(),
  };
}

export function* compactIncrementally(
  state: PieceTableState,
  workspace: CompactionWorkspace = createCompactionWorkspace(state),
): Generator<void, PieceTableState> {
  if (workspace.published) workspace = createCompactionWorkspace(state);
  const used = state.root?.subtreeAddLength ?? 0;
  if (used === 0) return freezePieceTableState({ ...state, addBuffer: GrowableBuffer.empty(1024) });
  function* reserve(length: number): Generator<void, number> {
    const start = workspace.length;
    const required = start + length;
    while (workspace.pages.length * COMPACTION_PAGE_BYTES < required) {
      workspace.pages.push(new Uint8Array(COMPACTION_PAGE_BYTES));
      yield;
    }
    workspace.length = required;
    return start;
  }
  function* visit(node: PieceNode | null): Generator<void, PieceNode | null> {
    if (!node) return null;
    yield;
    const cached = workspace.nodes.get(node);
    if (cached) return cached;
    const left = yield* visit(node.left);
    let start = node.start;
    if (node.bufferType === "add") {
      const ranges = pieceBufferRanges(state, node, node.start, node.start + node.length);
      const first = ranges.next().value!;
      const single = first.end - first.start === node.length;
      let destination: number | undefined;
      if (!single) destination = yield* reserve(node.length);
      function* copy(range: typeof first): Generator<void, number> {
        const source = range.bytes;
        const sourceStart = source.byteOffset + range.start;
        const length = range.end - range.start;
        let spans = workspace.spans.get(source.buffer);
        if (!spans) workspace.spans.set(source.buffer, (spans = new SpanIndex()));
        let span = single ? spans.containing(sourceStart, length) : undefined;
        if (!span) {
          const target =
            destination === undefined
              ? yield* reserve(length)
              : destination + range.offset - node!.start;
          span = { start: target, copied: 0, sourceStart, length };
          spans.add(span);
          yield;
        }
        const relativeStart = sourceStart - span.sourceStart;
        const requiredCopy = relativeStart + length;
        while (span.copied < requiredCopy) {
          const target = span.start + span.copied;
          const pageOffset = target % COMPACTION_PAGE_BYTES;
          const count = Math.min(COMPACTION_PAGE_BYTES - pageOffset, requiredCopy - span.copied);
          const from = span.sourceStart - source.byteOffset + span.copied;
          workspace.pages[Math.floor(target / COMPACTION_PAGE_BYTES)]!.set(
            source.subarray(from, from + count),
            pageOffset,
          );
          span.copied += count;
          yield;
        }
        return span.start + relativeStart;
      }
      const firstStart = yield* copy(first);
      for (const range of ranges) yield* copy(range);
      start = byteOffset(destination ?? firstStart);
    }
    const right = yield* visit(node.right);
    const result =
      left === node.left && right === node.right && start === node.start
        ? node
        : withPieceNode(node, { left, right, start });
    workspace.nodes.set(node, result);
    return result;
  }
  const root = yield* visit(state.root);
  // Publish bounded segments without allocating a contiguous document buffer.
  let buffer = GrowableBuffer.empty();
  for (let offset = 0; offset < workspace.length; offset += COMPACTION_PAGE_BYTES) {
    const page = workspace.pages[Math.floor(offset / COMPACTION_PAGE_BYTES)]!;
    buffer = buffer.append(
      page.subarray(0, Math.min(COMPACTION_PAGE_BYTES, workspace.length - offset)),
    );
    yield;
  }
  workspace.published = true;
  return freezePieceTableState({
    ...state,
    root,
    addBuffer: buffer,
  });
}

/** A hard work-unit cap complements the clock budget, including under fake clocks. */
export function advanceMaintenance<T>(
  work: Generator<void, T>,
  shouldYield: () => boolean,
): IteratorResult<void, T> {
  let result = work.next();
  for (let steps = 1; !result.done && steps < 1024 && !shouldYield(); steps++) result = work.next();
  return result;
}
