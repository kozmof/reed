/**
 * Anchored history positions.
 *
 * History stores positions as (afterChunk, position) pairs that survive chunk
 * loading and eviction. See `HistoryAnchor` in `types/state.ts` and
 * `core/chunk-anchor.ts` for the coordinate system.
 */

import type {
  HistoryAnchor,
  HistoryChange,
  HistoryEntry,
  HistorySelectionRange,
  HistorySelectionState,
  HistoryState,
  PieceTableState,
  SelectionRange,
  SelectionState,
} from "../../types/state.js";
import type { NonEmptyReadonlyArray } from "../../types/utils.js";
import { pstackSize, pstackTrimToSize } from "../../types/state.js";
import type { ByteOffset } from "../../types/branded.js";
import { byteOffset } from "../../types/branded.js";
import type { FittedKey, GapSide, KeyLayout, LoadedNode } from "../core/chunk-anchor.js";
import {
  NO_CHUNK,
  asFittedKey,
  endpointKeyFitsAt,
  gapKey,
  isPlacementKey,
  keySpan,
  loadedChunkLengths,
  loadedSumAtOrBelow,
  placementKey,
  toAnchoredOffset,
  toResidentOffset,
} from "../core/chunk-anchor.js";
import { partitionPoint } from "../core/binary-search.js";
import { getBytes, isUtf8Boundary } from "../core/piece-table.js";
import { isContinuationByte } from "../core/encoding.js";
import { MAX_CONTINUATION_BYTES } from "../core/utf8-seam.js";
import {
  changeDelta,
  forEachHistoryChange,
  removedLength,
  someHistoryChange,
  someHistoryChangeBackward,
} from "./history-entry.js";

/** Anchor resident `offset` using placement key `key`. */
export function anchorAt(pieceTable: PieceTableState, key: number, offset: number): HistoryAnchor {
  return {
    position: toAnchoredOffset(pieceTable, key, offset),
    afterChunk: key,
  };
}

/** Resident offset of an anchored position in `pieceTable`. */
export function residentOffset(pieceTable: PieceTableState, anchor: HistoryAnchor): ByteOffset {
  return byteOffset(toResidentOffset(pieceTable, anchor.afterChunk, anchor.position));
}

/**
 * Why a history change does not replay at resident `start` in `layout`, or
 * null when it does. UNDO and REDO apply this rule (see `applyChange`) and
 * checkpoint restore checks stacks with it (see `findStackReplayFailure`), so
 * restore accepts exactly the histories that replay.
 *
 * `"range"`: the bytes the change removes, [start, start + removed), do not lie
 * inside the document. `"key"`: the recorded key `key` does not fit at `start`
 * once those bytes are gone (see `keyFitsAfterRemoving`). Text that this
 * direction inserts takes that key there, and so do the removed bytes when the
 * other direction inserts them back, so a change that only removes is checked
 * too. One whose key no longer fits would remove bytes it never recorded.
 * `"span"`: some of the removed bytes have a key other than `key`. The bytes a
 * change removes are text the other direction inserted under that key, so a
 * recorded change never removes others. The eviction guard relies on it: a
 * change keyed below a chunk then lies wholly before it (see
 * `changeInsideChunk`).
 */
export function changeReplayFailure(
  layout: KeyLayout,
  start: number,
  removed: number,
  inserted: number,
  key: number,
): "range" | "key" | "span" | null {
  const end = start + removed;
  if (start < 0 || end > layout.totalLength) return "range";
  if (removed === 0 && inserted === 0) return null;
  // Before any chunk loads, NO_CHUNK is the only key, and every byte has it.
  if (layout.nextExpectedChunk === 0) return key === NO_CHUNK ? null : "key";
  if (!isPlacementKey(layout, key)) return "key";
  // Keys never decrease in document order, so the bytes with key `key` are
  // exactly [span.start, span.end). The key fits at `start` once the removed
  // bytes are gone when the range touches that span (as in
  // `keyFitsAfterRemoving`), and every removed byte has the key when the
  // range lies inside it.
  const span = keySpan(layout.root, key);
  if (span.start > end || start > span.end) return "key";
  if (start < span.start || end > span.end) return "span";
  return null;
}

/**
 * Freeze already-frozen `ranges` into a selection. `ranges` comes from mapping
 * a non-empty selection, so it is non-empty.
 */
function freezeSelection<R extends SelectionRange | HistorySelectionRange>(
  ranges: readonly R[],
  primaryIndex: number,
): {
  readonly ranges: NonEmptyReadonlyArray<R>;
  readonly primaryIndex: number;
} {
  return Object.freeze({
    ranges: Object.freeze(ranges) as unknown as NonEmptyReadonlyArray<R>,
    primaryIndex,
  });
}

// =============================================================================
// Placement keys of selection endpoints
// =============================================================================

/**
 * The gap side each endpoint of a range with these offsets takes.
 *
 * A cursor takes the side text typed there takes, so it stays next to that
 * text. A range's start stays with the content after it and its end with the
 * content before it, so a chunk that loads at either edge lands outside the
 * range (see `GapSide`).
 */
export function endpointSides(anchor: number, head: number): readonly [GapSide, GapSide] {
  if (anchor === head) return ["before", "before"];
  return anchor < head ? ["after", "before"] : ["before", "after"];
}

/**
 * A frozen live range with offsets `anchor` and `head`. Each key is stored
 * only when it fits its offset (see `endpointKeyFitsAt`) and differs from the
 * key the document gives that endpoint, so a range carries keys only next to
 * an unloaded chunk. A stored key records the side of an unloaded chunk the
 * endpoint is on, which the offset cannot say (see
 * `SelectionRange.anchorAfterChunk`).
 *
 * Every range of a live selection is built here, or is an earlier range that
 * this would build again unchanged for the current document (see
 * `moveSelectionPastEdit`). Live stored keys are therefore normalized, and
 * comparing them compares where the endpoints are (see `sameRange`).
 */
