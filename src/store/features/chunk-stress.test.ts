/**
 * Randomized streaming stress tests with reproducible seeds.
 *
 * Run long sequences of chunk loads, evictions, and reloads through
 * StreamingDocumentLoader. After each step, read the actual resident chunk
 * set and compare the assembled text and reconciled line index with a
 * fresh rebuild of those chunks. Log the seed to reproduce a failure.
 *
 * Assert strict red-black balance after every reconciled step, including
 * persistent deletion paths. CRLF configurations allow chunk boundaries
 * to split "\r\n" pairs and exercise line-break repair across chunks.
 */

import { describe, it, expect } from "vitest";
import type { ChunkMetadata } from "../../types/state.js";
import { createDocumentStore } from "./store.js";
import { createStreamingDocumentLoader } from "./streaming-loader.js";
import { getValue } from "../core/piece-table.js";
import { rebuildLineIndex, getLineStartOffset, getCharStartOffset } from "../core/line-index.js";
import {
  generateLargeContent,
  makeDeterministicRng,
  randomInt,
  type LargeContentOptions,
} from "../../../test-utils/large-content.js";
import {
  assertLineIndexInvariants,
  assertLineIndexRedBlackProperties,
  assertPieceTableInvariants,
} from "../../../test-utils/invariants.js";

const encoder = new TextEncoder();

interface Fixture {
  readonly fullContent: string;
  readonly chunkSize: number;
  readonly chunkStrings: readonly string[];
  readonly metadata: readonly ChunkMetadata[];
  readonly totalChunkCount: number;
  loadChunk(chunkIndex: number): Promise<Uint8Array>;
}

/**
 * Build a chunked-document fixture from generated ASCII content.
 *
 * Content is split into byte-aligned chunks of `chunkSize`. Because the
 * generators used here are ASCII-only (1 byte === 1 UTF-16 unit), a chunk's
 * byte slice and its character slice coincide, which keeps the reference model
 * trivial. We assert that invariant so a future switch to a multibyte pattern
 * fails loudly instead of silently mis-slicing.
 */
function buildFixture(options: LargeContentOptions & { chunkSize: number }): Fixture {
  const { chunkSize, ...contentOptions } = options;
  const fullContent = generateLargeContent(contentOptions);
  const bytes = encoder.encode(fullContent);
  expect(bytes.length).toBe(fullContent.length); // ASCII guarantee

  const totalChunkCount = Math.max(1, Math.ceil(bytes.length / chunkSize));
  const chunkStrings: string[] = [];
  const metadata: ChunkMetadata[] = [];
  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, bytes.length);
    const text = fullContent.slice(start, end);
    chunkStrings.push(text);
    metadata.push({
      chunkIndex: i,
      byteLength: end - start,
      lineCount: countNewlines(text),
    });
  }

  return {
    fullContent,
    chunkSize,
    chunkStrings,
    metadata,
    totalChunkCount,
    // Return a fresh copy each call, mirroring a real network/disk loader and
    // guaranteeing the store never aliases the fixture's backing buffer.
    loadChunk: async (chunkIndex: number) =>
      bytes.slice(
        chunkIndex * chunkSize,
        chunkIndex * chunkSize + (metadata[chunkIndex]?.byteLength ?? 0),
      ),
  };
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) count++;
  }
  return count;
}

/**
 * Let fire-and-forget prefetch loads settle. The core consistency invariant
 * holds at any quiescent point (we read the live resident set), but flushing
 * also exercises the post-prefetch state after each viewport move.
 */
