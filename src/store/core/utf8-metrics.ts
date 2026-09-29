/** Sparse UTF-16 prefix counts over immutable UTF-8 buffer prefixes. */
const BLOCK = 4096;
const indexes = new WeakMap<ArrayBufferLike, Map<number, number[]>>();

function indexFor(bytes: Uint8Array): number[] {
  let views = indexes.get(bytes.buffer);
  if (!views) indexes.set(bytes.buffer, (views = new Map()));
  let counts = views.get(bytes.byteOffset);
  if (!counts) views.set(bytes.byteOffset, (counts = [0]));
  return counts;
}

function count(bytes: Uint8Array, start: number, end: number): number {
  let chars = 0;
  for (let i = start; i < end; i++) {
    const b = bytes[i]!;
    if (b < 0x80 || b >= 0xc0) chars += b >= 0xf0 ? 2 : 1;
  }
  return chars;
}

/** Positions may be inside a sequence; callers snap returned positions to boundaries. */
export function bufferCharPrefix(bytes: Uint8Array, end: number): number {
  const counts = indexFor(bytes);
  const block = Math.floor(end / BLOCK);
  while (counts.length <= block) {
    const start = (counts.length - 1) * BLOCK;
    counts.push(counts[counts.length - 1]! + count(bytes, start, start + BLOCK));
  }
  return counts[block]! + count(bytes, block * BLOCK, end);
}

/** Build once at load time, keeping cold long-line queries bounded too. */
export function prepareBufferMetrics(bytes: Uint8Array): void {
  bufferCharPrefix(bytes, bytes.length);
}

/** Growth/branch copies preserve the immutable prefix and its sparse index. */
export function carryBufferMetrics(source: Uint8Array, target: Uint8Array, length: number): void {
  const counts = indexes.get(source.buffer)?.get(source.byteOffset);
  if (!counts) return;
  let views = indexes.get(target.buffer);
  if (!views) indexes.set(target.buffer, (views = new Map()));
  views.set(target.byteOffset, counts.slice(0, Math.floor(length / BLOCK) + 1));
}

/** Seek by UTF-16 count, scanning at most one sparse block plus a sequence tail. */
export function bufferByteAtChar(bytes: Uint8Array, target: number): number {
  prepareBufferMetrics(bytes);
  const counts = indexFor(bytes);
  let lo = 0,
    hi = counts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (counts[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  let position = lo * BLOCK;
  let chars = counts[lo]!;
  while (position < bytes.length && chars < target) {
    const b = bytes[position++]!;
    if (b < 0x80 || b >= 0xc0) chars += b >= 0xf0 ? 2 : 1;
  }
  while (position < bytes.length && (bytes[position]! & 0xc0) === 0x80) position++;
  return position;
}

/** Tiny pieces need only their own bytes, not two whole checkpoint tails. */
export function bufferCharLength(bytes: Uint8Array, start: number, end: number): number {
  return end - start < BLOCK
    ? count(bytes, start, end)
    : bufferCharPrefix(bytes, end) - bufferCharPrefix(bytes, start);
}
