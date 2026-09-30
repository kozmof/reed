/** Mutable, short-lived endpoint indexes used only while deriving one event. */
interface Endpoint {
  value: number;
  readonly id: number;
  readonly priority: number;
  left: Endpoint | null;
  right: Endpoint | null;
  add: number;
  set: number | undefined;
}

function assign(root: Endpoint | null, value: number): void {
  if (!root) return;
  root.value = value;
  root.set = value;
  root.add = 0;
}

function shift(root: Endpoint | null, delta: number): void {
  if (!root) return;
  root.value += delta;
  root.add += delta;
}

function push(root: Endpoint): void {
  if (root.set !== undefined) {
    assign(root.left, root.set);
    assign(root.right, root.set);
    root.set = undefined;
  }
  if (root.add !== 0) {
    shift(root.left, root.add);
    shift(root.right, root.add);
    root.add = 0;
  }
}

/** Split by coordinate, retaining equal coordinates on the requested side. */
function split(
  root: Endpoint | null,
  value: number,
  equalOnLeft: boolean,
): [Endpoint | null, Endpoint | null] {
  if (!root) return [null, null];
  push(root);
  if (root.value < value || (equalOnLeft && root.value === value)) {
    const [left, right] = split(root.right, value, equalOnLeft);
    root.right = left;
    return [root, right];
  }
  const [left, right] = split(root.left, value, equalOnLeft);
  root.left = right;
  return [left, root];
}

function merge(left: Endpoint | null, right: Endpoint | null): Endpoint | null {
  if (!left) return right;
  if (!right) return left;
  if (left.priority < right.priority) {
    push(left);
    left.right = merge(left.right, right);
    return left;
  }
  push(right);
  right.left = merge(left, right.left);
  return right;
}

interface RemoteRange {
  type: "insert" | "delete";
  start: number;
  end: number;
}

/**
 * Transform intermediate ranges into final document coordinates in expected
 * O(m log m) time and O(m) space. Two randomized treaps hold starts and ends;
 * lazy suffix shifts and interval clamps avoid replaying edits per endpoint.
 * Starts have right affinity, ends left affinity. If a range collapses, its
 * right-affinity start wins over its end when producing the final range.
 */
export function transformRemoteRanges(entries: readonly RemoteRange[]): [number, number][] {
  let starts: Endpoint | null = null;
  let ends: Endpoint | null = null;
  function update(
    root: Endpoint | null,
    entry: RemoteRange,
    startEndpoint: boolean,
  ): Endpoint | null {
    if (entry.type === "insert") {
      const [left, right] = split(root, entry.start, !startEndpoint);
      shift(right, entry.end - entry.start);
      return merge(left, right);
    }
    const [left, rest] = split(root, entry.start, true);
    const [middle, right] = split(rest, entry.end, true);
    assign(middle, entry.start);
    shift(right, entry.start - entry.end);
    return merge(merge(left, middle), right);
  }
  function insert(root: Endpoint | null, value: number, id: number): Endpoint {
    const [left, right] = split(root, value, true);
    const endpoint: Endpoint = {
      value,
      id,
      priority: Math.random(),
      left: null,
      right: null,
      add: 0,
      set: undefined,
    };
    return merge(merge(left, endpoint), right)!;
  }
  for (let id = 0; id < entries.length; id++) {
    const entry = entries[id]!;
    starts = insert(update(starts, entry, true), entry.start, id);
    ends = insert(update(ends, entry, false), entry.end, id);
  }
  const result: [number, number][] = entries.map(() => [0, 0]);
  function collect(root: Endpoint | null, side: 0 | 1): void {
    if (!root) return;
    push(root);
    result[root.id]![side] = root.value;
    collect(root.left, side);
    collect(root.right, side);
  }
  collect(starts, 0);
  collect(ends, 1);
  for (const range of result) range[1] = Math.max(range[0], range[1]);
  return result;
}
