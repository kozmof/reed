import { describe, it, expect, vi } from "vitest";
import { createCheckpoint, restoreCheckpoint } from "./checkpoint.js";
import { createDocumentStore } from "./store.js";
import { migrationPath } from "./checkpoint-migrate.js";
import { CheckpointError } from "../../types/checkpoint.js";

// A migration step may throw something that is not an Error.
vi.mock("./checkpoint-migrate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./checkpoint-migrate.js")>();
  return {
    ...actual,
    migrateCheckpointData: () => {
      throw "step 1 -> 2 failed";
    },
  };
});

describe("restoreCheckpoint when a migration throws a non-Error", () => {
  it("names what was thrown in the MALFORMED error", () => {
    expect(migrationPath(1)).not.toBeNull();
    const checkpoint = { ...createCheckpoint(createDocumentStore({ content: "a" }).getSnapshot()) };
    const old = { ...checkpoint, version: 1 } as unknown as typeof checkpoint;
    let caught: unknown;
    try {
      restoreCheckpoint(old);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CheckpointError);
    expect((caught as CheckpointError).code).toBe("MALFORMED");
    expect((caught as CheckpointError).message).toContain(
      "could not be migrated: step 1 -> 2 failed",
    );
  });
});
