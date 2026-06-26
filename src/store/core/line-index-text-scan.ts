/**
 * Pure text/boundary scanning helpers for the line index.
 *
 * These functions inspect raw strings (and optional one-character boundary
 * context) to locate line breaks and reason about CR/LF/CRLF boundaries. They
 * hold no tree state and depend on nothing else in the line-index module, so
 * they live here as a leaf module to keep `line-index.ts` focused on tree
 * maintenance. All are internal — not part of the public API.
 */

import { byteOffset, type ByteOffset } from "../../types/branded.js";
import type { ReadTextFn, DeleteBoundaryContext } from "../../types/operations.js";
import { isSurrogatePairAt } from "./encoding.js";

/**
 * Find byte-offset positions of all line breaks in text,
 * and compute the total UTF-8 byte length.
 *
 * Supports LF (\n), CR (\r), and CRLF (\r\n) line endings.
 * For CRLF, records the position of '\n' so the break width is included.
 *
 * Uses charCodeAt instead of textEncoder.encode to avoid allocating a Uint8Array
 * on every call (hot path: invoked on every insert). This is correct because
 * 0x0A (\n) and 0x0D (\r) are single-byte ASCII and never appear in UTF-8
 * continuation bytes — so character index equals byte index for these code points.
 * Non-ASCII characters are accounted for in the running byteLen accumulator using
 * the standard UTF-8 width rules (1/2/3/4 bytes per code point).
 */
export function findNewlineBytePositions(text: string): {
  positions: number[];
  byteLength: number;
} {
  const positions: number[] = [];
  let byteLen = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d) {
      const next = text.charCodeAt(i + 1);
      if (next === 0x0a) {
        // CRLF: record position of the '\n' byte (byteLen + 1)
        positions.push(byteLen + 1);
        byteLen += 2;
        i++;
      } else {
        positions.push(byteLen);
        byteLen += 1;
      }
    } else if (c === 0x0a) {
      positions.push(byteLen);
      byteLen += 1;
    } else if (c < 0x80) {
      byteLen += 1;
    } else if (c < 0x800) {
      byteLen += 2;
    } else if (isSurrogatePairAt(text, i)) {
      // Valid surrogate pairs are 4 bytes in UTF-8 and span two UTF-16 code units.
      byteLen += 4;
      i++;
    } else {
      // Lone surrogates (unpaired 0xD800–0xDBFF or any 0xDC00–0xDFFF) are
      // counted as 3 bytes. TextEncoder.encode() also produces 3-byte sequences
      // for lone surrogates, so the byte-length accounting here is correct for
      // round-trip UTF-8 sizing. No additional guard is needed.
      byteLen += 3;
    }
  }
  return { positions, byteLength: byteLen };
}

/**
 * Count logical line breaks in text.
 * Treats LF, CR, and CRLF as one line break each.
 * Shared between eager and lazy delete operations.
 */
export function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\r") {
      count++;
      if (i + 1 < text.length && text[i + 1] === "\n") {
        i++;
      }
    } else if (text[i] === "\n") {
      count++;
    }
  }
  return count;
}

/**
 * Count how many logical line breaks are actually removed by a delete.
 * Uses optional one-char boundary context to correctly handle partial CRLF deletes.
 *
 * The context is needed when `lineIndexDelete`/`lineIndexDeleteLazy` is called
 * directly (e.g. in tests or undo/redo) with boundary characters that span a CRLF.
 * For example, deleting '\r' when nextChar='\n' removes 0 net line breaks (the
 * CRLF becomes a lone LF, which is still 1 line break). The before/after string
 * approach handles all such boundary effects correctly without special-casing.
 */
export function countDeletedLineBreaks(
  deletedText: string,
  context?: DeleteBoundaryContext,
): number {
  if (context === undefined || (context.prevChar === undefined && context.nextChar === undefined)) {
    return countNewlines(deletedText);
  }

  const before = `${context.prevChar ?? ""}${deletedText}${context.nextChar ?? ""}`;
  const after = `${context.prevChar ?? ""}${context.nextChar ?? ""}`;
  return Math.max(0, countNewlines(before) - countNewlines(after));
}

/**
 * Find UTF-16 positions of line-break endpoints in a string.
 * Supports LF, CR, and CRLF.
 */
export function findNewlineCharPositions(text: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\r") {
      if (i + 1 < text.length && text[i + 1] === "\n") {
        positions.push(i + 1);
        i++;
      } else {
        positions.push(i);
      }
    } else if (text[i] === "\n") {
      positions.push(i);
    }
  }
  return positions;
}

export interface InsertBoundaryContext {
  prevChar?: string | undefined;
  nextChar?: string | undefined;
}

export function getInsertBoundaryContext(
  position: ByteOffset,
  insertedByteLength: number,
  readText?: ReadTextFn,
): InsertBoundaryContext {
  if (!readText) return {};

  const pos = position;

  // Reading pos-1 is safe here: only '\r' (0x0D, single-byte ASCII) is ever
  // checked against prevChar, and ASCII bytes never appear as UTF-8 continuation
  // bytes, so pos-1 is always a valid character boundary for our purposes.
  const prevChar = pos > 0 ? readText(byteOffset(pos - 1), position) : "";
  const nextChar = readText(
    byteOffset(pos + insertedByteLength),
    byteOffset(pos + insertedByteLength + 1),
  );

  return {
    prevChar: prevChar.length > 0 ? prevChar : undefined,
    nextChar: nextChar.length > 0 ? nextChar : undefined,
  };
}

export function hasCrossBoundaryCRLFMerge(text: string, context: InsertBoundaryContext): boolean {
  if (text.length === 0) return false;
  const mergesWithPrev = text[0] === "\n" && context.prevChar === "\r";
  const mergesWithNext = text[text.length - 1] === "\r" && context.nextChar === "\n";
  // Inserting between an existing CRLF pair breaks one logical separator into two
  // independent separators, which changes line count outside inserted text.
  const splitsExistingCRLF = context.prevChar === "\r" && context.nextChar === "\n";
  return mergesWithPrev || mergesWithNext || splitsExistingCRLF;
}
