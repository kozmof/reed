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

export function* reconcileIncrementally(
  state: LineIndexState,
  revision: number,
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
    const left = yield* visit(node.left, offset, first);
    const documentOffset = offset + (node.left?.subtreeByteLength ?? 0);
    const right = yield* visit(
      node.right,
      documentOffset + node.lineLength,
      first + (node.left?.subtreeLineCount ?? 0) + 1,
    );
    return left === node.left && right === node.right && documentOffset === node.documentOffset
      ? node
      : withLineIndexNodeOffsets(node, { left, right, documentOffset });
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

export function* compactIncrementally(state: PieceTableState): Generator<void, PieceTableState> {
  const used = state.root?.subtreeAddLength ?? 0;
  if (used === 0) return freezePieceTableState({ ...state, addBuffer: GrowableBuffer.empty(1024) });
  // Allocation is unavoidable for a contiguous buffer; copying and tree work
  // yield independently, including when one piece contains most of the bytes.
  const bytes = new Uint8Array(Math.max(used * 2, 1024));
  const source = unwrapReadonlyUint8Array(state.addBuffer.bytes);
  let offset = 0;
  function* visit(node: PieceNode | null): Generator<void, PieceNode | null> {
    if (!node) return null;
    yield;
    const left = yield* visit(node.left);
    let start = node.start;
    if (node.bufferType === "add") {
      start = byteOffset(offset);
      for (let copied = 0; copied < node.length; copied += 65536) {
        const count = Math.min(65536, node.length - copied);
        bytes.set(source.subarray(node.start + copied, node.start + copied + count), offset);
        offset += count;
        yield;
      }
    }
    const right = yield* visit(node.right);
    return left === node.left && right === node.right && start === node.start
      ? node
      : withPieceNode(node, { left, right, start });
  }
  const root = yield* visit(state.root);
  return freezePieceTableState({ ...state, root, addBuffer: new GrowableBuffer(bytes, offset) });
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
