import { unwrapReadonlyMap, unwrapReadonlySet } from "./runtime-readonly.js";
/** Immutable ordered map. Updates copy only AVL search paths. */
type Key = string | number;
interface Node<K extends Key, V> {
  readonly key: K;
  readonly value: V;
  readonly left: Node<K, V> | null;
  readonly right: Node<K, V> | null;
  readonly height: number;
  readonly minKey: K;
}
function node<K extends Key, V>(
  key: K,
  value: V,
  left: Node<K, V> | null,
  right: Node<K, V> | null,
): Node<K, V> {
  return {
    key,
    value,
    left,
    right,
    height: 1 + Math.max(left?.height ?? 0, right?.height ?? 0),
    minKey: left?.minKey ?? key,
  };
}
function balance<K extends Key, V>(
  key: K,
  value: V,
  left: Node<K, V> | null,
  right: Node<K, V> | null,
): Node<K, V> {
  if ((left?.height ?? 0) > (right?.height ?? 0) + 1) {
    const l = left!;
    if ((l.left?.height ?? 0) >= (l.right?.height ?? 0))
      return node(l.key, l.value, l.left, node(key, value, l.right, right));
    const m = l.right!;
    return node(
      m.key,
      m.value,
      node(l.key, l.value, l.left, m.left),
      node(key, value, m.right, right),
    );
  }
  if ((right?.height ?? 0) > (left?.height ?? 0) + 1) {
    const r = right!;
    if ((r.right?.height ?? 0) >= (r.left?.height ?? 0))
      return node(r.key, r.value, node(key, value, left, r.left), r.right);
    const m = r.left!;
    return node(
      m.key,
      m.value,
      node(key, value, left, m.left),
      node(r.key, r.value, m.right, r.right),
    );
  }
  return node(key, value, left, right);
}
function put<K extends Key, V>(root: Node<K, V> | null, key: K, value: V): Node<K, V> {
  if (!root) return node(key, value, null, null);
  if (key === root.key) return node(key, value, root.left, root.right);
  return key < root.key
    ? balance(root.key, root.value, put(root.left, key, value), root.right)
    : balance(root.key, root.value, root.left, put(root.right, key, value));
}
function remove<K extends Key, V>(root: Node<K, V> | null, key: K): Node<K, V> | null {
  if (!root) return null;
  if (key < root.key) return balance(root.key, root.value, remove(root.left, key), root.right);
  if (key > root.key) return balance(root.key, root.value, root.left, remove(root.right, key));
  if (!root.left) return root.right;
  if (!root.right) return root.left;
  let successor = root.right;
  while (successor.left) successor = successor.left;
  return balance(successor.key, successor.value, root.left, remove(root.right, successor.key));
}
function find<K extends Key, V>(root: Node<K, V> | null, key: K): V | undefined {
  while (root) {
    if (key === root.key) return root.value;
    root = key < root.key ? root.left : root.right;
  }
  return undefined;
}
function* iterate<K extends Key, V>(root: Node<K, V> | null): Generator<V> {
  const stack: Node<K, V>[] = [];
  let current = root;
  while (current || stack.length) {
    while (current) {
      stack.push(current);
      current = current.left;
    }
    const next = stack.pop()!;
    yield next.value;
    current = next.right;
  }
}

/** Merge ordered trees, skipping identical pending subtrees before expanding them. */
function differentEntries<K extends Key, V>(
  next: Node<number, readonly [K, V]> | null,
  previous: Node<number, readonly [K, V]> | null,
): [Array<readonly [K, V]>, Array<readonly [K, V]>] {
  type Task = { node: Node<number, readonly [K, V]>; entry: boolean };
  const a: Task[] = next ? [{ node: next, entry: false }] : [];
  const b: Task[] = previous ? [{ node: previous, entry: false }] : [];
  const added: Array<readonly [K, V]> = [];
  const removed: Array<readonly [K, V]> = [];
  const advance = (stack: Task[], result: Array<readonly [K, V]>): void => {
    const { node, entry } = stack.pop()!;
    if (entry) result.push(node.value);
    else {
      if (node.right) stack.push({ node: node.right, entry: false });
      stack.push({ node, entry: true });
      if (node.left) stack.push({ node: node.left, entry: false });
    }
  };
  while (a.length || b.length) {
    const x = a[a.length - 1];
    const y = b[b.length - 1];
    if (!x) {
      advance(b, removed);
      continue;
    }
    if (!y) {
      advance(a, added);
      continue;
    }
    if (x.node === y.node && x.entry === y.entry) {
      a.pop();
      b.pop();
      continue;
    }
    const xKey = x.entry ? x.node.key : x.node.minKey;
    const yKey = y.entry ? y.node.key : y.node.minKey;
    if (xKey < yKey) advance(a, added);
    else if (yKey < xKey) advance(b, removed);
    else if (x.entry && y.entry) {
      if (x.node.value[0] !== y.node.value[0] || x.node.value[1] !== y.node.value[1]) {
        added.push(x.node.value);
        removed.push(y.node.value);
      }
      a.pop();
      b.pop();
    } else if (!x.entry && (y.entry || x.node.height >= y.node.height)) {
      advance(a, added);
    } else advance(b, removed);
  }
  return [added, removed];
}

