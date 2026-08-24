import type { ReedLogger } from "../../types/state.js";

function toReportedError(message: string, error: unknown): Error {
  return new Error(message, { cause: error });
}

function reportGlobally(message: string, error: unknown): void {
  const reportedError = toReportedError(message, error);
  const globalReporter = globalThis.reportError;
  if (typeof globalReporter === "function") {
    try {
      globalReporter(reportedError);
      return;
    } catch (reporterError) {
      console.error("Reed could not report a callback error through globalThis.reportError", {
        reporterError,
        reportedError,
      });
      return;
    }
  }
  console.error(message, error);
}

/** Report a caught consumer callback error without interrupting other callbacks. */
export function reportCaughtError(
  logger: Pick<ReedLogger, "error"> | undefined,
  message: string,
  error: unknown,
): void {
  if (logger?.error !== undefined) {
    try {
      logger.error(message, error);
      return;
    } catch (loggerError) {
      reportGlobally("Reed's error logger threw while reporting a callback failure", loggerError);
    }
  }
  reportGlobally(message, error);
}
