import type { PieceTableState } from "../../types/state.js";
import type { DocumentAction } from "../../types/actions.js";
import { byteOffset } from "../../types/branded.js";
import { pieceByteRanges } from "../core/decoded-metrics.js";
import { isSurrogatePairAt, textEncoder, utf8ByteLength } from "../core/encoding.js";
import { isUtf8Boundary } from "../core/piece-table.js";
import { DocumentActions } from "./actions.js";

const CHUNK_CHARS = 16384;

interface ByteRange {
  bytes: Uint8Array;
  start: number;
  end: number;
}

/**
 * Length of the common prefix of the document bytes and the encoded text,
 * with the char/byte position of the text chunk where the scan stopped.
 * Encodes and compares one chunk at a time and stops at the first mismatch.
 */
function commonPrefix(
  ranges: readonly ByteRange[],
  text: string,
): { prefix: number; chunkChar: number; chunkByte: number } {
  let ri = 0;
  let offset = ranges[0]?.start ?? 0;
  let prefix = 0;
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    if (end < text.length && isSurrogatePairAt(text, end - 1)) end--;
    const chunkByte = prefix;
    const encoded = textEncoder.encode(text.slice(start, end));
    let k = 0;
    while (k < encoded.length) {
      if (ri === ranges.length) return { prefix, chunkChar: start, chunkByte };
      const range = ranges[ri]!;
      const bytes = range.bytes;
      const count = Math.min(encoded.length - k, range.end - offset);
      for (let j = 0; j < count; j++) {
        if (bytes[offset + j] !== encoded[k + j]) {
          return { prefix: prefix + j, chunkChar: start, chunkByte };
        }
      }
      prefix += count;
      k += count;
      offset += count;
      if (offset === range.end && ++ri < ranges.length) offset = ranges[ri]!.start;
    }
    start = end;
  }
  return { prefix, chunkChar: text.length, chunkByte: prefix };
}

/**
 * Length of the common suffix, up to `limit` bytes, scanning both the
 * document ranges and the text backwards. Stops at the first mismatch.
 */
function commonSuffix(ranges: readonly ByteRange[], text: string, limit: number): number {
  let ri = ranges.length - 1;
  let offset = ranges[ri]?.end ?? 0;
  let suffix = 0;
  for (let end = text.length; end > 0 && suffix < limit; ) {
    let start = Math.max(0, end - CHUNK_CHARS);
    if (start > 0 && isSurrogatePairAt(text, start - 1)) start--;
    const encoded = textEncoder.encode(text.slice(start, end));
    let k = encoded.length;
    while (k > 0) {
      if (ri < 0 || suffix === limit) return suffix;
      const range = ranges[ri]!;
      const bytes = range.bytes;
      const count = Math.min(k, offset - range.start, limit - suffix);
      for (let j = 1; j <= count; j++) {
        if (bytes[offset - j] !== encoded[k - j]) return suffix + j - 1;
      }
      suffix += count;
      k -= count;
      offset -= count;
      if (offset === range.start && --ri >= 0) offset = ranges[ri]!.end;
    }
    end = start;
  }
  return suffix;
}

/**
 * Find a single replacement with bounded encoding buffers. The prefix scan
 * runs forward and the suffix scan backward, each stopping at the first
 * mismatch, so unchanged regions are read once and compared in tight loops
 * over buffer ranges. Char positions are found by walking only from the chunk
 * where the prefix ended.
 */
export function streamingReplacement(state: PieceTableState, text: string): DocumentAction[] {
  const length = utf8ByteLength(text);
  const delta = state.totalLength - length;
  const ranges: ByteRange[] = [];
  for (const range of pieceByteRanges(state, 0, state.totalLength)) {
    if (range.end > range.start) ranges.push(range);
  }
  const { prefix, chunkChar, chunkByte } = commonPrefix(ranges, text);
  if (prefix === length && delta === 0) return [];
  const suffix = commonSuffix(ranges, text, Math.min(state.totalLength, length) - prefix);
  const newEnd = length - suffix;

  // Byte comparisons may stop inside a code point. Choose boundaries in both
  // strings and retain UTF-16 indices for slicing the replacement text.
  // Every char before chunkChar ends at or before the prefix, so the walk can
  // start there.
  let charStart = chunkChar;
  let byteStart = chunkByte;
  let charEnd = text.length;
  let byteEnd = length;
  let bytes = chunkByte;
  for (let i = chunkChar; ; ) {
    if (bytes <= prefix) {
      charStart = i;
      byteStart = bytes;
    }
    if (bytes >= newEnd && isUtf8Boundary(state, byteOffset(bytes + delta))) {
      charEnd = i;
      byteEnd = bytes;
      break;
    }
    if (i === text.length) break;
    const code = text.charCodeAt(i);
    const paired = isSurrogatePairAt(text, i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : paired ? 4 : 3;
    i += paired ? 2 : 1;
  }
  while (charStart > 0 && !isUtf8Boundary(state, byteOffset(byteStart))) {
    let previous = charStart - 1;
    if (previous > 0 && isSurrogatePairAt(text, previous - 1)) previous--;
    byteStart -= utf8ByteLength(text.slice(previous, charStart));
    charStart = previous;
  }
  const start = byteOffset(byteStart);
  const end = byteOffset(byteEnd + delta);
  const inserted = text.slice(charStart, charEnd);
  if (start === end) return [DocumentActions.insert(start, inserted)];
  if (inserted.length === 0) return [DocumentActions.delete(start, end)];
  return [DocumentActions.replace(start, end, inserted)];
}