async function flushPrefetches(): Promise<void> {
  // A single macrotask drains all pending prefetch microtasks (each prefetch
  // resolves its fetch on the microtask queue, then dispatches synchronously).
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Read the resident chunk set and compare its text, byte length, and
 * reconciled line index with a fresh rebuild of those chunks.
 */
function assertConsistent(
  store: ReturnType<typeof createDocumentStore>,
  fixture: Fixture,
  maxResident: number,
  context: string,
): void {
  const reconciled = store.reconcileNow();
  const pieceTable = reconciled.pieceTable;

  const residentIndices = [...pieceTable.chunkMap.keys()].sort((a, b) => a - b);
  const expectedText = residentIndices.map((i) => fixture.chunkStrings[i]).join("");

  expect(getValue(pieceTable), `${context}: assembled text`).toBe(expectedText);
  expect(pieceTable.totalLength, `${context}: total byte length`).toBe(
    encoder.encode(expectedText).length,
  );

  const rebuilt = rebuildLineIndex(expectedText);
  expect(reconciled.lineIndex.lineCount, `${context}: line count`).toBe(rebuilt.lineCount);
  for (let line = 0; line < rebuilt.lineCount; line++) {
    expect(
      getLineStartOffset(reconciled.lineIndex.root, line),
      `${context}: byte offset L${line}`,
    ).toBe(getLineStartOffset(rebuilt.root, line));
    expect(
      getCharStartOffset(reconciled.lineIndex.root, line),
      `${context}: char offset L${line}`,
    ).toBe(getCharStartOffset(rebuilt.root, line));
  }

  assertLineIndexInvariants(reconciled.lineIndex.root, context);
  assertLineIndexRedBlackProperties(reconciled.lineIndex.root, context);
  assertPieceTableInvariants(pieceTable, context, true);

  // With no user edits, eviction never refuses, so the resident set must stay
  // within the memory ceiling (configured max, or the pinned window if larger).
  expect(pieceTable.chunkMap.size, `${context}: resident chunk count`).toBeLessThanOrEqual(
    maxResident,
  );
}

interface StressConfig {
  readonly name: string;
  readonly content: LargeContentOptions;
  readonly chunkSize: number;
  readonly maxLoadedChunks: number;
  readonly prefetchWindowSize: number;
  readonly maxViewportSpan: number;
  readonly ops: number;
  readonly seeds: readonly number[];
}

const CONFIGS: readonly StressConfig[] = [
  {
    name: "prose / LF / small chunks",
    content: { lineCount: 300, pattern: "prose", lineEnding: "\n" },
    chunkSize: 48,
    maxLoadedChunks: 12,
    prefetchWindowSize: 2,
    maxViewportSpan: 3,
    ops: 140,
    seeds: [1, 101],
  },
  {
    name: "code / LF / medium chunks",
    content: { lineCount: 320, pattern: "code", lineEnding: "\n" },
    chunkSize: 96,
    maxLoadedChunks: 10,
    prefetchWindowSize: 1,
    maxViewportSpan: 2,
    ops: 140,
    seeds: [2, 23],
  },
  {
    name: "random / LF / tiny chunks (many boundary splits)",
    content: { lineCount: 200, pattern: "random", lineEnding: "\n" },
    chunkSize: 24,
    maxLoadedChunks: 16,
    prefetchWindowSize: 3,
    maxViewportSpan: 4,
    ops: 140,
    seeds: [3, 55],
  },
  {
    name: "prose / CRLF / boundaries split \\r\\n pairs",
    content: { lineCount: 260, pattern: "prose", lineEnding: "\r\n" },
    chunkSize: 40,
    maxLoadedChunks: 12,
    prefetchWindowSize: 2,
    maxViewportSpan: 3,
    ops: 140,
    seeds: [4, 88],
  },
];

describe("StreamingDocumentLoader randomized stress", () => {
  for (const config of CONFIGS) {
    for (const seed of config.seeds) {
      it(`stays consistent across load/evict/reload — ${config.name} (seed ${seed})`, async () => {
        const fixture = buildFixture({ ...config.content, seed, chunkSize: config.chunkSize });
        const store = createDocumentStore({
          chunkSize: config.chunkSize,
          totalFileSize: encoder.encode(fixture.fullContent).length,
        });
        const loader = createStreamingDocumentLoader(
          store,
          { loadChunk: fixture.loadChunk, totalChunkCount: fixture.totalChunkCount },
          fixture.metadata,
          {
            prefetchWindowSize: config.prefetchWindowSize,
            chunkManagerConfig: { maxLoadedChunks: config.maxLoadedChunks },
          },
        );

        // The resident ceiling is the configured max, unless a single viewport's
        // pinned window (viewport + prefetch on both sides) is larger.
        const maxWindow = config.maxViewportSpan + 1 + 2 * config.prefetchWindowSize;
        const maxResident = Math.max(config.maxLoadedChunks, maxWindow);

        const rng = makeDeterministicRng(seed);
        try {
          for (let step = 0; step < config.ops; step++) {
            const start = randomInt(rng, 0, fixture.totalChunkCount - 1);
            const end = Math.min(
              start + randomInt(rng, 0, config.maxViewportSpan),
              fixture.totalChunkCount - 1,
            );
            await loader.setViewport(start, end);
            await flushPrefetches();
            assertConsistent(
              store,
              fixture,
              maxResident,
              `${config.name} seed ${seed} step ${step}`,
            );
          }

          // Final sweep back to the top of the document forces a reload of
          // chunks that were certainly evicted during the random walk.
          await loader.setViewport(
            0,
            Math.min(config.maxViewportSpan, fixture.totalChunkCount - 1),
          );
          await flushPrefetches();
          assertConsistent(store, fixture, maxResident, `${config.name} seed ${seed} final`);
        } finally {
          loader.dispose();
        }
      });
    }
  }
});
