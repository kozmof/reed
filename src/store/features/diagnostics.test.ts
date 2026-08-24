import { afterEach, describe, expect, it, vi } from "vitest";
import { reportCaughtError } from "./diagnostics.js";

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