export function selectionRange(
  pieceTable: PieceTableState,
  anchor: ByteOffset,
  head: ByteOffset,
  anchorKey: number | undefined,
  headKey: number | undefined,
): SelectionRange {
  if (pieceTable.nextExpectedChunk === 0 || (anchorKey === undefined && headKey === undefined)) {
    return Object.freeze({ anchor, head });
  }
  const [anchorSide, headSide] = endpointSides(anchor, head);
  const keep = (offset: number, key: number | undefined, side: GapSide): key is number =>
    key !== undefined &&
    endpointKeyFitsAt(pieceTable, offset, key) &&
    key !== gapKey(pieceTable.root, offset, side);
  const range: { -readonly [K in keyof SelectionRange]: SelectionRange[K] } = {
    anchor,
    head,
  };
  if (keep(anchor, anchorKey, anchorSide)) range.anchorAfterChunk = anchorKey;
  if (keep(head, headKey, headSide)) range.headAfterChunk = headKey;
  return Object.freeze(range);
}

/**
 * Build the ranges of a selection that replaces `previous` without changing
 * the document. `validate` checks each offset of `ranges`, given which endpoint
 * of which range it is, and returns it as stored, or throws.
 *
 * Next to an unloaded chunk, only the stored key knows which side of the chunk
 * an endpoint is on. An editor that echoes the selection back as plain offsets
 * would otherwise lose that side. Each range keeps the keys it brings. A range
 * without keys takes the keys of a range in `previous` with the same offsets,
 * wherever it sits in the list, so reordering, adding, or removing ranges
 * keeps them. A range with its anchor and head swapped takes them swapped.
 * Other ranges take the keys their shape calls for.
 */
export function selectionRangesWithKeys(
  pieceTable: PieceTableState,
  previous: SelectionState,
  ranges: readonly SelectionRange[],
  validate: (offset: number, endpoint: "anchor" | "head", index: number) => ByteOffset,
): NonEmptyReadonlyArray<SelectionRange> {
  const findPrevious = previousRangeLookup(pieceTable, previous);
  return Object.freeze(
    ranges.map((range, i) => {
      const anchor = validate(range.anchor, "anchor", i);
      const head = validate(range.head, "head", i);
      const old =
        range.anchorAfterChunk === undefined || range.headAfterChunk === undefined
          ? findPrevious(i, anchor, head)
          : undefined;
      return selectionRange(
        pieceTable,
        anchor,
        head,
        range.anchorAfterChunk ?? old?.anchorKey,
        range.headAfterChunk ?? old?.headKey,
      );
    }),
  ) as unknown as NonEmptyReadonlyArray<SelectionRange>;
}

/** Stored keys of a previous range, oriented to the range that takes them. */
interface PreviousKeys {
  readonly anchorKey: number | undefined;
  readonly headKey: number | undefined;
}

/**
 * Look up the keys of the range in `previous` with given offsets: the range at
 * the same index first, so duplicate ranges pair up in order, then any range
 * with those offsets, then any with them swapped. Only ranges that store a key
 * are indexed, and the index is built on the first miss at the same index, so
 * a selection echoed back unchanged costs O(1) per range.
 */
function previousRangeLookup(
  pieceTable: PieceTableState,
  previous: SelectionState,
): (index: number, anchor: number, head: number) => PreviousKeys | undefined {
  const keysOf = (range: SelectionRange, swapped: boolean): PreviousKeys =>
    swapped
      ? { anchorKey: range.headAfterChunk, headKey: range.anchorAfterChunk }
      : { anchorKey: range.anchorAfterChunk, headKey: range.headAfterChunk };
  let byOffsets: Map<string, SelectionRange> | undefined;
  return (index, anchor, head) => {
    if (pieceTable.nextExpectedChunk === 0) return undefined;
    const same = previous.ranges[index];
    if (same !== undefined && same.anchor === anchor && same.head === head) {
      return keysOf(same, false);
    }
    if (byOffsets === undefined) {
      byOffsets = new Map();
      for (const range of previous.ranges) {
        const id = `${range.anchor}:${range.head}`;
        if (rangeHasKey(range) && !byOffsets.has(id)) byOffsets.set(id, range);
      }
    }
    if (byOffsets.size === 0) return undefined;
    const direct = byOffsets.get(`${anchor}:${head}`);
    if (direct !== undefined) return keysOf(direct, false);
    const swapped = byOffsets.get(`${head}:${anchor}`);
    return swapped !== undefined ? keysOf(swapped, true) : undefined;
  };
}

/**
 * Placement key for text inserted at resident `offset` when the edit does not
 * give one: the key stored on an endpoint of `selection` at that offset, else
 * the key of the gap (see `gapKey`).
 *
 * When every chunk has been evicted the document is empty, and the cursor's
 * stored key is the only record of where in the file it was.
 */
export function insertionKey(
  pieceTable: PieceTableState,
  selection: SelectionState,
  offset: number,
): FittedKey {
  if (pieceTable.nextExpectedChunk === 0) return asFittedKey(NO_CHUNK);
  // The primary range first: it is the one an edit usually comes from.
  let key = endpointKeyAt(pieceTable, selection.ranges[selection.primaryIndex], offset);
  for (let i = 0; key === undefined && i < selection.ranges.length; i++) {
    key = endpointKeyAt(pieceTable, selection.ranges[i], offset);
  }
  return key ?? placementKey(pieceTable, offset, undefined, "before");
}

/**
 * The stored key of an endpoint of `range` at `offset` that still fits there,
 * the head's first (see `insertionKey`).
 */
function endpointKeyAt(
  pieceTable: PieceTableState,
  range: SelectionRange | undefined,
  offset: number,
): FittedKey | undefined {
  if (range === undefined) return undefined;
  const { headAfterChunk, anchorAfterChunk } = range;
  if (
    range.head === offset &&
    headAfterChunk !== undefined &&
    endpointKeyFitsAt(pieceTable, offset, headAfterChunk)
  ) {
    return asFittedKey(headAfterChunk);
  }
  if (
    range.anchor === offset &&
    anchorAfterChunk !== undefined &&
    endpointKeyFitsAt(pieceTable, offset, anchorAfterChunk)
  ) {
    return asFittedKey(anchorAfterChunk);
  }
  return undefined;
}

