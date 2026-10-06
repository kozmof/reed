import { carryBufferMetrics } from "./utf8-metrics.js";
import type { ReadonlyUint8Array } from "../../types/branded.js";
import { asReadonlyUint8Array, unwrapReadonlyUint8Array } from "./runtime-readonly.js";

interface Segment {
  readonly bytes: Uint8Array;
  readonly left: Segment | null;
  readonly right: Segment | null;
  readonly height: number;
  readonly length: number;
}
function node(bytes: Uint8Array, left: Segment | null, right: Segment | null): Segment {
  return {
    bytes,
    left,
    right,
    height: 1 + Math.max(left?.height ?? 0, right?.height ?? 0),
    length: (left?.length ?? 0) + bytes.length + (right?.length ?? 0),
  };
}
/** Persistent AVL append; only the rightmost search path changes. */
function appendSegment(root: Segment | null, bytes: Uint8Array): Segment | null {
  if (bytes.length === 0) return root;
  if (!root) return node(bytes, null, null);
  const right = appendSegment(root.right, bytes)!;
  if (right.height > (root.left?.height ?? 0) + 1) {
    if ((right.left?.height ?? 0) > (right.right?.height ?? 0)) {
      const middle = right.left!;
      return node(
        middle.bytes,
        node(root.bytes, root.left, middle.left),
        node(right.bytes, middle.right, right.right),
      );
    }
    return node(right.bytes, node(root.bytes, root.left, right.left), right.right);
  }
  return node(root.bytes, root.left, right);
}
const tailOwners = new WeakMap<Uint8Array, GrowableBuffer>();
const flatViews = new WeakMap<GrowableBuffer, ReadonlyUint8Array>();
const MAX_TAIL_BYTES = 65536;

/** Append-only segments share immutable prefixes across snapshot branches. */
export class GrowableBuffer {
  #prefix: Segment | null = null;
  #tail: Uint8Array;
  #tailLength: number;
  readonly length: number;

  constructor(bytes: Uint8Array, length: number) {
    this.#tail = bytes;
    this.#tailLength = length;
    this.length = length;
    tailOwners.set(bytes, this);
    Object.freeze(this);
  }

  /** Contiguous compatibility view, materialized only when explicitly requested. */
  get bytes(): ReadonlyUint8Array {
    let bytes = flatViews.get(this);
    if (!bytes) {
      bytes = this.subarray(0, this.length);
      flatViews.set(this, bytes);
    }
    return bytes;
  }

  static empty(capacity: number = 0): GrowableBuffer {
    return new GrowableBuffer(new Uint8Array(capacity), 0);
  }

  append(data: Uint8Array | ReadonlyUint8Array): GrowableBuffer {
    const source = unwrapReadonlyUint8Array(data);
    if (source.length === 0) return this;
    let prefix = this.#prefix;
    let tail = this.#tail;
    let tailLength = this.#tailLength;
    const required = tailLength + source.length;
    if (tailOwners.get(tail) !== this || (required > tail.length && required > MAX_TAIL_BYTES)) {
      // Seal this version's tail without copying it. Other branches may only
      // write beyond the sealed view. Logical offsets remain snapshot-local.
      prefix = appendSegment(prefix, tail.subarray(0, tailLength));
      tail = new Uint8Array(Math.max(1024, source.length));
      tailLength = 0;
    } else if (required > tail.length) {
      const grown = new Uint8Array(Math.min(MAX_TAIL_BYTES, Math.max(tail.length * 2, required)));
      grown.set(tail.subarray(0, tailLength));
      carryBufferMetrics(tail, grown, tailLength);
      tail = grown;
    }
    tail.set(source, tailLength);
    const result = new GrowableBuffer(tail, this.length + source.length);
    result.#prefix = prefix;
    result.#tailLength = tailLength + source.length;
    return result;
  }

  /** Read immutable segment views without flattening unrelated bytes. */
  *ranges(
    start: number,
    end: number,
  ): Generator<{
    bytes: ReadonlyUint8Array;
    start: number;
    end: number;
    offset: number;
  }> {
    if (start < 0 || end > this.length || start > end) {
      throw new Error(
        `GrowableBuffer: out-of-bounds read [${start}, ${end}) exceeds valid length ${this.length}`,
      );
    }
    function* visit(
      root: Segment | null,
      offset: number,
    ): Generator<{
      bytes: ReadonlyUint8Array;
      start: number;
      end: number;
      offset: number;
    }> {
      if (!root || offset >= end || offset + root.length <= start) return;
      const ownStart = offset + (root.left?.length ?? 0);
      yield* visit(root.left, offset);
      const from = Math.max(start, ownStart),
        to = Math.min(end, ownStart + root.bytes.length);
      if (from < to)
        yield {
          bytes: asReadonlyUint8Array(root.bytes),
          start: from - ownStart,
          end: to - ownStart,
          offset: from,
        };
      yield* visit(root.right, ownStart + root.bytes.length);
    }
    yield* visit(this.#prefix, 0);
    const tailStart = this.#prefix?.length ?? 0;
    const from = Math.max(start, tailStart);
    if (from < end)
      yield {
        bytes: asReadonlyUint8Array(this.#tail.subarray(0, this.#tailLength)),
        start: from - tailStart,
        end: end - tailStart,
        offset: from,
      };
  }

  /** Zero-copy for one segment; cross-segment reads allocate only their range. */
  subarray(start: number, end: number): ReadonlyUint8Array {
    const ranges = this.ranges(start, end);
    const first = ranges.next();
    if (first.done) return asReadonlyUint8Array(new Uint8Array());
    const range = first.value;
    const bytes = unwrapReadonlyUint8Array(range.bytes);
    if (range.end - range.start === end - start)
      return asReadonlyUint8Array(bytes.subarray(range.start, range.end));
    const result = new Uint8Array(end - start);
    result.set(bytes.subarray(range.start, range.end));
    for (const next of ranges)
      result.set(
        unwrapReadonlyUint8Array(next.bytes).subarray(next.start, next.end),
        next.offset - start,
      );
    return asReadonlyUint8Array(result);
  }
}