export class PersistentMap<K extends Key, V> implements ReadonlyMap<K, V> {
  readonly #byKey: Node<K, { readonly value: V; readonly order: number }> | null;
  readonly #byOrder: Node<number, readonly [K, V]> | null;
  readonly #nextOrder: number;
  readonly size: number;

  private constructor(
    byKey: Node<K, { readonly value: V; readonly order: number }> | null,
    byOrder: Node<number, readonly [K, V]> | null,
    nextOrder: number,
    size: number,
  ) {
    this.#byKey = byKey;
    this.#byOrder = byOrder;
    this.#nextOrder = nextOrder;
    this.size = size;
    Object.freeze(this);
  }
  static empty<K extends Key, V>(): PersistentMap<K, V> {
    return new PersistentMap<K, V>(null, null, 0, 0);
  }
  static from<K extends Key, V>(source: ReadonlyMap<K, V>): PersistentMap<K, V> {
    source = unwrapReadonlyMap(source);
    if (source instanceof PersistentMap) return source;
    let result = PersistentMap.empty<K, V>();
    for (const [key, value] of source) result = result.with(key, value);
    return result;
  }
  with(key: K, value: V): PersistentMap<K, V> {
    const previous = find(this.#byKey, key);
    if (previous && previous.value === value) return this;
    const order = previous?.order ?? this.#nextOrder;
    return new PersistentMap(
      put(this.#byKey, key, { value, order }),
      put(this.#byOrder, order, [key, value]),
      this.#nextOrder + (previous ? 0 : 1),
      this.size + (previous ? 0 : 1),
    );
  }
  without(key: K): PersistentMap<K, V> {
    const previous = find(this.#byKey, key);
    if (!previous) return this;
    return new PersistentMap(
      remove(this.#byKey, key),
      remove(this.#byOrder, previous.order),
      this.#nextOrder,
      this.size - 1,
    );
  }
  /** Return changed/added keys in next insertion order, then deleted keys.
   * Merge insertion-order trees and skip shared subtrees, including across
   * rotations. Each expanded node is visited once, with no nested AVL searches.
   * Temporary hash maps match keys that moved after deletion and reinsertion.
   */
  changedKeys(previous: PersistentMap<K, V>): K[] {
    const [nextEntries, previousEntries] = differentEntries(this.#byOrder, previous.#byOrder);
    const nextByKey = new Map(nextEntries);
    const previousByKey = new Map(previousEntries);
    const changed: K[] = [];
    for (const [key, value] of nextEntries)
      if (!previousByKey.has(key) || previousByKey.get(key) !== value) changed.push(key);
    for (const [key] of previousEntries) if (!nextByKey.has(key)) changed.push(key);
    return changed;
  }
  get(key: K): V | undefined {
    return find(this.#byKey, key)?.value;
  }
  has(key: K): boolean {
    return find(this.#byKey, key) !== undefined;
  }
  *entries(): MapIterator<[K, V]> {
    for (const [key, value] of iterate(this.#byOrder)) yield [key, value];
  }
  *keys(): MapIterator<K> {
    for (const [key] of iterate(this.#byOrder)) yield key;
  }
  *values(): MapIterator<V> {
    for (const [, value] of iterate(this.#byOrder)) yield value;
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
  get [Symbol.toStringTag](): string {
    return "Map";
  }
}

/** Immutable insertion-ordered set for the loaded-chunk history. */
export class PersistentSet<T extends Key> implements ReadonlySet<T> {
  readonly #map: PersistentMap<T, true>;
  private constructor(map: PersistentMap<T, true>) {
    this.#map = map;
    Object.freeze(this);
  }
  static from<T extends Key>(source: ReadonlySet<T>): PersistentSet<T> {
    source = unwrapReadonlySet(source);
    if (source instanceof PersistentSet) return source;
    let map = PersistentMap.empty<T, true>();
    for (const value of source) map = map.with(value, true);
    return new PersistentSet(map);
  }
  with(value: T): PersistentSet<T> {
    return new PersistentSet(this.#map.with(value, true));
  }
  get size(): number {
    return this.#map.size;
  }
  has(value: T): boolean {
    return this.#map.has(value);
  }
  keys(): SetIterator<T> {
    return this.#map.keys();
  }
  values(): SetIterator<T> {
    return this.#map.keys();
  }
  *entries(): SetIterator<[T, T]> {
    for (const key of this.#map.keys()) yield [key, key];
  }
  [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }
  forEach(callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const key of this.#map.keys()) callback.call(thisArg, key, key, this);
  }
  get [Symbol.toStringTag](): string {
    return "Set";
  }
}
