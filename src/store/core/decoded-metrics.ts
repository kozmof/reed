import { pieceBufferRanges } from "./piece-buffer-ranges.js";
/** Composable UTF-8 decoding metrics. Byte lengths stay raw even for malformed input. */
import type { PieceNode, PieceTableState } from "../../types/state.js";

export interface DecodedSummary {
  readonly length: number;
  readonly chars: number;
  readonly head: Uint8Array;
  readonly tail: Uint8Array;
}
const empty: DecodedSummary = {
  length: 0,
  chars: 0,
  head: new Uint8Array(),
  tail: new Uint8Array(),
};
const BLOCK = 4096;
const buffers = new WeakMap<ArrayBufferLike, Map<number, Map<string, DecodedSummary>>>();
const subtrees = new WeakMap<PieceNode, DecodedSummary>();

/** WHATWG replacement semantics, preserving U+FEFF as document content. */
export function decodedCharLength(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let chars = 0;
  for (let i = start; i < end; ) {
    const first = bytes[i++]!;
    let needed =
      first >= 0xc2 && first <= 0xdf
        ? 1
        : first >= 0xe0 && first <= 0xef
          ? 2
          : first >= 0xf0 && first <= 0xf4
            ? 3
            : 0;
    if (needed === 0) {
      chars++;
      continue;
    }
    const width = needed;
    let lower = first === 0xe0 ? 0xa0 : first === 0xf0 ? 0x90 : 0x80;
    let upper = first === 0xed ? 0x9f : first === 0xf4 ? 0x8f : 0xbf;
    while (needed > 0 && i < end && bytes[i]! >= lower && bytes[i]! <= upper) {
      i++;
      needed--;
      lower = 0x80;
      upper = 0xbf;
    }
    chars += needed === 0 && width === 3 ? 2 : 1;
  }
  return chars;
}
function smallJoin(a: Uint8Array, b: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(a.length + b.length);
  bytes.set(a);
  bytes.set(b, a.length);
  return bytes;
}
export function joinDecoded(a: DecodedSummary, b: DecodedSummary): DecodedSummary {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const adjustment =
    (b.head[0]! & 0xc0) === 0x80
      ? decodedCharLength(smallJoin(a.tail, b.head)) -
        decodedCharLength(a.tail) -
        decodedCharLength(b.head)
      : 0;
  return {
    length: a.length + b.length,
    chars: a.chars + b.chars + adjustment,
    head: a.length >= 3 ? a.head : smallJoin(a.head, b.head).slice(0, 3),
    tail: b.length >= 3 ? b.tail : smallJoin(a.tail, b.tail).slice(-3),
  };
}
export function summarizeBytes(bytes: Uint8Array, start = 0, end = bytes.length): DecodedSummary {
  if (start >= end) return empty;
  let views = buffers.get(bytes.buffer);
  if (!views) buffers.set(bytes.buffer, (views = new Map()));
  let cache = views.get(bytes.byteOffset);
  if (!cache) views.set(bytes.byteOffset, (cache = new Map()));
  function visit(offset: number, size: number): DecodedSummary {
    if (offset >= end || offset + size <= start) return empty;
    const full = start <= offset && offset + size <= end;
    const key = offset + ":" + size;
    const cached = full ? cache!.get(key) : undefined;
    if (cached) return cached;
    let result: DecodedSummary;
    if (size <= BLOCK) {
      const from = Math.max(start, offset),
        to = Math.min(end, offset + size);
      result = {
        length: to - from,
        chars: decodedCharLength(bytes, from, to),
        head: bytes.slice(from, Math.min(from + 3, to)),
        tail: bytes.slice(Math.max(from, to - 3), to),
      };
    } else {
      result = joinDecoded(visit(offset, size / 2), visit(offset + size / 2, size / 2));
    }
    // Only complete blocks are immutable under future append-buffer growth.
    if (full) cache!.set(key, result);
    return result;
  }
  const size = BLOCK * 2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(bytes.length / BLOCK))));
  return visit(0, size);
}
export function summarizePieceRange(
  state: PieceTableState,
  start: number,
  end: number,
): DecodedSummary {
  function visit(node: PieceNode | null, offset: number): DecodedSummary {
    if (!node || offset >= end || offset + node.subtreeLength <= start) return empty;
    const full = start <= offset && offset + node.subtreeLength <= end;
    const cached = full ? subtrees.get(node) : undefined;
    if (cached) return cached;
    const pieceStart = offset + (node.left?.subtreeLength ?? 0),
      pieceEnd = pieceStart + node.length;
    const from = Math.max(start, pieceStart),
      to = Math.min(end, pieceEnd);
    let own = empty;
    if (from < to) {
      for (const range of pieceBufferRanges(
        state,
        node,
        node.start + from - pieceStart,
        node.start + to - pieceStart,
      ))
        own = joinDecoded(own, summarizeBytes(range.bytes, range.start, range.end));
    }
    const result = joinDecoded(
      joinDecoded(visit(node.left, offset), own),
      visit(node.right, pieceEnd),
    );
    if (full) subtrees.set(node, result);
    return result;
  }
  return visit(state.root, 0);
}

