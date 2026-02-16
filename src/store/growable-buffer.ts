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
  /** Backing storage (may have unused capacity beyond `length`) */
  readonly bytes: Uint8Array;
  /** Number of valid bytes in the buffer */
  readonly length: number;

  constructor(bytes: Uint8Array, length: number) {
    this.bytes = bytes;
    this.length = length;
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
  append(data: Uint8Array): GrowableBuffer {
    let bytes = this.bytes;
    if (this.length + data.length > bytes.length) {
      const newSize = Math.max(bytes.length * 2, this.length + data.length);
      const newBytes = new Uint8Array(newSize);
      newBytes.set(bytes.subarray(0, this.length));
      bytes = newBytes;
    }
    bytes.set(data, this.length);
    return new GrowableBuffer(bytes, this.length + data.length);
  }

  /**
   * Zero-copy view into the valid portion of the buffer.
   */
  subarray(start: number, end: number): Uint8Array {
    return this.bytes.subarray(start, end);
  }
}