/** True when an endpoint of `range` stores a placement key. */
function rangeHasKey(range: SelectionRange): boolean {
  return range.anchorAfterChunk !== undefined || range.headAfterChunk !== undefined;
}

/**
 * The live selection after an edit replaced [start, end) of the document
 * `selection` describes with `inserted` bytes, giving `pieceTable`.
 *
 * Offsets before `start` stay. An endpoint at `start` or inside the removed
 * range moves past the inserted text, as a caret does when text is typed at
 * it. Offsets after the removed range shift by the change in length. A moved
 * endpoint keeps its stored key only where `selectionRange` would.
 *
 * A non-empty range never grows to take in text inserted at its edge. Its end
 * at `start` or inside the removed range stays at `start`, before the inserted
 * text, so text inserted where a range ends lands outside it. A range that
 * lies wholly inside the removed range collapses to a caret after the inserted
 * text, so typing over a selection leaves a caret after the new text.
 *
 * An endpoint that lands just past the edit sits on the byte that was at
 * `end`. That byte can be a continuation byte when `end` was 0, which is a
 * boundary however the document starts: the resident text can begin with the
 * tail of a character cut by an unloaded chunk. Such an endpoint moves past
 * those bytes (see `nextBoundary`), never back into the inserted text, even
 * when they are a malformed run longer than any leftovers. It drops its stored
 * key, as a resolved history selection does. Every other endpoint keeps the
 * boundary it was on.
 *
 * With `remote`, for an edit another user made (APPLY_REMOTE), a caret at
 * `start` or inside the removed range stays at `start`, as the end of a range
 * does: the local cursor did not type the text, so the text lands after it.
 * Text a later change of the same batch inserts at the caret then still finds
 * the caret's key (see `insertionKey`). Non-empty ranges move as for a local
 * edit.
 *
 * A range whose endpoints stay keeps its stored keys only where
 * `selectionRange` would build them again. A key stops fitting when text lands
 * after its endpoint under another key, as at a second caret at a remote
 * insert. It becomes the key the document gives the endpoint when text lands
 * next to it, as at a caret where evicted chunks were. Returns `selection`
 * itself when every range is unchanged.
 */
export function moveSelectionPastEdit(
  pieceTable: PieceTableState,
  selection: SelectionState,
  start: number,
  end: number,
  inserted: number,
  remote = false,
): SelectionState {
  const moveRange = rangeMover(pieceTable, start, end, inserted, remote);
  let ranges: SelectionRange[] | undefined;
  for (let i = 0; i < selection.ranges.length; i++) {
    const range = selection.ranges[i]!;
    // A range wholly before the edit stays, and its stored keys still fit:
    // the bytes before `start` keep their keys, and text inserted at `start`
    // takes a key no lower than the bytes after them.
    if (range.anchor < start && range.head < start) continue;
    const moved = moveRange(range);
    if (moved === range) continue;
    ranges ??= selection.ranges.slice();
    ranges[i] = moved;
  }
  return ranges ? freezeSelection(ranges, selection.primaryIndex) : selection;
}

/**
 * Move one range past an edit as `moveSelectionPastEdit` does, returning the
 * range itself when it is unchanged.
 */
function rangeMover(
  pieceTable: PieceTableState,
  start: number,
  end: number,
  inserted: number,
  remote: boolean,
): (range: SelectionRange) => SelectionRange {
  const landing = start + inserted;
  let boundary: number | undefined;
  // The endpoint's new offset and key. A key fits only the offset it was
  // stored for, so a snapped endpoint drops it.
  const move = (offset: ByteOffset, key: number | undefined) => {
    if (offset < start) return { offset, key };
    const moved = offset >= end ? offset - (end - start) + inserted : landing;
    if (moved !== landing) return { offset: byteOffset(moved), key };
    boundary ??= nextBoundary(pieceTable, landing, true);
    return { offset: byteOffset(boundary), key: boundary === landing ? key : undefined };
  };
  // An endpoint that stays before text inserted at `start`, as the end of a
  // non-empty range does: one inside the removed range moves to `start`. Its
  // key was stored for its old offset, so it keeps the key only when that
  // offset was `start`.
  const stay = (offset: ByteOffset, key: number | undefined) =>
    offset === start
      ? { offset, key }
      : offset > start && offset < end
        ? { offset: byteOffset(start), key: undefined }
        : move(offset, key);
  const nextToEdit = (offset: number, key: number | undefined) =>
    key !== undefined && offset >= start && offset <= end;
  const moveRange = (range: SelectionRange): SelectionRange => {
    const forward = range.anchor < range.head;
    const backward = range.anchor > range.head;
    const remoteCaret = remote && range.anchor === range.head;
    let anchor = (remoteCaret || backward ? stay : move)(range.anchor, range.anchorAfterChunk);
    let head = (remoteCaret || forward ? stay : move)(range.head, range.headAfterChunk);
    // A range wholly inside the removed range: its start moved past the
    // inserted text and its end to before it. Collapse it to a caret there.
    if (forward && head.offset < anchor.offset) head = anchor;
    if (backward && anchor.offset < head.offset) anchor = head;
    const unmoved = anchor.offset === range.anchor && head.offset === range.head;
    // The stored keys of an unmoved range may no longer be the ones
    // `selectionRange` keeps (see above), but only next to the edit. Keys
    // never decrease in document order, so whether a key fits at an offset,
    // and the gap key there, depend only on the bytes on either side of it,
    // which an edit changes only for an offset in [start, end]. Build such a
    // range again and keep the old object when nothing changed.
    if (
      unmoved &&
      !nextToEdit(range.anchor, range.anchorAfterChunk) &&
      !nextToEdit(range.head, range.headAfterChunk)
    ) {
      return range;
    }
    const next = selectionRange(pieceTable, anchor.offset, head.offset, anchor.key, head.key);
    return unmoved && sameRange(next, range) ? range : next;
  };
  return moveRange;
}

