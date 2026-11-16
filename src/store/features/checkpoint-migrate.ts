/**
 * Checkpoint version migration.
 *
 * Add one migration step per new version to keep older checkpoints readable.
 * Version 2 added chunk placement keys and anchored history positions.
 *
 * Design decisions (see `docs/adr/001-checkpoint-compatibility.md`):
 *
 * - Migrations run on raw wire data, before validation. Validators encode
 *   the shape of the current version, so an older payload cannot be validated
 *   before it has been brought forward.
 * - Migrate one version at a time, following `v1 -> v2 -> v3`.
 *   Each step is written once, against the format immediately preceding it.
 * - Unknown fields are preserved. A checkpoint written by a newer patch
 *   release of the same version may carry fields this build does not read.
 *   Keep them so a round trip preserves the data.
 * - Downgrade is not supported. A checkpoint from a future version fails
 *   with `VERSION_UNSUPPORTED` so callers can fall back to re-loading from the
 *   original source rather than restoring a lossy approximation.
 */

import { CHECKPOINT_VERSION, CheckpointError } from "../../types/checkpoint.js";
import { buildLoadedPrefix, endGapKey, prefixLengthAtOrBelow } from "../core/chunk-anchor.js";

/** Raw, unvalidated checkpoint wire data. */
export type CheckpointWireData = Record<string, unknown>;

/**
 * One single-version upgrade step.
 *
 * `migrate` receives the payload at version `from` and must return it at
 * version `to`. Preserve the input so callers can retain it or retry restore.
 */
export interface CheckpointMigration {
  readonly from: number;
  readonly to: number;
  migrate(data: CheckpointWireData): CheckpointWireData;
}

// =============================================================================
// v1 -> v2: chunk placement keys and anchored history positions
// =============================================================================

type WireTuple = readonly unknown[];

const isTuple = (value: unknown): value is WireTuple => Array.isArray(value);
const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

function decodedBase64Length(value: unknown): number {
  if (typeof value !== "string") return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length / 4) * 3 - padding);
}

/**
 * Version 2 adds a chunk placement key to add pieces and stores history
 * positions as anchors (see `HistoryAnchor`) instead of resident offsets.
 *
 * Version 1 placed a re-loaded chunk after every add piece that followed a
 * higher chunk, so an add piece belongs after the nearest chunk before it. The
 * derived keys reproduce that placement. Version 1 history offsets are read in
 * the captured chunk layout and anchored there, which keeps undo and redo
 * behaving as they would have right after restore.
 *
 * Documents without chunk pieces need no change: every key is -1 and every
 * anchor equals its offset. Malformed input is returned as is for the
 * validators to report.
 */
function migrateV1ToV2(data: CheckpointWireData): CheckpointWireData {
  const pieceTable = data.pieceTable;
  if (typeof pieceTable !== "object" || pieceTable === null) return data;
  const table = pieceTable as Record<string, unknown>;
  const rawPieces = table.pieces;
  if (!Array.isArray(rawPieces) || !rawPieces.every(isTuple)) return data;
  const pieces = rawPieces as readonly WireTuple[];
  if (!pieces.some((piece) => piece[1] === "c")) return data;

  // Chunk index of each chunk piece, or null for other pieces.
  const chunkOf = pieces.map((piece) => (piece[1] === "c" && isInt(piece[4]) ? piece[4] : null));
  // Chunk index of the nearest chunk piece after each piece, filled in one
  // reverse pass so each add piece finds it in O(1).
  const nextChunkAfter: (number | null)[] = Array.from({ length: pieces.length });
  for (let i = pieces.length - 1, next: number | null = null; i >= 0; i--) {
    nextChunkAfter[i] = next;
    next = chunkOf[i] ?? next;
  }
  const keys: number[] = [];
  const migratedPieces: WireTuple[] = [];
  let previousChunk = -1;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const chunk = chunkOf[i];
    if (chunk !== null && chunk !== undefined) {
      previousChunk = chunk;
      keys.push(chunk - 1);
      migratedPieces.push(piece);
    } else if (piece[1] === "a") {
      const nextChunk = nextChunkAfter[i];
      // Inside a chunk (the same chunk continues after it), the chunk is not
      // wholly before the piece.
      const key =
        previousChunk === -1 ? -1 : nextChunk === previousChunk ? previousChunk - 1 : previousChunk;
      keys.push(key);
      migratedPieces.push(key === -1 ? piece : [...piece.slice(0, 4), key]);
    } else {
      keys.push(-1);
      migratedPieces.push(piece);
    }
  }

  // Resident start of each piece, for locating offsets.
  const starts: number[] = [];
  let total = 0;
  for (const piece of pieces) {
    starts.push(total);
    total += isInt(piece[3]) ? piece[3] : 0;
  }
  // Same rules as gapKey in core/chunk-anchor.ts, over wire tuples.
  const endKey = endGapKey(keys[keys.length - 1]!, chunkOf[pieces.length - 1] ?? null);
  const gapKey = (offset: number): number => {
    if (offset >= total) return endKey;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return keys[lo]!;
  };

  const chunkLengths: [number, number][] = [];
  if (Array.isArray(table.chunks)) {
    for (const entry of table.chunks) {
      if (isTuple(entry) && isInt(entry[0])) {
        chunkLengths.push([entry[0], decodedBase64Length(entry[1])]);
      }
    }
  }
  // Same prefix sums as live anchoring, so each anchor costs O(log C).
  const loaded = buildLoadedPrefix(chunkLengths);
  const anchor = (offset: unknown): [unknown, number] => {
    if (!isInt(offset)) return [offset, -1];
    const key = gapKey(offset);
    return [offset - prefixLengthAtOrBelow(loaded, key), key];
  };

  const migrateSelection = (raw: unknown): unknown => {
    if (typeof raw !== "object" || raw === null) return raw;
    const selection = raw as Record<string, unknown>;
    if (!Array.isArray(selection.ranges)) return raw;
    return {
      ...selection,
      ranges: selection.ranges.map((range: unknown) => {
        if (!isTuple(range)) return range;
        const [anchorPos, anchorKey] = anchor(range[0]);
        const [headPos, headKey] = anchor(range[1]);
        return anchorKey === -1 && headKey === -1
          ? [anchorPos, headPos]
          : [anchorPos, headPos, anchorKey, headKey];
      }),
    };
  };
  const migrateChange = (raw: unknown): unknown => {
    if (!isTuple(raw)) return raw;
    const [position, key] = anchor(raw[1]);
    const head = [raw[0], position, ...raw.slice(2, raw[0] === "r" ? 4 : 3)];
    return key === -1 ? head : [...head, key];
  };
  const migrateEntry = (raw: unknown): unknown => {
    if (typeof raw !== "object" || raw === null) return raw;
    const entry = raw as Record<string, unknown>;
    return {
      ...entry,
      changes: Array.isArray(entry.changes) ? entry.changes.map(migrateChange) : entry.changes,
      selectionBefore: migrateSelection(entry.selectionBefore),
      selectionAfter: migrateSelection(entry.selectionAfter),
    };
  };

  let history = data.history;
  if (typeof history === "object" && history !== null) {
    const source = history as Record<string, unknown>;
    history = {
      ...source,
      undo: Array.isArray(source.undo) ? source.undo.map(migrateEntry) : source.undo,
      redo: Array.isArray(source.redo) ? source.redo.map(migrateEntry) : source.redo,
    };
  }

  return { ...data, pieceTable: { ...table, pieces: migratedPieces }, history };
}

