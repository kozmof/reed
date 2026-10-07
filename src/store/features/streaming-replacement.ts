import type { PieceTableState } from "../../types/state.js";
import type { DocumentAction } from "../../types/actions.js";
import { byteOffset } from "../../types/branded.js";
import { pieceByteRanges } from "../core/decoded-metrics.js";
import { isSurrogatePairAt, textEncoder, utf8ByteLength } from "../core/encoding.js";
import { isUtf8Boundary } from "../core/piece-table.js";
import { DocumentActions } from "./actions.js";

/** A cursor holds buffer views, never a flattened copy of the document. */
function byteReader(state: PieceTableState, start: number): () => number {
  const ranges = pieceByteRanges(state, start, state.totalLength);
  let range = ranges.next();
  let offset = range.done ? 0 : range.value.start;
  return () => {
    if (!range.done && offset === range.value.end) {
      range = ranges.next();
      offset = range.done ? 0 : range.value.start;
    }
    return range.done ? -1 : range.value.bytes[offset++]!;
  };
}

/** Find a single replacement using bounded encoding buffers and two forward cursors. */
export function streamingReplacement(state: PieceTableState, text: string): DocumentAction[] {
  const length = utf8ByteLength(text);
  const delta = state.totalLength - length;
  const prefixByte = byteReader(state, 0);
  const suffixByte = byteReader(state, Math.max(0, delta));
  let prefix = 0;
  let matchingPrefix = true;
  let newEnd = 0;
  let position = 0;
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + 16384);
    if (end < text.length && isSurrogatePairAt(text, end - 1)) end--;
    const bytes = textEncoder.encode(text.slice(start, end));
    for (const byte of bytes) {
      if (matchingPrefix) {
        matchingPrefix = prefixByte() === byte;
        if (matchingPrefix) prefix++;
      }
      // Align this cursor with the document's end. The last mismatch bounds
      // the replacement; later equal bytes form the common suffix.
      if (position + delta < 0 || suffixByte() !== byte) newEnd = position + 1;
      position++;
    }
    start = end;
  }
  if (prefix === length && delta === 0) return [];
  newEnd = Math.max(newEnd, prefix, prefix - delta);

  // Byte comparisons may stop inside a code point. Choose boundaries in both
  // strings and retain UTF-16 indices for slicing the replacement text.
  let charStart = 0;
  let byteStart = 0;
  let charEnd = text.length;
  let byteEnd = length;
  let bytes = 0;
  for (let i = 0; ; ) {
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
