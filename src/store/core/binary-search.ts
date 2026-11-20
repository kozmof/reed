/**
 * The first index in [0, count) for which `before` is false, or `count` when
 * there is none. `before` must hold on a prefix of the range and nowhere after
 * it. O(log count) calls to `before`.
 */
export function partitionPoint(count: number, before: (index: number) => boolean): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (before(mid)) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The first index of `values`, sorted ascending, whose value is at least
 * `min`, or `values.length` when there is none. O(log n).
 */
export function lowerBound(values: ArrayLike<number>, min: number): number {
  return partitionPoint(values.length, (index) => values[index]! < min);
}
