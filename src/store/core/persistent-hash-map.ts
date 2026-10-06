import { PersistentMap } from "./persistent-map.js";

type Trie<K extends string, V> =
  | { readonly hash: number; readonly entries: PersistentMap<K, V> }
  | { readonly children: readonly (Trie<K, V> | undefined)[] };

function hashKey(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  return hash >>> 0;
}

function put<K extends string, V>(
  root: Trie<K, V> | undefined,
  hash: number,
  key: K,
  value: V,
  shift: number,
): Trie<K, V> {
  if (!root) return { hash, entries: PersistentMap.empty<K, V>().with(key, value) };
  if ("hash" in root) {
    if (root.hash === hash) {
      const entries = root.entries.with(key, value);
      return entries === root.entries ? root : { hash, entries };
    }
    const children: (Trie<K, V> | undefined)[] = [];
    children[(root.hash >>> shift) & 31] = root;
    root = { children };
  }
  const slot = (hash >>> shift) & 31;
  const child = put(root.children[slot], hash, key, value, shift + 5);
  if (child === root.children[slot]) return root;
  const children = root.children.slice();
  children[slot] = child;
  return { children };
}

function remove<K extends string, V>(
  root: Trie<K, V> | undefined,
  hash: number,
  key: K,
  shift: number,
): Trie<K, V> | undefined {
  if (!root) return root;
  if ("hash" in root) {
    if (root.hash !== hash) return root;
    const entries = root.entries.without(key);
    return entries === root.entries ? root : entries.size === 0 ? undefined : { hash, entries };
  }
  const slot = (hash >>> shift) & 31;
  const child = remove(root.children[slot], hash, key, shift + 5);
  if (child === root.children[slot]) return root;
  const children = root.children.slice();
  children[slot] = child;
  let only: Trie<K, V> | undefined;
  for (const entry of children) {
    if (!entry) continue;
    if (only) return { children };
    only = entry;
  }
  // A leaf can move up because it retains its complete hash. Branches cannot:
  // their slots describe a particular group of five hash bits.
  return only && !("hash" in only) ? { children } : only;
}

/**
 * Unordered persistent string index. Hash paths have at most seven levels;
 * edits copy only that path. Equal hashes use AVL buckets, keeping adversarial
 * collisions O(log C), where C is the bucket size. With bounded key lengths
 * and well-distributed hashes, lookup and updates take expected O(1) work.
 */
export class PersistentHashMap<K extends string, V> {
  readonly #root: Trie<K, V> | undefined;
  private constructor(root: Trie<K, V> | undefined) {
    this.#root = root;
    Object.freeze(this);
  }
  static empty<K extends string, V>(): PersistentHashMap<K, V> {
    return new PersistentHashMap<K, V>(undefined);
  }
  get(key: K): V | undefined {
    const hash = hashKey(key);
    let root = this.#root;
    let shift = 0;
    while (root && !("hash" in root)) {
      root = root.children[(hash >>> shift) & 31];
      shift += 5;
    }
    return root?.hash === hash ? root.entries.get(key) : undefined;
  }
  with(key: K, value: V): PersistentHashMap<K, V> {
    const root = put(this.#root, hashKey(key), key, value, 0);
    return root === this.#root ? this : new PersistentHashMap(root);
  }
  without(key: K): PersistentHashMap<K, V> {
    const root = remove(this.#root, hashKey(key), key, 0);
    return root === this.#root ? this : new PersistentHashMap(root);
  }
}
