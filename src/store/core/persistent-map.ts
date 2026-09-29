/** Immutable ordered map. Updates copy only AVL search paths. */
type Key = string | number;
interface Node<K extends Key, V> {
  readonly key: K;
  readonly value: V;
  readonly left: Node<K, V> | null;
  readonly right: Node<K, V> | null;
  readonly height: number;
}
function node<K extends Key, V>(
  key: K,
  value: V,
  left: Node<K, V> | null,
  right: Node<K, V> | null,
): Node<K, V> {
  return { key, value, left, right, height: 1 + Math.max(left?.height ?? 0, right?.height ?? 0) };
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

export class PersistentMap<K extends string, V> implements ReadonlyMap<K, V> {
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
  static empty<K extends string, V>(): PersistentMap<K, V> {
    return new PersistentMap<K, V>(null, null, 0, 0);
  }
  static from<K extends string, V>(source: ReadonlyMap<K, V>): PersistentMap<K, V> {
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
