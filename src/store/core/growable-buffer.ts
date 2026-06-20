import type { ReadonlyUint8Array } from "../../types/branded.js";
import { asReadonlyUint8Array, unwrapReadonlyUint8Array } from "./runtime-readonly.js";

function isProductionRuntime(): boolean {
  return typeof process !== "undefined" && process.env.NODE_ENV === "production";
}

/**
 * Append-only growable buffer that encapsulates the mutation invariant
 * for the piece table's add buffer.
 *
 * The buffer grows by doubling when capacity is exceeded.
 * Bytes in [0, length) are valid; bytes beyond are private capacity.
 * Public snapshots expose only a stable valid-length view, so old snapshots
 * cannot observe later appends that reuse the private backing array.
 */
export class GrowableBuffer {
  #rawBytes: Uint8Array;
  /** Stable snapshot of the valid bytes in [0, length). */
  readonly bytes: ReadonlyUint8Array;
  /** Number of valid bytes in the buffer */
  readonly length: number;

  constructor(bytes: Uint8Array, length: number) {
    this.#rawBytes = bytes;
    this.bytes = asReadonlyUint8Array(bytes.slice(0, length));
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
   * Zero-copy read-only view into the private backing array.
   */
  subarray(start: number, end: number): ReadonlyUint8Array {
    if (!isProductionRuntime()) {
      if (start < 0 || end > this.length) {
        throw new Error(
          `GrowableBuffer: out-of-bounds read [${start}, ${end}) exceeds valid length ${this.length}`,
        );
      }
    }
    return asReadonlyUint8Array(this.#rawBytes.subarray(start, end));
  }
}
