import type { DocumentAction, EvictChunksAction } from "../../types/actions.js";
import type { ReedLogger } from "../../types/state.js";

/**
 * Maximum number of observer-triggered delivery steps drained synchronously.
 * Prevents a consumer callback that always dispatches from monopolizing the
 * current call stack. State changes still commit. Further observer delivery
 * for that cycle is dropped and reported through the configured diagnostics sink.
 */
export const MAX_OBSERVER_REENTRANT_STEPS = 100;

/**
 * Base number of actions dispatched in reaction to the events of actions that
 * event handlers dispatched, whose events one synchronous event delivery
 * delivers. The depth limit alone lets a handler that dispatches two actions
 * per event grow the work exponentially before it is reached. The actions a
 * handler or store listener dispatches directly are not counted, so it can
 * apply any number of them. Each adds MAX_OBSERVER_REENTRANT_STEPS to the
 * limit, so other handlers can react once to each of them, as deep as the
 * depth limit allows, up to MAX_OBSERVER_DELIVERED_ACTIONS_CEILING.
 */
export const MAX_OBSERVER_DELIVERED_ACTIONS = 10_000;

/**
 * Most actions dispatched in reaction to handler-dispatched actions whose
 * events one synchronous delivery delivers, however many actions handlers
 * dispatch directly. Without it, a handler applying a large change set one
 * action at a time would raise the limit far enough that a handler
 * dispatching two actions per event could run for minutes before it is
 * stopped.
 */
export const MAX_OBSERVER_DELIVERED_ACTIONS_CEILING = 100_000;

/** A sink for warnings, which reports a throw from `warn` through `error` when it has one. */
export type WarnSink = Pick<ReedLogger, "warn" | "error">;

// The logger of the ChunkManager that dispatched an EVICT_CHUNKS action, keyed
// by the action's chunk list, while that dispatch call runs (see
// `withEvictionWarnSink`).
const evictionWarnSinks = new WeakMap<readonly number[], WarnSink>();

/**
 * Dispatch `action` with `sink` as the logger that a store without a logger of
 * its own warns through when it commits this eviction and the eviction
 * discards history. A ChunkManager dispatches its evictions this way, so its
 * logger hears of the history they discard through any wrapper that forwards
 * the action, or a shallow copy of it, synchronously.
 *
 * The sink is tied to the action's chunk list, which only the action and its
 * copies share. So an eviction another store commits while the call runs,
 * such as one a listener dispatches, is not credited to this logger, and an
 * eviction from a manager without a logger stays silent even inside another
 * manager's dispatch. Nothing outlives the call, so a later manager on the
 * same store, or a disposed one, neither shares nor keeps the sink. A store
 * with its own logger warns only through that, so the warning comes once.
 */
export function withEvictionWarnSink<T>(
  sink: WarnSink | undefined,
  action: EvictChunksAction,
  dispatch: (action: EvictChunksAction) => T,
): T {
  if (sink?.warn === undefined) return dispatch(action);
  evictionWarnSinks.set(action.chunkIndices, sink);
  try {
    return dispatch(action);
  } finally {
    evictionWarnSinks.delete(action.chunkIndices);
  }
}

/** The sink `withEvictionWarnSink` set for `action`, while its dispatch runs. */
export function evictionWarnSinkFor(action: DocumentAction): WarnSink | undefined {
  return action.type === "EVICT_CHUNKS" ? evictionWarnSinks.get(action.chunkIndices) : undefined;
}

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
