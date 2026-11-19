import type { ReedLogger } from "../../types/state.js";

/**
 * Maximum number of observer-triggered delivery steps drained synchronously.
 * Prevents a consumer callback that always dispatches from monopolizing the
 * current call stack. State changes still commit. Further observer delivery
 * for that cycle is dropped and reported through the configured diagnostics sink.
 */
export const MAX_OBSERVER_REENTRANT_STEPS = 100;

/**
 * Maximum number of actions dispatched in reaction to the events of actions
 * that event handlers dispatched, whose events one synchronous event delivery
 * delivers. The depth limit alone lets a handler that dispatches two actions
 * per event grow the work exponentially before it is reached. The actions a
 * handler dispatches directly, in reaction to an action dispatched outside
 * delivery, are not counted, so a handler can apply any number of them.
 */
export const MAX_OBSERVER_DELIVERED_ACTIONS = 10_000;

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

/**
 * The message of a caught value, for a message of our own. Anything can be
 * thrown, so a value that is not an Error is named by `String`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
