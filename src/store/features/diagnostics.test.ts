import { afterEach, describe, expect, it, vi } from "vitest";
import type { PieceTableState } from "../../types/state.js";
import { evictionWarnSinkFor, reportCaughtError, withEvictionWarnSink } from "./diagnostics.js";

describe("reportCaughtError", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses a configured logger", () => {
    const error = new Error("callback failed");
    const logger = { error: vi.fn() };

    reportCaughtError(logger, "Store listener threw", error);

    expect(logger.error).toHaveBeenCalledWith("Store listener threw", error);
  });

  it("uses the global reporter when no logger is configured", () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const cause = new Error("callback failed");

    reportCaughtError(undefined, "Event handler threw", cause);

    expect(reportError).toHaveBeenCalledTimes(1);
    const reported = reportError.mock.calls[0]![0] as Error;
    expect(reported.message).toBe("Event handler threw");
    expect(reported.cause).toBe(cause);
  });

  it("reports both the logger failure and the original callback failure", () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const loggerFailure = new Error("logger failed");
    const logger = {
      error: vi.fn(() => {
        throw loggerFailure;
      }),
    };

    reportCaughtError(logger, "Store listener threw", new Error("callback failed"));

    expect(reportError).toHaveBeenCalledTimes(2);
    expect((reportError.mock.calls[0]![0] as Error).cause).toBe(loggerFailure);
  });

  it("falls back to the console when the global reporter throws", () => {
    vi.stubGlobal(
      "reportError",
      vi.fn(() => {
        throw new Error("reporter failed");
      }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    reportCaughtError(undefined, "Event handler threw", new Error("callback failed"));

    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("falls back to the console when no global reporter exists", () => {
    vi.stubGlobal("reportError", undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const cause = new Error("callback failed");
    reportCaughtError(undefined, "Store listener threw", cause);

    expect(consoleError).toHaveBeenCalledWith("Store listener threw", cause);
  });
});

describe("withEvictionWarnSink", () => {
  const pieceTable = () => ({}) as PieceTableState;

  it("lets a store take the sink once, only while the call runs", () => {
    const from = pieceTable();
    const sink = { warn: vi.fn() };
    withEvictionWarnSink(sink, from, () => {
      expect(evictionWarnSinkFor(from)).toBe(sink);
      expect(evictionWarnSinkFor(from)).toBeUndefined();
    });
    withEvictionWarnSink(sink, from, () => {});
    expect(evictionWarnSinkFor(from)).toBeUndefined();
  });

  it("puts back the outer sink when a nested call for the same piece table leaves its own", () => {
    const from = pieceTable();
    const outer = { warn: vi.fn() };
    withEvictionWarnSink(outer, from, () => {
      // The nested call's eviction is refused, so no store takes its sink.
      withEvictionWarnSink({ warn: vi.fn() }, from, () => {});
      expect(evictionWarnSinkFor(from)).toBe(outer);
    });
    expect(evictionWarnSinkFor(from)).toBeUndefined();
  });

  it("gives a nested call's eviction the nested sink, and leaves the outer one taken", () => {
    const from = pieceTable();
    const outer = { warn: vi.fn() };
    const inner = { warn: vi.fn() };
    withEvictionWarnSink(outer, from, () => {
      withEvictionWarnSink(inner, from, () => {
        expect(evictionWarnSinkFor(from)).toBe(inner);
      });
      // The nested eviction replaced the piece table, so nothing reduces from
      // `from` again for the outer manager.
      expect(evictionWarnSinkFor(from)).toBeUndefined();
    });
    expect(evictionWarnSinkFor(from)).toBeUndefined();
  });

  it("keeps an eviction from a manager without a logger silent inside another's dispatch", () => {
    const from = pieceTable();
    const outer = { warn: vi.fn() };
    withEvictionWarnSink(outer, from, () => {
      withEvictionWarnSink(undefined, from, () => {
        expect(evictionWarnSinkFor(from)).toBeUndefined();
      });
      expect(evictionWarnSinkFor(from)).toBeUndefined();
    });
  });

  it("puts back the outer sink when a nested call without a logger leaves its own", () => {
    const from = pieceTable();
    const outer = { warn: vi.fn() };
    withEvictionWarnSink(outer, from, () => {
      withEvictionWarnSink(undefined, from, () => {});
      expect(evictionWarnSinkFor(from)).toBe(outer);
    });
  });

  it("does not put back an outer sink a store already took", () => {
    const from = pieceTable();
    const outer = { warn: vi.fn() };
    withEvictionWarnSink(outer, from, () => {
      expect(evictionWarnSinkFor(from)).toBe(outer);
      withEvictionWarnSink({ warn: vi.fn() }, from, () => {});
      expect(evictionWarnSinkFor(from)).toBeUndefined();
    });
  });
});