/**
 * The local selection carried across the changes of one APPLY_REMOTE batch.
 * Each change moves it as `moveSelectionPastEdit` with `remote` would, and
 * `insertionKey` reads it as `insertionKey` reads the selection, but a change
 * costs O(log² R) in the number of ranges R plus the work for the endpoints in
 * [start, end], where calling those per change costs O(R).
 *
 * Endpoints are kept sorted by offset. A change leaves the endpoints before
 * `start` in place and shifts every endpoint after `end` by the same amount,
 * so neither group changes order. The shift is added lazily, to a Fenwick tree
 * over the sorted positions. Only the ranges with an endpoint in [start, end]
 * are moved, and their endpoints sorted again among themselves.
 *
 * A range away from every change keeps its stored keys as it shifts: whether a
 * key fits, and the gap key there, depend only on the bytes on either side of
 * the endpoint (see `moveSelectionPastEdit`).
 */
export class RemoteBatchSelection {
  readonly #original: SelectionState;
  /** Each range with its current stored keys. Its offsets may be stale. */
  readonly #ranges: SelectionRange[];
  /** Endpoint ids (range index × 2, + 1 for the head) in offset order. */
  readonly #order: Int32Array;
  /** The sorted position of each endpoint id. */
  readonly #position: Int32Array;
  /** Offset at each sorted position, less the shifts in the tree. */
  readonly #base: Float64Array;
  /** Fenwick tree of the shifts, whose prefix sum at a position applies to it. */
  readonly #tree: Float64Array;
  /** Per range, the change that last touched it (see `#touch`). */
  readonly #seen: Int32Array;
  #stamp = 0;

  constructor(selection: SelectionState) {
    this.#original = selection;
    this.#ranges = selection.ranges.slice();
    const count = this.#ranges.length * 2;
    this.#order = new Int32Array(count);
    this.#position = new Int32Array(count);
    this.#base = new Float64Array(count);
    this.#tree = new Float64Array(count + 1);
    this.#seen = new Int32Array(this.#ranges.length);
    this.#sortAll((id) => this.#storedOffset(id));
  }

