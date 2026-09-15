/**
 * Checkpoint version migration.
 *
 * Version 1 is currently the only format that has ever shipped, so the registry
 * below is empty. The dispatch exists anyway, and is tested against synthetic
 * fixtures, so that introducing a version 2 is a matter of appending one step
 * rather than designing an upgrade path under pressure — at which point every
 * v1 checkpoint already written by a deployed build must still restore.
 *
 * Design decisions (see `docs/adr/001-checkpoint-compatibility.md`):
 *
 * - Migrations run on **raw wire data**, before validation. Validators encode
 *   the shape of the current version, so an older payload cannot be validated
 *   before it has been brought forward.
 * - Steps are **single-version**: `v1 -> v2 -> v3`, never `v1 -> v3` directly.
 *   Each step is written once, against the format immediately preceding it.
 * - Unknown fields are **preserved**. A checkpoint written by a newer patch
 *   release of the same version may carry fields this build does not read;
 *   dropping them would silently downgrade a round trip.
 * - Downgrade is **not supported**. A checkpoint from a future version fails
 *   with `VERSION_UNSUPPORTED` so callers can fall back to re-loading from the
 *   original source rather than restoring a lossy approximation.
 */

import { CHECKPOINT_VERSION, CheckpointError } from "../../types/checkpoint.js";

/** Raw, unvalidated checkpoint wire data. */
export type CheckpointWireData = Record<string, unknown>;

/**
 * One single-version upgrade step.
 *
 * `migrate` receives the payload at version `from` and must return it at
 * version `to`. It must not mutate its input: restore may be retried, and a
 * caller may hold the original object.
 */
export interface CheckpointMigration {
  readonly from: number;
  readonly to: number;
  migrate(data: CheckpointWireData): CheckpointWireData;
}

/**
 * The shipped migration registry, ordered by `from`.
 *
 * Empty while version 1 is the only format. Append a step here when bumping
 * `CHECKPOINT_VERSION`; `migrationPath` does the routing.
 */
export const CHECKPOINT_MIGRATIONS: readonly CheckpointMigration[] = Object.freeze([]);

/**
 * The lowest version this build can bring forward.
 *
 * With an empty registry this is the current version: there is nothing older to
 * upgrade from. It widens automatically as steps are appended, so the supported
 * window is derived from the registry rather than maintained by hand.
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
 * Bring raw checkpoint data forward to the current version.
 *
 * Throws `CheckpointError('VERSION_UNSUPPORTED')` when no path exists, which is
 * the same code an unreadable version produced before migration existed — so
 * callers that already branch on it keep working.
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
