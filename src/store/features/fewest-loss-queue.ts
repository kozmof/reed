/**
 * The order in which `"pin-bounded"` evicts chunks that cost history: each
 * time the one whose eviction now discards the fewest entries, ties going to
 * the earlier candidate (see `evictChunks`).
 */
import type { EvictionHistoryLoss } from "./history-anchor.js";

interface Candidate {
  readonly index: number;
  readonly undo: number;
  readonly redo: number;
  open: boolean;
}

/** A binary min-heap. */
class Heap<T> {
  readonly #items: T[] = [];
  readonly less: (a: T, b: T) => boolean;
  constructor(less: (a: T, b: T) => boolean) {
    this.less = less;
  }

  peek(): T | undefined {
    return this.#items[0];
  }

  push(item: T): void {
    const items = this.#items;
    let at = items.push(item) - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!this.less(items[at]!, items[parent]!)) break;
      [items[at], items[parent]] = [items[parent]!, items[at]!];
      at = parent;
    }
  }

  pop(): void {
    const items = this.#items;
    const last = items.pop();
    if (items.length === 0 || last === undefined) return;
    items[0] = last;
    let at = 0;
    for (;;) {
      const left = 2 * at + 1;
      const right = left + 1;
      let least = at;
      if (left < items.length && this.less(items[left]!, items[least]!)) least = left;
      if (right < items.length && this.less(items[right]!, items[least]!)) least = right;
      if (least === at) return;
      [items[at], items[least]] = [items[least]!, items[at]!];
      at = least;
    }
  }
}

export interface FewestLossQueue {
  /**
   * Take the candidate whose eviction now discards the fewest entries, the
   * earliest on a tie, with what it now discards. Undefined once none is left.
   */
  take(): { readonly index: number; readonly loss: EvictionHistoryLoss } | undefined;
  /** Record that evicting a taken candidate discarded `loss`. */
  dropped(loss: EvictionHistoryLoss): void;
}

/**
 * Order candidates whose evictions discard `losses`, measured before any of
 * them is evicted.
 *
 * Each loss counts the oldest entries of its stack, and an eviction drops only
 * the oldest entries. The entry a loss was cut at is unchanged while it is
 * kept, since the search for it starts from the newest entry and never reads
 * older ones. So once `dropped` entries of a stack are gone, a loss of `n`
 * there is `max(0, n - dropped)`. This saves measuring every loss again after
 * each eviction.
 *
 * Those drops grow, so each candidate passes at most once from discarding
 * entries of a stack to discarding none of it. The candidates are kept in four
 * heaps by which stacks they still discard from, each ordered by what it costs
 * within the heap: undo plus redo, undo, redo, or nothing. A candidate moves
 * heap when the drops pass its count, found in order from the candidates
 * sorted by each count. Entries left in a heap they no longer belong to are
 * skipped when they reach its top. Taking a candidate costs O(log L), and
 * L candidates O(L log L) in all.
 */
export function createFewestLossQueue(losses: readonly EvictionHistoryLoss[]): FewestLossQueue {
  let droppedUndo = 0;
  let droppedRedo = 0;
  const candidates: Candidate[] = losses.map((loss, index) => ({
    index,
    undo: loss.undo,
    redo: loss.redo,
    open: true,
  }));
  // Bit 1: still discards undo entries. Bit 0: still discards redo entries.
  const group = (c: Candidate) => (c.undo > droppedUndo ? 2 : 0) | (c.redo > droppedRedo ? 1 : 0);
  const costIn = [
    () => 0,
    (c: Candidate) => c.redo,
    (c: Candidate) => c.undo,
    (c: Candidate) => c.undo + c.redo,
  ] as const;
  const heaps = costIn.map(
    (cost) =>
      new Heap<Candidate>(
        (a, b) => cost(a) < cost(b) || (cost(a) === cost(b) && a.index < b.index),
      ),
  );
  for (const c of candidates) heaps[group(c)]!.push(c);

  const byUndo = [...candidates].sort((a, b) => a.undo - b.undo);
  const byRedo = [...candidates].sort((a, b) => a.redo - b.redo);
  // Candidates before these no longer discard undo, or redo, entries.
  let undoPassed = 0;
  let redoPassed = 0;
  const pass = () => {
    while (undoPassed < byUndo.length && byUndo[undoPassed]!.undo <= droppedUndo) {
      const c = byUndo[undoPassed++]!;
      if (c.open) heaps[group(c)]!.push(c);
    }
    while (redoPassed < byRedo.length && byRedo[redoPassed]!.redo <= droppedRedo) {
      const c = byRedo[redoPassed++]!;
      if (c.open) heaps[group(c)]!.push(c);
    }
  };
  pass();

  const lossOf = (c: Candidate): EvictionHistoryLoss => ({
    undo: Math.max(0, c.undo - droppedUndo),
    redo: Math.max(0, c.redo - droppedRedo),
  });
  const total = (loss: EvictionHistoryLoss) => loss.undo + loss.redo;

  return {
    take() {
      let best: { readonly c: Candidate; readonly loss: EvictionHistoryLoss } | undefined;
      let bestHeap: Heap<Candidate> | undefined;
      for (let at = 0; at < heaps.length; at++) {
        const heap = heaps[at]!;
        let top = heap.peek();
        while (top !== undefined && (!top.open || group(top) !== at)) {
          heap.pop();
          top = heap.peek();
        }
        if (top === undefined) continue;
        const loss = lossOf(top);
        if (
          best === undefined ||
          total(loss) < total(best.loss) ||
          (total(loss) === total(best.loss) && top.index < best.c.index)
        ) {
          best = { c: top, loss };
          bestHeap = heap;
        }
      }
      if (best === undefined || bestHeap === undefined) return undefined;
      bestHeap.pop();
      best.c.open = false;
      return { index: best.c.index, loss: best.loss };
    },
    dropped(loss) {
      droppedUndo += loss.undo;
      droppedRedo += loss.redo;
      pass();
    },
  };
}
