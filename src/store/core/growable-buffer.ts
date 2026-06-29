import type { ReadonlyUint8Array } from "../../types/branded.js";
import { asReadonlyUint8Array, unwrapReadonlyUint8Array } from "./runtime-readonly.js";

/**
 * Tracks which immutable buffer version owns the writable tail of a backing
 * array. Appending from that version is safe because the write starts exactly
 * after its visible prefix. Appending from an older version is a branch and
 * must copy first, or it could overwrite bytes visible through a newer
 * snapshot after a transaction rollback.
 */
const writableTailOwner = new WeakMap<Uint8Array, GrowableBuffer>();

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
    // A fixed-length view plus the tail-owner check in append() isolates
    // snapshots without copying the full valid prefix on every keystroke.
    // Sequential descendants only write beyond this view; stale branches copy
    // before writing into their own backing array.
    this.bytes = asReadonlyUint8Array(bytes.subarray(0, length));
    this.length = length;
    Object.freeze(this);
    writableTailOwner.set(bytes, this);
  }

  /**
   * Create an empty GrowableBuffer with the given initial capacity.
   */
  static empty(capacity: number = 0): GrowableBuffer {
    return new GrowableBuffer(new Uint8Array(capacity), 0);
  }

  /**
   * Append data to the buffer.
   * Returns a new GrowableBuffer. Sequential appends reuse spare capacity;
   * stale branches and capacity growth allocate independent storage.
   */
  append(data: Uint8Array | ReadonlyUint8Array): GrowableBuffer {
    let bytes = this.#rawBytes;
    const source = unwrapReadonlyUint8Array(data);

    const isWritableTailOwner = writableTailOwner.get(bytes) === this;
    if (!isWritableTailOwner || this.length + source.length > bytes.length) {
      // A stale version can be reached after rollback or by branching directly
      // from an older snapshot. Preserve its prefix in a new backing array
      // before writing. For the current tail owner, allocation only happens
      // when normal geometric growth is required.
      const newSize = isWritableTailOwner
        ? Math.max(bytes.length * 2, this.length + source.length)
        : Math.max(bytes.length, this.length + source.length);
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
    if (start < 0 || end > this.length) {
      throw new Error(
        `GrowableBuffer: out-of-bounds read [${start}, ${end}) exceeds valid length ${this.length}`,
      );
    }
    return asReadonlyUint8Array(this.#rawBytes.subarray(start, end));
  }
}
