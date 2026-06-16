import type { ReadonlyUint8Array } from "../../types/branded.ts";
import { asReadonlyUint8Array, unwrapReadonlyUint8Array } from "./runtime-readonly.ts";

/**
 * Append-only growable buffer that encapsulates the mutation invariant
 * for the piece table's add buffer.
 *
 * The buffer grows by doubling when capacity is exceeded.
 * Bytes in [0, length) are valid; bytes beyond are uninitialized.
 * Old snapshots sharing the same backing array safely ignore bytes
 * beyond their own `length` boundary.
 */
export class GrowableBuffer {
  #rawBytes: Uint8Array;
  /** Backing storage (may have unused capacity beyond `length`) */
  readonly bytes: ReadonlyUint8Array;
  /** Number of valid bytes in the buffer */
  readonly length: number;

  constructor(bytes: Uint8Array, length: number) {
    this.#rawBytes = bytes;
    this.bytes = asReadonlyUint8Array(bytes);
    this.length = length;
    Object.freeze(this);
  }

  /**
   * Create an empty GrowableBuffer with the given initial capacity.
   */
  static empty(capacity: number = 0): GrowableBuffer {
    return new GrowableBuffer(new Uint8Array(capacity), 0);
  }

  /**
   * Append data to the buffer.
   * Returns a new GrowableBuffer — the backing array is shared when possible
   * (only reallocated when capacity is exceeded).
   */
  append(data: Uint8Array | ReadonlyUint8Array): GrowableBuffer {
    let bytes = this.#rawBytes;
    const source = unwrapReadonlyUint8Array(data);
    if (this.length + source.length > bytes.length) {
      const newSize = Math.max(bytes.length * 2, this.length + source.length);
      const newBytes = new Uint8Array(newSize);
      newBytes.set(bytes.subarray(0, this.length));
      bytes = newBytes;
    }
    bytes.set(source, this.length);
    return new GrowableBuffer(bytes, this.length + source.length);
  }

  /**
   * Zero-copy view into the valid portion of the buffer.
   *
   * Callers must use `this.length` as the bound — not `this.bytes.length` —
   * because the backing array may have uninitialized bytes beyond `length`.
   */
  subarray(start: number, end: number): ReadonlyUint8Array {
    if (process.env.NODE_ENV !== "production") {
      if (start < 0 || end > this.length) {
        throw new Error(
          `GrowableBuffer: out-of-bounds read [${start}, ${end}) exceeds valid length ${this.length}`,
        );
      }
    }
    return asReadonlyUint8Array(this.#rawBytes.subarray(start, end));
  }
}