  /** The placement key for text inserted at `offset` (see `insertionKey`). */
  insertionKey(pieceTable: PieceTableState, offset: number): FittedKey {
    if (pieceTable.nextExpectedChunk === 0) return asFittedKey(NO_CHUNK);
    const candidates: number[] = [];
    for (let i = this.#lowerBound(offset); i < this.#order.length; i++) {
      if (this.#offsetAt(i) !== offset) break;
      candidates.push(this.#order[i]! >> 1);
    }
    let key: FittedKey | undefined;
    if (candidates.length > 0) {
      // The primary range first, then the others in order, as `insertionKey`.
      const primary = this.#original.primaryIndex;
      candidates.sort((a, b) => (a === primary ? -1 : b === primary ? 1 : a - b));
      for (let i = 0; key === undefined && i < candidates.length; i++) {
        key = endpointKeyAt(pieceTable, this.#liveRange(candidates[i]!), offset);
      }
    }
    return key ?? placementKey(pieceTable, offset, undefined, "before");
  }

  /**
   * Move the selection past a remote edit that replaced [start, end) with
   * `inserted` bytes, giving `pieceTable`.
   */
  applyEdit(pieceTable: PieceTableState, start: number, end: number, inserted: number): void {
    const count = this.#order.length;
    const lo = this.#lowerBound(start);
    const hi = this.#lowerBound(end + 1);
    const delta = inserted - (end - start);
    if (lo === hi) {
      if (delta !== 0 && hi < count) this.#shift(hi, delta);
      return;
    }
    // Move every range with an endpoint in [start, end], reading its offsets
    // before the shift.
    const stamp = ++this.#stamp;
    const touched: number[] = [];
    for (let i = lo; i < hi; i++) {
      const index = this.#order[i]! >> 1;
      if (this.#seen[index] === stamp) continue;
      this.#seen[index] = stamp;
      touched.push(index);
    }
    const moveRange = rangeMover(pieceTable, start, end, inserted, true);
    for (const index of touched) this.#ranges[index] = moveRange(this.#liveRange(index));
    if (delta !== 0 && hi < count) this.#shift(hi, delta);
    // An endpoint outside [lo, hi) of a moved range lies before `start` or
    // after `end`, so it stayed or shifted as every endpoint there did.
    let consistent = true;
    for (const index of touched) {
      for (const id of [index * 2, index * 2 + 1]) {
        const position = this.#position[id]!;
        if (position >= lo && position < hi) continue;
        if (this.#offsetAt(position) !== this.#storedOffset(id)) consistent = false;
      }
    }
    if (!consistent) {
      this.#sortLive(stamp);
      return;
    }
    // Sort the moved endpoints among themselves.
    const ids = Array.from(this.#order.subarray(lo, hi));
    ids.sort((a, b) => this.#storedOffset(a) - this.#storedOffset(b));
    for (let i = 0; i < ids.length; i++) {
      const position = lo + i;
      const id = ids[i]!;
      this.#order[position] = id;
      this.#position[id] = position;
      this.#base[position] = this.#storedOffset(id) - this.#prefix(position);
    }
    // They land in [start, end + inserted], between the endpoints around
    // them, except next to a malformed run (see `nextBoundary`).
    if (
      (lo > 0 && this.#offsetAt(lo - 1) > this.#offsetAt(lo)) ||
      (hi < count && this.#offsetAt(hi - 1) > this.#offsetAt(hi))
    ) {
      this.#sortLive(stamp);
    }
  }

  /**
   * Sort every endpoint again by its current offset: the stored offset for a
   * range change `stamp` moved, the tracked one for any other.
   */
  #sortLive(stamp: number): void {
    const offsets = Array.from({ length: this.#order.length }, (_, id) =>
      this.#seen[id >> 1] === stamp ? this.#storedOffset(id) : this.#offsetAt(this.#position[id]!),
    );
    this.#sortAll((id) => offsets[id]!);
  }

  /** The selection after every change so far, `selection` itself when no range changed. */
  selection(): SelectionState {
    const original = this.#original;
    let ranges: SelectionRange[] | undefined;
    for (let index = 0; index < this.#ranges.length; index++) {
      const live = this.#liveRange(index);
      const old = original.ranges[index]!;
      if (live === old || sameRange(live, old)) continue;
      ranges ??= original.ranges.slice();
      ranges[index] = live;
    }
    return ranges ? freezeSelection(ranges, original.primaryIndex) : original;
  }

  /** The offset stored on the range object of endpoint `id`. */
  #storedOffset(id: number): number {
    const range = this.#ranges[id >> 1]!;
    return id & 1 ? range.head : range.anchor;
  }

  /** Range `index` at its current offsets, with its stored keys. */
  #liveRange(index: number): SelectionRange {
    const range = this.#ranges[index]!;
    const anchor = this.#offsetAt(this.#position[index * 2]!);
    const head = this.#offsetAt(this.#position[index * 2 + 1]!);
    if (anchor === range.anchor && head === range.head) return range;
    const live = { ...range, anchor: byteOffset(anchor), head: byteOffset(head) };
    this.#ranges[index] = Object.freeze(live);
    return this.#ranges[index]!;
  }

  /** Sort every endpoint by `offsetOf` and clear the shifts. */
  #sortAll(offsetOf: (id: number) => number): void {
    const ids = Array.from({ length: this.#order.length }, (_, id) => id);
    ids.sort((a, b) => offsetOf(a) - offsetOf(b));
    this.#tree.fill(0);
    for (let position = 0; position < ids.length; position++) {
      const id = ids[position]!;
      this.#order[position] = id;
      this.#position[id] = position;
      this.#base[position] = offsetOf(id);
    }
  }

  #offsetAt(position: number): number {
    return this.#base[position]! + this.#prefix(position);
  }

  /** First sorted position whose offset is at least `offset`. */
  #lowerBound(offset: number): number {
    return partitionPoint(this.#order.length, (position) => this.#offsetAt(position) < offset);
  }

  /** Add `delta` to the offset at every sorted position from `from` on. */
  #shift(from: number, delta: number): void {
    for (let i = from + 1; i < this.#tree.length; i += i & -i) this.#tree[i]! += delta;
  }

  #prefix(position: number): number {
    let sum = 0;
    for (let i = position + 1; i > 0; i -= i & -i) sum += this.#tree[i]!;
    return sum;
  }
}

// =============================================================================
// Anchoring and resolving selections
// =============================================================================

// Before any chunk loads, every key is NO_CHUNK and an anchored position equals
// its offset, so the anchored form depends only on the selection. Selections
// are immutable, so cache it per selection object and share it across edits.
const unchunkedCache = new WeakMap<SelectionState, HistorySelectionState>();

function anchorUnchunked(selection: SelectionState): HistorySelectionState {
  const cached = unchunkedCache.get(selection);
  if (cached !== undefined) return cached;
  const anchored = freezeSelection(
    selection.ranges.map(
      (range): HistorySelectionRange =>
        Object.freeze({
          anchor: range.anchor,
          head: range.head,
          anchorAfterChunk: NO_CHUNK,
          headAfterChunk: NO_CHUNK,
        }),
    ),
    selection.primaryIndex,
  );
  unchunkedCache.set(selection, anchored);
  return anchored;
}

/**
 * Anchor `selection` in a chunked document, given its key layout and its
 * loaded-chunk lengths (see `anchorSelection`).
 */
function anchorChunked(
  layout: KeyLayout,
  loaded: LoadedNode | null,
  selection: SelectionState,
): HistorySelectionState {
  return freezeSelection(
    selection.ranges.map((range): HistorySelectionRange => {
      const [anchorSide, headSide] = endpointSides(range.anchor, range.head);
      const anchorKey = placementKey(layout, range.anchor, range.anchorAfterChunk, anchorSide);
      const headKey = placementKey(layout, range.head, range.headAfterChunk, headSide);
      return Object.freeze({
        anchor: range.anchor - loadedSumAtOrBelow(loaded, anchorKey),
        head: range.head - loadedSumAtOrBelow(loaded, headKey),
        anchorAfterChunk: anchorKey,
        headAfterChunk: headKey,
      });
    }),
    selection.primaryIndex,
  );
}

/**
 * Anchor a live selection. Each endpoint takes its stored key, or the key its
 * side of the gap gives (see `endpointSides`).
 */
export function anchorSelection(
  pieceTable: PieceTableState,
  selection: SelectionState,
): HistorySelectionState {
  if (pieceTable.nextExpectedChunk === 0) return anchorUnchunked(selection);
  return anchorChunked(pieceTable, loadedChunkLengths(pieceTable), selection);
}

/**
 * `selection` anchored in `pieceTable`, as a function that derives it on the
 * first call: a history entry that the next keystroke coalesces away never
 * derives it.
 *
 * Without chunks the anchored form depends only on the selection. With chunks
 * it depends on the piece tree and the loaded-chunk lengths, which the
 * function keeps instead of the document: neither holds chunk bytes, so an
 * evicted chunk's bytes are not kept alive by history.
 */
export function deferAnchorSelection(
  pieceTable: PieceTableState,
  selection: SelectionState,
): () => HistorySelectionState {
  if (pieceTable.nextExpectedChunk === 0) return () => anchorUnchunked(selection);
  const { root, totalLength, nextExpectedChunk } = pieceTable;
  const layout: KeyLayout = { root, totalLength, nextExpectedChunk };
  const loaded = loadedChunkLengths(pieceTable);
  return () => anchorChunked(layout, loaded, selection);
}

/** Bytes read at a time while scanning a long run of continuation bytes. */
const SCAN_BLOCK = 256;

/**
 * The UTF-8 code-point boundary a position clamped to `offset` moves to.
 *
 * Evicting a chunk can leave the bytes of a character split across its edge
 * behind, as up to three continuation bytes with no lead byte. A position
 * clamped to where the chunk was can land on one, and edits and SET_SELECTION
 * reject such a position. Those bytes belonged to the evicted character, so
 * step past them. The end of the document is always a boundary.
 *
 * A longer run of continuation bytes is malformed text of the document itself,
 * not leftovers, and no position inside it is a boundary. The position then
 * moves to the nearer end of the run, the one after it on a tie, so it stays
 * as close as it can to where the chunk was. The run is read a block at a
 * time: O(log n) for leftovers, O(k + (k / SCAN_BLOCK) log n) for a run of k.
 *
 * With `forwardOnly`, the position moves to the end of the run after it
 * whatever the distance. A caret that lands after inserted text uses this, as
 * the bytes before it are that text.
 */
export function nextBoundary(
  pieceTable: PieceTableState,
  offset: number,
  forwardOnly = false,
): number {
  if (isUtf8Boundary(pieceTable, byteOffset(offset))) return offset;
  // `offset` is inside the document, on a continuation byte.
  const total = pieceTable.totalLength;
  const leftovers = getBytes(
    pieceTable,
    byteOffset(offset + 1),
    byteOffset(offset + 1 + MAX_CONTINUATION_BYTES),
  );
  for (let i = 0; i < leftovers.length; i++) {
    if (!isContinuationByte(leftovers[i]!)) return offset + 1 + i;
  }
  // The end of the document came within leftover reach. A full window of
  // continuation bytes that ends right at the end is a longer run, so it falls
  // through and moves to the nearer end like any other run.
  if (leftovers.length < MAX_CONTINUATION_BYTES) return total;

  // Scan both ways until the nearer end of the run is known. `ahead` is the
  // first position not yet read after `offset`, `behind` the first byte read
  // before it. Every byte read so far is a continuation byte.
  let ahead = offset + 1 + MAX_CONTINUATION_BYTES;
  let behind = offset;
  let after: number | undefined;
  let before: number | undefined;
  for (;;) {
    if (after === undefined) {
      const block = getBytes(pieceTable, byteOffset(ahead), byteOffset(ahead + SCAN_BLOCK));
      const i = block.findIndex((byte) => !isContinuationByte(byte));
      if (i >= 0) after = ahead + i;
      else if ((ahead += block.length) >= total) after = total;
    }
    if (forwardOnly) {
      if (after !== undefined) return after;
      continue;
    }
    if (before === undefined) {
      const from = Math.max(0, behind - SCAN_BLOCK);
      const block = getBytes(pieceTable, byteOffset(from), byteOffset(behind));
      let i = block.length - 1;
      while (i >= 0 && isContinuationByte(block[i]!)) i--;
      if (i >= 0) before = from + i;
      else if ((behind = from) === 0) before = 0;
    }
    // An end not found yet is at least as far as the bytes read on its side.
    const afterDistance = after !== undefined ? after - offset : ahead - offset;
    const beforeDistance = before !== undefined ? offset - before : offset - behind + 1;
    if (after !== undefined && afterDistance <= beforeDistance) return after;
    if (before !== undefined && beforeDistance < afterDistance) return before;
  }
}

/**
 * Resolve a history selection to resident offsets.
 *
 * Selections do not block eviction, so a cursor may have pointed inside a chunk
 * that is no longer loaded. Its resident offset would then land in whatever
 * follows that chunk. Each position is instead clamped to the span of gaps that
 * share its placement key, which puts it where the evicted chunk was, then
 * moved past any continuation bytes the chunk left (see `nextBoundary`).
 *
 * Each endpoint keeps its key on the live range when the document cannot
 * supply it (see `SelectionRange.anchorAfterChunk`), so the side of an
 * unloaded chunk survives undo, redo, and further loads and evictions.
 */
export function resolveSelection(
  pieceTable: PieceTableState,
  selection: HistorySelectionState,
): SelectionState {
  // Before any chunk loads, every key is NO_CHUNK, whose span is the whole
  // document, and an anchored position is its offset. A restored checkpoint
  // can still put it inside a character, which edits and SET_SELECTION
  // reject, so it moves to a boundary as on the chunked path.
  if (pieceTable.nextExpectedChunk === 0) {
    const total = pieceTable.totalLength;
    const within = (offset: number) =>
      byteOffset(nextBoundary(pieceTable, Math.max(0, Math.min(offset, total))));
    return freezeSelection(
      selection.ranges.map(
        (range): SelectionRange =>
          Object.freeze({
            anchor: within(range.anchor),
            head: within(range.head),
          }),
      ),
      selection.primaryIndex,
    );
  }
  const resolve = (key: number, anchored: number) => {
    const { start, end } = keySpan(pieceTable.root, key);
    const offset = Math.max(start, Math.min(toResidentOffset(pieceTable, key, anchored), end));
    const boundary = nextBoundary(pieceTable, offset);
    // Past the clamped offset the key no longer fits, so the document's applies.
    return {
      offset: byteOffset(boundary),
      key: boundary === offset ? key : undefined,
    };
  };
  return freezeSelection(
    selection.ranges.map((range) => {
      const anchor = resolve(range.anchorAfterChunk, range.anchor);
      const head = resolve(range.headAfterChunk, range.head);
      return selectionRange(pieceTable, anchor.offset, head.offset, anchor.key, head.key);
    }),
    selection.primaryIndex,
  );
}

/**
 * True when two live ranges have the same offsets and stored keys. Live
 * stored keys are normalized (see `selectionRange`), so this is true exactly
 * when the ranges place their endpoints alike.
 */
function sameRange(a: SelectionRange, b: SelectionRange): boolean {
  return (
    a.anchor === b.anchor &&
    a.head === b.head &&
    a.anchorAfterChunk === b.anchorAfterChunk &&
    a.headAfterChunk === b.headAfterChunk
  );
}

/**
 * `current` when `next` holds the same ranges, stored keys, and primary index,
 * else `next`. An action that leaves the selection in place keeps the same
 * object, so `state.selection !== prev.selection` means it moved.
 */
export function keepSameSelection(current: SelectionState, next: SelectionState): SelectionState {
  return current === next ||
    (current.primaryIndex === next.primaryIndex && sameRanges(current.ranges, next.ranges))
    ? current
    : next;
}

/** True when two range lists have the same offsets and stored keys, in order. */
function sameRanges(a: readonly SelectionRange[], b: readonly SelectionRange[]): boolean {
  return a === b || (a.length === b.length && a.every((range, i) => sameRange(range, b[i]!)));
}

/**
 * The selection that SET_SELECTION or an edit selection with `ranges` sets.
 * Actions carry no primary index, so the first range is primary, except when
 * `ranges` repeat the current ranges: then `current` itself is returned, so a
 * selection echoed back keeps its primary range and changes nothing.
 */
export function selectionFromRanges(
  current: SelectionState,
  ranges: NonEmptyReadonlyArray<SelectionRange>,
): SelectionState {
  return sameRanges(current.ranges, ranges) ? current : Object.freeze({ ranges, primaryIndex: 0 });
}

/**
 * Move the live selection from `before` to `after`, two documents that differ
 * only by loaded or evicted chunks.
 *
 * Each offset is anchored in `before` and resolved in `after`, the same way
 * history selections are. An offset inside an evicted chunk moves to where the
 * chunk was, which is the chunk's start once it loads again: the offset within
 * the chunk is lost. The endpoint keeps the chunk's key, so it stays on that
 * side of the chunk. Returns `selection` itself when neither an offset nor a
 * stored key changes.
 *
 * Before the first chunk loads, a selection has no side of any chunk: every
 * key is NO_CHUNK because nothing has loaded, not because the selection was
 * placed before chunk 0. Text typed before any load stays before every chunk,
 * so its offsets hold, and the document gives each endpoint its key, as for a
 * selection set after the load (see `gapKey`). The chunk can start with the
 * tail of a character cut at its edge, so an endpoint where it loads moves
 * past those bytes, as on every later load (see `nextBoundary`).
 */
export function carrySelectionAcrossChunks(
  before: PieceTableState,
  after: PieceTableState,
  selection: SelectionState,
): SelectionState {
  if (before.nextExpectedChunk === 0) {
    if (after.nextExpectedChunk === 0) return selection;
    const snap = (offset: ByteOffset) => byteOffset(nextBoundary(after, offset));
    return keepSameSelection(
      selection,
      freezeSelection(
        selection.ranges.map((range) =>
          selectionRange(after, snap(range.anchor), snap(range.head), undefined, undefined),
        ),
        selection.primaryIndex,
      ),
    );
  }
  return keepSameSelection(selection, resolveSelection(after, anchorSelection(before, selection)));
}

// =============================================================================
// Eviction guard
// =============================================================================

/**
 * Key range and length change of some history changes, for skipping whole
 * stack subtrees. `delta` is the net number of bytes the changes add when
 * applied forward.
 */
interface ChangeSummary {
  readonly minKey: number;
  readonly maxKey: number;
  readonly delta: number;
}

type StackNode = NonNullable<HistoryState["undoStack"]>;

const EMPTY_SUMMARY: ChangeSummary = {
  minKey: Infinity,
  maxKey: -Infinity,
  delta: 0,
};
const entrySummaryCache = new WeakMap<HistoryEntry, ChangeSummary>();
// Stack nodes are shared between successive stacks, so a push or pop computes
// summaries only for the O(log H) nodes it creates, each in O(1).
const nodeSummaryCache = new WeakMap<StackNode, ChangeSummary>();

function combineSummaries(a: ChangeSummary, b: ChangeSummary): ChangeSummary {
  return {
    minKey: Math.min(a.minKey, b.minKey),
    maxKey: Math.max(a.maxKey, b.maxKey),
    delta: a.delta + b.delta,
  };
}

function entrySummary(entry: HistoryEntry): ChangeSummary {
  let summary = entrySummaryCache.get(entry);
  if (summary !== undefined) return summary;
  let minKey = Infinity;
  let maxKey = -Infinity;
  let delta = 0;
  forEachHistoryChange(entry, (change) => {
    minKey = Math.min(minKey, change.afterChunk);
    maxKey = Math.max(maxKey, change.afterChunk);
    delta += changeDelta(change);
  });
  summary = { minKey, maxKey, delta };
  entrySummaryCache.set(entry, summary);
  return summary;
}

/** Summary of every change in the subtree rooted at `node`. */
function nodeSummary(node: StackNode | null): ChangeSummary {
  if (node === null) return EMPTY_SUMMARY;
  let summary = nodeSummaryCache.get(node);
  if (summary !== undefined) return summary;
  summary = combineSummaries(
    combineSummaries(nodeSummary(node.left), entrySummary(node.value)),
    nodeSummary(node.right),
  );
  nodeSummaryCache.set(node, summary);
  return summary;
}

/**
 * The chunk being evicted, followed back through one history stack. `start` is
 * the anchored position, with key `key`, of the chunk's first byte in the
 * document the next visited change applies to. `direction` is -1 on the undo
 * stack, whose changes are undone, and 1 on the redo stack.
 */
interface ChunkTrack {
  readonly key: number;
  readonly direction: 1 | -1;
  start: number;
}

/**
 * True when `change` points inside the tracked chunk in the document it
 * applies to. Otherwise moves the chunk's start past the change.
 *
 * A change keyed below `key` lies wholly before the chunk, and one keyed above
 * it wholly after: every byte a change removes has its key (see
 * `changeReplayFailure`, which UNDO, REDO and checkpoint restore apply). A change keyed `key` lies before the chunk when its position
 * is at or before the chunk's start and it removes nothing from the start on.
 * Past that start it resolves by counting the chunk's bytes, which eviction
 * removes. A change that removes bytes from the start on removes the chunk's
 * own bytes, which only a loaded chunk has.
 */
function changeInsideChunk(change: HistoryChange, track: ChunkTrack): boolean {
  if (change.afterChunk > track.key) return false;
  if (change.afterChunk === track.key) {
    if (change.position > track.start) return true;
    const removed = removedLength(change, track.direction);
    if (removed > 0 && change.position + removed > track.start) return true;
  }
  track.start += track.direction * changeDelta(change);
  return false;
}

/**
 * Stack index (oldest first) of the first entry, in the order the stack is
 * replayed (newest first), with a change inside the tracked chunk, or -1.
 * Subtrees whose changes all lie on one side of the chunk are skipped in O(1).
 */
function firstInside(node: StackNode | null, firstIndex: number, track: ChunkTrack): number {
  if (node === null) return -1;
  const summary = nodeSummary(node);
  if (summary.minKey > track.key) return -1;
  if (summary.maxKey < track.key) {
    track.start += track.direction * summary.delta;
    return -1;
  }
  const ownIndex = firstIndex + (node.left?.size ?? 0);
  const right = firstInside(node.right, ownIndex + 1, track);
  if (right >= 0) return right;
  // Undo applies an entry's changes last to first, and redo first to last.
  const visit = (change: HistoryChange) => changeInsideChunk(change, track);
  const inside =
    track.direction < 0
      ? someHistoryChangeBackward(node.value, visit)
      : someHistoryChange(node.value, visit);
  if (inside) return ownIndex;
  return firstInside(node.left, firstIndex, track);
}

/** Where each stack must be cut to evict a chunk (see `firstInside`). */
interface EvictionCuts {
  readonly anchoredStart: number;
  readonly undoCut: number;
  readonly redoCut: number;
}

// The same history is often measured against the same chunk more than once:
// EVICT_CHUNKS measures a candidate and then evicts it, and ChunkManager
// offers a refused candidate again once a load next to it may have freed it. The cuts depend only on the history, the chunk, and
// the chunk's anchored start. Loading or evicting other chunks leaves the
// anchored start unchanged, and every edit, undo, and redo replaces the
// history object, so the cuts are kept per history object.
const evictionCutCache = new WeakMap<HistoryState, Map<number, EvictionCuts>>();

function evictionCuts(history: HistoryState, chunkIndex: number, anchoredStart: number) {
  let byChunk = evictionCutCache.get(history);
  const cached = byChunk?.get(chunkIndex);
  if (cached !== undefined && cached.anchoredStart === anchoredStart) return cached;
  const key = chunkIndex - 1;
  const cut = (stack: HistoryState["undoStack"], direction: 1 | -1) =>
    firstInside(stack, 0, { key, direction, start: anchoredStart });
  const cuts: EvictionCuts = {
    anchoredStart,
    undoCut: cut(history.undoStack, -1),
    redoCut: cut(history.redoStack, 1),
  };
  if (byChunk === undefined) {
    byChunk = new Map();
    evictionCutCache.set(history, byChunk);
  }
  byChunk.set(chunkIndex, cuts);
  return cuts;
}

const NO_CUTS = Object.freeze({ undoCut: -1, redoCut: -1 });

/**
 * Where each stack must be cut to evict `chunkIndex`, whose first resident
 * byte is at `start`: -1 for a stack nothing in which points inside the chunk.
 * `historyForEviction` and `historyLossForEviction` both read the cuts here,
 * so the loss EVICT_CHUNKS measures is what the eviction drops.
 */
function evictionCutsAt(
  pieceTable: PieceTableState,
  history: HistoryState,
  chunkIndex: number,
  start: number,
): { readonly undoCut: number; readonly redoCut: number } {
  if (history.undoStack === null && history.redoStack === null) return NO_CUTS;
  return evictionCuts(history, chunkIndex, toAnchoredOffset(pieceTable, chunkIndex - 1, start));
}

/**
 * Apply the history eviction policy before evicting `chunkIndex`, whose first
 * resident byte is at `start`.
 *
 * A change points inside the chunk when it carries the key `chunkIndex - 1`
 * and lies past the chunk's start in the document it applies to. Such a
 * position resolves by counting the chunk's bytes, so it cannot be resolved
 * once they are gone. The chunk's start is fine: it stays meaningful without
 * the chunk's bytes.
 *
 * Each change records its position in the document it applies to, not in the
 * current one, and edits before the chunk move the chunk. The guard therefore
 * follows the chunk's start back through each stack, one change at a time.
 *
 * Entries older than the first such entry can only be replayed after it, so
 * dropping it means dropping all of them.
 *
 * Returns the history to keep, or `null` when the eviction must be refused:
 * history points inside the chunk under policy `"pin"`, or under
 * `"pin-bounded"` without `overLimit` (see `HistoryEvictionPolicy`). Returns
 * the same history object when nothing points inside the chunk.
 */
export function historyForEviction(
  pieceTable: PieceTableState,
  history: HistoryState,
  chunkIndex: number,
  start: number,
  overLimit = false,
): HistoryState | null {
  const { undoCut, redoCut } = evictionCutsAt(pieceTable, history, chunkIndex, start);
  if (undoCut < 0 && redoCut < 0) return history;
  const policy = history.evictionPolicy;
  // Anything other than "pin" or "drop", such as a hand-built state without a
  // policy, gets the default "pin-bounded".
  if (policy === "pin" || (policy !== "drop" && !overLimit)) return null;
  // Keep only the entries newer than the cut. The split shares structure.
  const keepNewerThan = (stack: HistoryState["undoStack"], cut: number) =>
    cut < 0 ? stack : pstackTrimToSize(stack, pstackSize(stack) - cut - 1);
  return Object.freeze({
    ...history,
    undoStack: keepNewerThan(history.undoStack, undoCut),
    redoStack: keepNewerThan(history.redoStack, redoCut),
  });
}

/**
 * How many entries of each stack evicting a chunk discards when history may
 * be dropped. Each count is a run of the oldest entries of its stack.
 */
export interface EvictionHistoryLoss {
  readonly undo: number;
  readonly redo: number;
}

/** Undo and redo entries an eviction discards in all. */
export function totalLoss(loss: EvictionHistoryLoss): number {
  return loss.undo + loss.redo;
}

/**
 * How many undo and redo entries evicting `chunkIndex`, whose first resident
 * byte is at `start`, discards when history may be dropped: the entries
 * `historyForEviction` leaves out, none when nothing points inside the chunk.
 */
export function historyLossForEviction(
  pieceTable: PieceTableState,
  history: HistoryState,
  chunkIndex: number,
  start: number,
): EvictionHistoryLoss {
  const { undoCut, redoCut } = evictionCutsAt(pieceTable, history, chunkIndex, start);
  // Cutting at `cut` drops it and every entry older than it (see `keepNewerThan`).
  return { undo: undoCut + 1, redo: redoCut + 1 };
}
