/**
 * Test migration dispatch with synthetic versions.
 *
 * Injected fixtures test routing, failure, ordering, and field preservation
 * independently of the shipped registry, which migrates version 1 to 2.
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
import { DocumentActions } from "./actions.js";
import { byteOffset } from "../../types/branded.js";
import type { DocumentState } from "../../types/state.js";
import { documentReducer } from "./reducer.js";
import { getValue } from "../core/piece-table.js";

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
  it("ships the version 1 to 2 step", () => {
    expect(CHECKPOINT_MIGRATIONS.map(({ from, to }) => [from, to])).toEqual([[1, 2]]);
    expect(CHECKPOINT_VERSION).toBe(2);
    expect(minimumSupportedVersion()).toBe(1);
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

describe("restore limits before migration", () => {
  function v1Checkpoint() {
    const store = createDocumentStore({ content: "reed" });
    store.dispatch(DocumentActions.insert(byteOffset(4), "!"));
    const checkpoint = createCheckpoint(store.reconcileNow());
    store.dispose();
    return { ...checkpoint, version: 1 } as Record<string, unknown>;
  }

  const codeOf = (fn: () => unknown): { code: string; message: string } => {
    try {
      fn();
    } catch (error) {
      return error as CheckpointError;
    }
    throw new Error("expected a CheckpointError");
  };

  it("rejects too many pieces or history entries in a v1 payload", () => {
    const checkpoint = v1Checkpoint();
    expect(codeOf(() => restoreCheckpoint(checkpoint, { maxPieces: 0 })).code).toBe(
      "RESOURCE_LIMIT",
    );
    expect(codeOf(() => restoreCheckpoint(checkpoint, { maxHistoryEntries: 0 })).code).toBe(
      "RESOURCE_LIMIT",
    );
  });

  it("counts the arrays the migration walks before running it", () => {
    const error = codeOf(() => restoreCheckpoint(v1Checkpoint(), { maxCollectionItems: 0 }));
    expect(error.code).toBe("RESOURCE_LIMIT");
    expect(error.message).toContain("checkpoint collection items");
  });

  it("reports an unsupported version before any limit", () => {
    const checkpoint = { ...v1Checkpoint(), version: 0 };
    expect(codeOf(() => restoreCheckpoint(checkpoint, { maxPieces: 0 })).code).toBe(
      "VERSION_UNSUPPORTED",
    );
  });
});

describe("version 1 migration of large or hostile input", () => {
  const N = 200_000;
  /**
   * A version 1 payload with chunk 0 loaded but none of its bytes in the
   * document, and an undo entry per change in `changes`, oldest first.
   */
  function v1WithMissingChunk(chunk: string, changes: readonly unknown[]) {
    const store = createDocumentStore({
      chunkSize: chunk.length,
      totalFileSize: chunk.length,
      reconcileMode: "none",
    });
    store.dispatch(DocumentActions.loadChunk(0, new TextEncoder().encode(chunk)));
    store.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(chunk.length)));
    const v2 = JSON.parse(JSON.stringify(createCheckpoint(store.reconcileNow())));
    store.dispose();
    const entry = (change: unknown) => ({
      changes: [change],
      selectionBefore: { ranges: [[0, 0]], primaryIndex: 0 },
      selectionAfter: { ranges: [[0, 0]], primaryIndex: 0 },
      timestamp: 0,
    });
    return {
      ...v2,
      version: 1,
      history: {
        limit: Math.max(v2.history.limit, changes.length),
        coalesceTimeout: v2.history.coalesceTimeout,
        undo: changes.map(entry),
        redo: [],
      },
    } as Record<string, unknown>;
  }
  const undoAll = (state: DocumentState) => {
    while (state.history.undoStack !== null) {
      state = documentReducer(state, DocumentActions.undo());
    }
    return getValue(state.pieceTable);
  };

  it("finds removed text in a long run of repeated bytes in linear time", () => {
    // The removed text matches a long prefix at every place in the chunk, so
    // a naive substring search compares about N * N / 2 bytes.
    const chunk = "c" + "a".repeat(N - 1);
    const removed = "a".repeat(N / 2) + "b";
    const started = performance.now();
    const state = restoreCheckpoint(v1WithMissingChunk(chunk, [["d", 0, removed]]));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(undoAll(state)).toBe(removed);
  });

  it("matches removed bytes found nowhere in linear time", () => {
    // No removed byte is missing anywhere, so a byte-by-byte search scans the
    // whole chunk for each of them.
    const chunk = "c" + "a".repeat(5 * N - 1);
    const removed = "b".repeat(N);
    const started = performance.now();
    const state = restoreCheckpoint(v1WithMissingChunk(chunk, [["d", 0, removed]]));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(undoAll(state)).toBe(removed);
  });

  it("bounds the search work over every change of the history", () => {
    // Each change searches the whole missing chunk again.
    const chunk = "c" + "a".repeat(N - 1);
    const changes = Array.from({ length: 20_000 }, () => ["d", 0, "b"]);
    const started = performance.now();
    const state = restoreCheckpoint(v1WithMissingChunk(chunk, changes));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(undoAll(state)).toBe("b".repeat(20_000));
  });

  it("still keys removed text found among the missing chunk's bytes as the chunk's", () => {
    // Chunk 0 is loaded but missing, before resident chunk 1. Text found in
    // chunk 0 takes its key, -1, which a migrated change leaves out; text
    // found nowhere takes the key of the gap, 0.
    const chunk0 = "c" + "a".repeat(49) + "x" + "a".repeat(9) + "yz" + "a".repeat(38);
    const chunk1 = "b".repeat(chunk0.length);
    const store = createDocumentStore({
      chunkSize: chunk0.length,
      totalFileSize: 2 * chunk0.length,
      reconcileMode: "none",
    });
    const encoder = new TextEncoder();
    store.dispatch(DocumentActions.loadChunk(0, encoder.encode(chunk0)));
    store.dispatch(DocumentActions.loadChunk(1, encoder.encode(chunk1)));
    store.dispatch(DocumentActions.delete(byteOffset(0), byteOffset(chunk0.length)));
    const v2 = JSON.parse(JSON.stringify(createCheckpoint(store.reconcileNow())));
    store.dispose();
    const keyOf = (removed: string): unknown => {
      const v1 = {
        ...v2,
        version: 1,
        history: {
          limit: v2.history.limit,
          coalesceTimeout: v2.history.coalesceTimeout,
          undo: [
            {
              changes: [["d", 0, removed]],
              selectionBefore: { ranges: [[0, 0]], primaryIndex: 0 },
              selectionAfter: { ranges: [[0, 0]], primaryIndex: 0 },
              timestamp: 0,
            },
          ],
          redo: [],
        },
      };
      const { data } = migrateCheckpointData(v1, 1);
      const change = (data.history as { undo: { changes: unknown[][] }[] }).undo[0]!.changes[0]!;
      return change[3] ?? -1;
    };
    // In one piece, past the bytes at either end of the chunk.
    expect(keyOf("ayza")).toBe(-1);
    // Byte by byte, each after the one before.
    expect(keyOf("xy")).toBe(-1);
    // Nowhere among them.
    expect(keyOf("qq")).toBe(0);
  });

  it("checks chunk data and change text against the limits before migrating", () => {
    const chunk = "c" + "a".repeat(999);
    const checkpoint = v1WithMissingChunk(chunk, [["d", 0, "b".repeat(500)]]);
    const codeOf = (fn: () => unknown): CheckpointError => {
      try {
        fn();
      } catch (error) {
        return error as CheckpointError;
      }
      throw new Error("expected a CheckpointError");
    };

    const buffer = codeOf(() => restoreCheckpoint(checkpoint, { maxBufferBytes: 999 }));
    expect(buffer.code).toBe("RESOURCE_LIMIT");
    expect(buffer.message).toContain("pieceTable.chunks decoded bytes");

    // The chunk's base64 holds 1336 code units, and the change text 500.
    const strings = codeOf(() => restoreCheckpoint(checkpoint, { maxStringCodeUnits: 1_500 }));
    expect(strings.code).toBe("RESOURCE_LIMIT");
    expect(strings.message).toContain("checkpoint string code units");

    // What migration reads fits these limits, and validation then applies them in full.
    expect(() =>
      restoreCheckpoint(checkpoint, { maxBufferBytes: 1_000, maxStringCodeUnits: 2_000 }),
    ).not.toThrow();
  });
});
