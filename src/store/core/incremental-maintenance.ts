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
import { unwrapReadonlyUint8Array } from "./runtime-readonly.js";

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
  bytes: Uint8Array;
  length: number;
  nodes: WeakMap<PieceNode, PieceNode>;
  spans: WeakMap<ArrayBufferLike, Map<number, CopiedSpan[]>>;
}

export function createCompactionWorkspace(state: PieceTableState): CompactionWorkspace {
  return {
    bytes: new Uint8Array(Math.max((state.root?.subtreeAddLength ?? 0) * 2, 1024)),
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
  const source = unwrapReadonlyUint8Array(state.addBuffer.bytes);
  let spans = workspace.spans.get(source.buffer);
  if (!spans) workspace.spans.set(source.buffer, (spans = new Map()));
  function* visit(node: PieceNode | null): Generator<void, PieceNode | null> {
    if (!node) return null;
    yield;
    const cached = workspace.nodes.get(node);
    if (cached) return cached;
    const left = yield* visit(node.left);
    let start = node.start;
    if (node.bufferType === "add") {
      const sourceStart = source.byteOffset + node.start;
      const bucket = Math.floor(sourceStart / 65536);
      let span = spans!
        .get(bucket)
        ?.find(
          (candidate) =>
            candidate.sourceStart <= sourceStart &&
            candidate.sourceStart + candidate.length >= sourceStart + node.length,
        );
      if (!span) {
        const required = workspace.length + node.length;
        if (required > workspace.bytes.length) {
          const bytes = new Uint8Array(Math.max(required, workspace.bytes.length * 2));
          for (let offset = 0; offset < workspace.length; offset += 65536) {
            bytes.set(
              workspace.bytes.subarray(offset, Math.min(workspace.length, offset + 65536)),
              offset,
            );
            yield;
          }
          workspace.bytes = bytes;
        }
        span = { start: workspace.length, copied: 0, sourceStart, length: node.length };
        workspace.length = required;
        for (
          let block = bucket;
          block <= Math.floor((sourceStart + node.length - 1) / 65536);
          block++
        ) {
          const entries = spans!.get(block) ?? [];
          entries.push(span);
          spans!.set(block, entries);
          yield;
        }
      }
      const relativeStart = sourceStart - span.sourceStart;
      start = byteOffset(span.start + relativeStart);
      const requiredCopy = relativeStart + node.length;
      // A containing span also covers pieces split by an intervening edit.
      // Copy from the reserved source span, continuing its previous progress.
      while (span.copied < requiredCopy) {
        const count = Math.min(65536, requiredCopy - span.copied);
        const from = span.sourceStart - source.byteOffset + span.copied;
        workspace.bytes.set(source.subarray(from, from + count), span.start + span.copied);
        span.copied += count;
        yield;
      }
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
  workspace.published = true;
  return freezePieceTableState({
    ...state,
    root,
    addBuffer: new GrowableBuffer(workspace.bytes, workspace.length),
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
