/** Static centered interval tree. Build once per immutable query snapshot. */
export interface Interval<T> {
  readonly start: number;
  readonly end: number;
  readonly value: T;
}
interface Node<T> {
  center: number;
  starts: readonly Interval<T>[];
  ends: readonly Interval<T>[];
  left: Node<T> | null;
  right: Node<T> | null;
}

export class IntervalIndex<T> {
  readonly #root: Node<T> | null;

  constructor(intervals: readonly Interval<T>[]) {
    function build(sorted: readonly Interval<T>[]): Node<T> | null {
      if (sorted.length === 0) return null;
      const center = sorted[Math.floor(sorted.length / 2)]!.start;
      const left: Interval<T>[] = [];
      const right: Interval<T>[] = [];
      const crossing: Interval<T>[] = [];
      for (const interval of sorted) {
        if (interval.end < center) left.push(interval);
        else if (interval.start > center) right.push(interval);
        else crossing.push(interval);
      }
      return {
        center,
        starts: crossing,
        ends: [...crossing].sort((a, b) => b.end - a.end),
        left: build(left),
        right: build(right),
      };
    }
    this.#root = build([...intervals].sort((a, b) => a.start - b.start));
  }

  /** Half-open containment for points, or the strict overlap predicate for ranges. */
  query(start: number, end: number, point = false): T[] {
    if (Number.isNaN(start) || Number.isNaN(end)) return [];
    const result: T[] = [];
    function visit(node: Node<T> | null): void {
      if (!node) return;
      const beforeEnd = (value: number): boolean => (point ? value <= end : value < end);
      if (!beforeEnd(node.center)) {
        for (const interval of node.starts) {
          if (!beforeEnd(interval.start)) break;
          if (interval.end > start) result.push(interval.value);
        }
        visit(node.left);
      } else if (start >= node.center) {
        for (const interval of node.ends) {
          if (interval.end <= start) break;
          if (beforeEnd(interval.start)) result.push(interval.value);
        }
        visit(node.right);
      } else {
        for (const interval of node.starts) result.push(interval.value);
        visit(node.left);
        visit(node.right);
      }
    }
    visit(this.#root);
    return result;
  }
}
