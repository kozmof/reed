import type { ReadonlyUint8Array } from "../../types/branded.ts";

const READONLY_UINT8_ARRAY_ERROR = "Cannot mutate a read-only Uint8Array";

const UINT8_ARRAY_MUTATORS = new Set([
  "copyWithin",
  "fill",
  "reverse",
  "set",
  "sort",
]);

const rawBytesByReadonly = new WeakMap<ReadonlyUint8Array, Uint8Array>();
const readonlyBytesByRaw = new WeakMap<Uint8Array, ReadonlyUint8Array>();

const rawMapByReadonly = new WeakMap<ReadonlyMap<object, unknown>, Map<object, unknown>>();
const readonlyMapByRaw = new WeakMap<Map<object, unknown>, ReadonlyMap<object, unknown>>();

const rawSetByReadonly = new WeakMap<ReadonlySet<object>, Set<object>>();
const readonlySetByRaw = new WeakMap<Set<object>, ReadonlySet<object>>();

function throwReadonlyUint8ArrayMutation(): never {
  throw new TypeError(READONLY_UINT8_ARRAY_ERROR);
}

export function asReadonlyUint8Array(bytes: Uint8Array | ReadonlyUint8Array): ReadonlyUint8Array {
  if (rawBytesByReadonly.has(bytes as ReadonlyUint8Array)) {
    return bytes as ReadonlyUint8Array;
  }

  const raw = bytes as Uint8Array;
  const cached = readonlyBytesByRaw.get(raw);
  if (cached !== undefined) return cached;

  let proxy!: ReadonlyUint8Array;
  proxy = new Proxy(raw, {
    get(target, prop) {
      if (prop === "buffer") {
        return target.slice().buffer;
      }

      if (prop === "subarray") {
        return (begin?: number, end?: number) =>
          asReadonlyUint8Array(target.subarray(begin, end));
      }

      if (prop === "slice") {
        return (begin?: number, end?: number) => asReadonlyUint8Array(target.slice(begin, end));
      }

      if (prop === "valueOf") {
        return () => proxy;
      }

      if (typeof prop === "string" && UINT8_ARRAY_MUTATORS.has(prop)) {
        return throwReadonlyUint8ArrayMutation;
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set() {
      throwReadonlyUint8ArrayMutation();
    },
    defineProperty() {
      throwReadonlyUint8ArrayMutation();
    },
    deleteProperty() {
      throwReadonlyUint8ArrayMutation();
    },
  }) as unknown as ReadonlyUint8Array;

  rawBytesByReadonly.set(proxy, raw);
  readonlyBytesByRaw.set(raw, proxy);
  return proxy;
}

export function unwrapReadonlyUint8Array(bytes: Uint8Array | ReadonlyUint8Array): Uint8Array {
  return rawBytesByReadonly.get(bytes as ReadonlyUint8Array) ?? (bytes as Uint8Array);
}

class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(map: Map<K, V>) {
    this.#map = map;
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#map.forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this);
    });
  }

  entries(): MapIterator<[K, V]> {
    return this.#map.entries();
  }

  keys(): MapIterator<K> {
    return this.#map.keys();
  }

  values(): MapIterator<V> {
    return this.#map.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#map[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return "Map";
  }
}

export function asReadonlyMap<K, V>(map: Map<K, V> | ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  if (rawMapByReadonly.has(map as ReadonlyMap<object, unknown>)) {
    return map as ReadonlyMap<K, V>;
  }

  const raw = map as Map<object, unknown>;
  const cached = readonlyMapByRaw.get(raw);
  if (cached !== undefined) return cached as ReadonlyMap<K, V>;

  const view = new ReadonlyMapView(map as Map<K, V>);
  rawMapByReadonly.set(view as unknown as ReadonlyMap<object, unknown>, raw);
  readonlyMapByRaw.set(raw, view as unknown as ReadonlyMap<object, unknown>);
  return view;
}

export function isReadonlyMapView<K, V>(map: Map<K, V> | ReadonlyMap<K, V>): boolean {
  return rawMapByReadonly.has(map as ReadonlyMap<object, unknown>);
}

class ReadonlySetView<T> implements ReadonlySet<T> {
  readonly #set: Set<T>;

  constructor(set: Set<T>) {
    this.#set = set;
    Object.freeze(this);
  }

  get size(): number {
    return this.#set.size;
  }

  has(value: T): boolean {
    return this.#set.has(value);
  }

  forEach(
    callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void,
    thisArg?: unknown,
  ): void {
    this.#set.forEach((value) => {
      callbackfn.call(thisArg, value, value, this);
    });
  }

  entries(): SetIterator<[T, T]> {
    return this.#set.entries();
  }

  keys(): SetIterator<T> {
    return this.#set.keys();
  }

  values(): SetIterator<T> {
    return this.#set.values();
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.#set[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return "Set";
  }
}

export function asReadonlySet<T>(set: Set<T> | ReadonlySet<T>): ReadonlySet<T> {
  if (rawSetByReadonly.has(set as ReadonlySet<object>)) {
    return set as ReadonlySet<T>;
  }

  const raw = set as Set<object>;
  const cached = readonlySetByRaw.get(raw);
  if (cached !== undefined) return cached as ReadonlySet<T>;

  const view = new ReadonlySetView(set as Set<T>);
  rawSetByReadonly.set(view as unknown as ReadonlySet<object>, raw);
  readonlySetByRaw.set(raw, view as unknown as ReadonlySet<object>);
  return view;
}

export function isReadonlySetView<T>(set: Set<T> | ReadonlySet<T>): boolean {
  return rawSetByReadonly.has(set as ReadonlySet<object>);
}