/**
 * The shipped migration registry, ordered by `from`.
 *
 * Append a step here when bumping `CHECKPOINT_VERSION` so `migrationPath` can
 * route older data.
 */
export const CHECKPOINT_MIGRATIONS: readonly CheckpointMigration[] = Object.freeze([
  Object.freeze({ from: 1, to: 2, migrate: migrateV1ToV2 }),
]);

/**
 * The lowest version this build can bring forward.
 *
 * An empty registry supports only the current version. Adding migration steps
 * extends the supported version range automatically.
 */
export function minimumSupportedVersion(
  registry: readonly CheckpointMigration[] = CHECKPOINT_MIGRATIONS,
  target: number = CHECKPOINT_VERSION,
): number {
  let lowest = target;
  // Walk backwards while a step exists that lands on the current lowest version.
  for (;;) {
    const step = registry.find((migration) => migration.to === lowest);
    if (step === undefined || step.from >= lowest) return lowest;
    lowest = step.from;
  }
}

/**
 * Resolve the chain of steps from `from` to `target`, or `null` when no
 * complete path exists.
 */
export function migrationPath(
  from: number,
  target: number = CHECKPOINT_VERSION,
  registry: readonly CheckpointMigration[] = CHECKPOINT_MIGRATIONS,
): CheckpointMigration[] | null {
  if (from === target) return [];
  // Downgrades are refused outright rather than attempted lossily.
  if (from > target) return null;

  const path: CheckpointMigration[] = [];
  let version = from;
  while (version < target) {
    const step = registry.find((migration) => migration.from === version);
    // A step that does not advance would loop forever.
    if (step === undefined || step.to <= version) return null;
    path.push(step);
    version = step.to;
  }

  return version === target ? path : null;
}

/**
 * Migrate raw checkpoint data to the current version.
 * Throw `CheckpointError('VERSION_UNSUPPORTED')` when no migration path exists.
 * This preserves the error code used for unsupported versions before migration.
 */
export function migrateCheckpointData(
  data: CheckpointWireData,
  fromVersion: number,
  target: number = CHECKPOINT_VERSION,
  registry: readonly CheckpointMigration[] = CHECKPOINT_MIGRATIONS,
): { readonly data: CheckpointWireData; readonly applied: readonly CheckpointMigration[] } {
  const path = migrationPath(fromVersion, target, registry);

  if (path === null) {
    const lowest = minimumSupportedVersion(registry, target);
    const window = lowest === target ? `${target}` : `${lowest}-${target}`;
    throw new CheckpointError(
      "VERSION_UNSUPPORTED",
      `checkpoint version ${fromVersion} is unsupported; this build reads version ${window}`,
    );
  }

  let current = data;
  for (const step of path) {
    // Each step receives a fresh shallow copy, so a step that mutates in place
    // cannot corrupt the caller's object or an earlier step's output.
    const next = step.migrate({ ...current });
    current = { ...next, version: step.to };
  }

  return { data: current, applied: path };
}
