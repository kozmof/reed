/**
 * Migration dispatch, exercised against synthetic versions.
 *
 * The shipped registry is empty — version 1 is the only format that exists — so
 * routing, failure, ordering and field preservation are proved with injected
 * fixtures. The point is that the path is tested *before* a real version 2
 * needs it, not afterwards.
 */

import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_MIGRATIONS,
  migrateCheckpointData,
  migrationPath,
  minimumSupportedVersion,
  type CheckpointMigration,
  type CheckpointWireData,
} from "./checkpoint-migrate.js";
import { CHECKPOINT_VERSION, CheckpointError } from "../../types/checkpoint.js";
import { createCheckpoint, restoreCheckpoint } from "./checkpoint.js";
import { createDocumentStore } from "./store.js";

/** v1 -> v2: renames a field, to show payload rewriting works. */
const oneToTwo: CheckpointMigration = {
  from: 1,
  to: 2,
  migrate: (data) => {
    const { renamedFrom, ...rest } = data;
    return { ...rest, renamedTo: renamedFrom };
  },
};

/** v2 -> v3: adds a field with a default. */
const twoToThree: CheckpointMigration = {
  from: 2,
  to: 3,
  migrate: (data) => ({ ...data, addedInV3: "default" }),
};

const registry = [oneToTwo, twoToThree];

describe("migrationPath", () => {
  it("returns an empty path when already current", () => {
    expect(migrationPath(3, 3, registry)).toEqual([]);
  });

  it("chains single-version steps in order", () => {
    const path = migrationPath(1, 3, registry);
    expect(path?.map((step) => `${step.from}->${step.to}`)).toEqual(["1->2", "2->3"]);
  });

  it("refuses a downgrade from a future version", () => {
    expect(migrationPath(4, 3, registry)).toBeNull();
  });

  it("returns null when a step is missing", () => {
    expect(migrationPath(1, 3, [twoToThree])).toBeNull();
  });

  it("does not loop on a step that fails to advance", () => {
    const stuck: CheckpointMigration = { from: 1, to: 1, migrate: (data) => data };
    expect(migrationPath(1, 3, [stuck])).toBeNull();
  });
});

describe("minimumSupportedVersion", () => {
  it("is the current version when no migrations are registered", () => {
    expect(minimumSupportedVersion([], 1)).toBe(1);
  });

  it("widens as steps are appended", () => {
    expect(minimumSupportedVersion(registry, 3)).toBe(1);
  });
});

describe("migrateCheckpointData", () => {
  it("applies every step and stamps the resulting version", () => {
    const result = migrateCheckpointData({ version: 1, renamedFrom: "value" }, 1, 3, registry);

    expect(result.data).toEqual({ version: 3, renamedTo: "value", addedInV3: "default" });
    expect(result.applied).toHaveLength(2);
  });

  it("preserves fields no step knows about", () => {
    const result = migrateCheckpointData(
      { version: 1, renamedFrom: "value", unknownField: { nested: 1 } },
      1,
      3,
      registry,
    );

    expect(result.data.unknownField, "unknown fields survive the chain").toEqual({ nested: 1 });
  });

  it("does not mutate the caller's payload", () => {
    const original: CheckpointWireData = { version: 1, renamedFrom: "value" };
    migrateCheckpointData(original, 1, 3, registry);
    expect(original).toEqual({ version: 1, renamedFrom: "value" });
  });

  it("is idempotent once current", () => {
    const current = { version: 3, renamedTo: "value", addedInV3: "default" };
    const once = migrateCheckpointData(current, 3, 3, registry);
    const twice = migrateCheckpointData(once.data, 3, 3, registry);

    expect(once.applied).toEqual([]);
    expect(twice.data).toEqual(current);
  });

  it("reports VERSION_UNSUPPORTED with the supported window", () => {
    expect(() => migrateCheckpointData({ version: 0 }, 0, 3, registry)).toThrowError(
      /version 0 is unsupported.*reads version 1-3/,
    );

    try {
      migrateCheckpointData({ version: 0 }, 0, 3, registry);
      expect.unreachable("expected a CheckpointError");
    } catch (error) {
      expect(error).toBeInstanceOf(CheckpointError);
      expect((error as CheckpointError).code).toBe("VERSION_UNSUPPORTED");
    }
  });
});

describe("shipped registry", () => {
  it("is empty while version 1 is the only format", () => {
    expect(CHECKPOINT_MIGRATIONS).toEqual([]);
    expect(minimumSupportedVersion()).toBe(CHECKPOINT_VERSION);
  });

  it("rejects an unknown version through the real restore path", () => {
    const store = createDocumentStore({ content: "reed" });
    const checkpoint = createCheckpoint(store.reconcileNow());
    store.dispose();

    const fromTheFuture = { ...checkpoint, version: CHECKPOINT_VERSION + 1 };
    expect(() => restoreCheckpoint(fromTheFuture)).toThrowError(CheckpointError);

    try {
      restoreCheckpoint(fromTheFuture);
      expect.unreachable("expected a CheckpointError");
    } catch (error) {
      expect((error as CheckpointError).code).toBe("VERSION_UNSUPPORTED");
    }
  });

  it("still restores an exact v1 checkpoint unchanged", () => {
    const store = createDocumentStore({ content: "reed\ncheckpoint\nmigration" });
    const checkpoint = createCheckpoint(store.reconcileNow());
    const restored = restoreCheckpoint(checkpoint);

    expect(restored.pieceTable.totalLength).toBe(store.getSnapshot().pieceTable.totalLength);
    expect(restored.lineIndex.lineCount).toBe(store.getSnapshot().lineIndex.lineCount);
    store.dispose();
  });
});
