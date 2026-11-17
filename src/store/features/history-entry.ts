/**
 * Read access to history entries that may be coalesced.
 *
 * A coalesced entry shares its earlier changes with the entry it replaced and
 * builds its `changes` array only when a consumer reads it. These helpers read
 * such entries without forcing that array into existence.
 */

import type { HistoryChange, HistoryEntry } from "../../types/state.js";

/**
 * Coalesced entries, keyed to the change list they extend: every change of
 * `base` except the last, followed by `tail`.
 */
export const coalescedTails = new WeakMap<
  HistoryEntry,
  {
    base: readonly HistoryChange[];
    tail: HistoryChange;
  }
>();

/** The change applied last in `entry`, or undefined for an empty entry. */
export function lastHistoryChange(entry: HistoryEntry): HistoryChange | undefined {
  return coalescedTails.get(entry)?.tail ?? entry.changes[entry.changes.length - 1];
}

/** Call `visit` with every change of `entry`, in order. */
export function forEachHistoryChange(
  entry: HistoryEntry,
  visit: (change: HistoryChange) => void,
): void {
  const coalesced = coalescedTails.get(entry);
  if (coalesced === undefined) {
    for (const change of entry.changes) visit(change);
    return;
  }
  const { base, tail } = coalesced;
  for (let i = 0; i < base.length - 1; i++) visit(base[i]!);
  visit(tail);
}

/** True when some change of `entry` matches `predicate`. */
export function someHistoryChange(
  entry: HistoryEntry,
  predicate: (change: HistoryChange) => boolean,
): boolean {
  const coalesced = coalescedTails.get(entry);
  if (coalesced === undefined) return entry.changes.some(predicate);
  const { base, tail } = coalesced;
  for (let i = 0; i < base.length - 1; i++) {
    if (predicate(base[i]!)) return true;
  }
  return predicate(tail);
}

/**
 * True when some change of `entry` matches `predicate`, visiting changes last
 * to first (the order undo applies them) and stopping at the first match.
 */
export function someHistoryChangeBackward(
  entry: HistoryEntry,
  predicate: (change: HistoryChange) => boolean,
): boolean {
  const coalesced = coalescedTails.get(entry);
  if (coalesced === undefined) {
    const { changes } = entry;
    for (let i = changes.length - 1; i >= 0; i--) {
      if (predicate(changes[i]!)) return true;
    }
    return false;
  }
  const { base, tail } = coalesced;
  if (predicate(tail)) return true;
  for (let i = base.length - 2; i >= 0; i--) {
    if (predicate(base[i]!)) return true;
  }
  return false;
}

/**
 * Bytes `change` removes when replayed in `direction`: when redone (1), what
 * it deleted; when undone (-1), what it inserted.
 */
export function removedLength(change: HistoryChange, direction: 1 | -1): number {
  switch (change.type) {
    case "insert":
      return direction < 0 ? change.byteLength : 0;
    case "delete":
      return direction > 0 ? change.byteLength : 0;
    case "replace":
      return direction > 0 ? change.oldByteLength : change.byteLength;
  }
}

/** Bytes `change` inserts when replayed in `direction`, which the other direction removes. */
export function insertedLength(change: HistoryChange, direction: 1 | -1): number {
  return removedLength(change, direction > 0 ? -1 : 1);
}

/** Bytes `change` adds to the document when applied forward. */
export function changeDelta(change: HistoryChange): number {
  return insertedLength(change, 1) - removedLength(change, 1);
}
