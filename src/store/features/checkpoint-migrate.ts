/**
 * Checkpoint version migration.
 *
 * The registry is empty while version 1 is the only supported format.
 * Synthetic fixtures test migration routing before a newer format ships.
 * Add one migration step per new version to keep older checkpoints readable.
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

/**
 * The shipped migration registry, ordered by `from`.
 *
 * Empty while version 1 is the only format. Append a step here when bumping
 * `CHECKPOINT_VERSION` so `migrationPath` can route older data.
 */
export const CHECKPOINT_MIGRATIONS: readonly CheckpointMigration[] = Object.freeze([]);

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