/** Walk just the intersecting pieces, without collecting the entire tree. */
export function* pieceByteRanges(
  state: PieceTableState,
  start: number,
  end: number,
): Generator<{ bytes: Uint8Array; start: number; end: number; offset: number }> {
  function* visit(
    node: PieceNode | null,
    offset: number,
  ): Generator<{ bytes: Uint8Array; start: number; end: number; offset: number }> {
    if (!node || offset >= end || offset + node.subtreeLength <= start) return;
    const pieceStart = offset + (node.left?.subtreeLength ?? 0),
      pieceEnd = pieceStart + node.length;
    yield* visit(node.left, offset);
    const from = Math.max(start, pieceStart),
      to = Math.min(end, pieceEnd);
    if (from < to) {
      const bufferStart = node.start + from - pieceStart;
      for (const range of pieceBufferRanges(state, node, bufferStart, node.start + to - pieceStart))
        yield { ...range, offset: from + range.offset - bufferStart };
    }
    yield* visit(node.right, pieceEnd);
  }
  yield* visit(state.root, 0);
}
export function scanPieceLines(
  state: PieceTableState,
  start: number,
  end: number,
): Array<{ length: number; charLength: number }> {
  const lines: Array<{ length: number; charLength: number }> = [];
  let lineStart = start;
  let chars = 0;
  let cr = false;
  // Decoder state crosses piece and buffer seams. Count incomplete sequences
  // as one replacement, reconsuming an invalid continuation as a new byte.
  let needed = 0;
  let width = 0;
  let lower = 0x80;
  let upper = 0xbf;
  function flush(position: number): void {
    if (needed > 0) {
      chars++;
      needed = 0;
    }
    lines.push({ length: position - lineStart, charLength: chars });
    lineStart = position;
    chars = 0;
  }
  for (const range of pieceByteRanges(state, start, end)) {
    for (let i = range.start; i < range.end; i++) {
      const byte = range.bytes[i]!;
      const position = range.offset + i - range.start;
      if (cr) {
        cr = false;
        if (byte === 10) {
          chars++;
          flush(position + 1);
          continue;
        }
        flush(position);
      }
      if (needed > 0) {
        if (byte >= lower && byte <= upper) {
          needed--;
          lower = 0x80;
          upper = 0xbf;
          if (needed === 0) chars += width === 3 ? 2 : 1;
          continue;
        }
        chars++;
        needed = 0;
      }
      needed =
        byte >= 0xc2 && byte <= 0xdf
          ? 1
          : byte >= 0xe0 && byte <= 0xef
            ? 2
            : byte >= 0xf0 && byte <= 0xf4
              ? 3
              : 0;
      if (needed > 0) {
        width = needed;
        lower = byte === 0xe0 ? 0xa0 : byte === 0xf0 ? 0x90 : 0x80;
        upper = byte === 0xed ? 0x9f : byte === 0xf4 ? 0x8f : 0xbf;
      } else {
        chars++;
        if (byte === 13) cr = true;
        else if (byte === 10) flush(position + 1);
      }
    }
  }
  if (cr) flush(end);
  flush(end); // Preserve the final empty line after a separator.
  return lines;
}
