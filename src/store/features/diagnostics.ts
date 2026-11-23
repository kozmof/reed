import type { PieceTableState, ReedLogger } from "../../types/state.js";

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

// The logger of the ChunkManager that is dispatching an eviction, keyed by the
// piece table of the state it measured the eviction against, while that
// dispatch call runs (see `withEvictionWarnSink`). Each call registers its own
// entry object, so it can tell whether a store took it. A manager without a
// logger registers an entry without a sink, which keeps an outer one hidden.
interface EvictionWarnEntry {
  readonly sink: WarnSink | undefined;
}
const evictionWarnSinks = new WeakMap<PieceTableState, EvictionWarnEntry>();

/**
 * Run `dispatch` with `sink` as the logger that a store without a logger of
 * its own warns through when it reduces an EVICT_CHUNKS from `from`, the piece
 * table the eviction was measured against, and the eviction discards history.
 * A ChunkManager dispatches its evictions this way, so its logger hears of the
 * history they discard through any wrapper that forwards the eviction
 * synchronously, even one that rebuilds the action, such as by serializing it.
 *
 * Only the store whose state holds `from` reduces from it, so an eviction
 * another store commits while the call runs, such as one a listener
 * dispatches, is not credited to this logger, and an eviction from a manager
 * without a logger stays silent even inside another manager's dispatch. The
 * eviction replaces the piece table, and the store takes the sink once, so an
 * eviction a listener dispatches next is not credited either. A wrapper that
 * changes the document before it forwards the eviction leaves the sink unused.
 * Nothing outlives the call, so a later manager on the same store, or a
 * disposed one, neither shares nor keeps the sink. A store with its own logger
 * warns only through that, so the warning comes once.
 *
 * A call nested inside another for the same `from`, such as a second manager
 * on the same store that a wrapper runs before forwarding the first one's
 * eviction, sets its own sink for the call, a silent one when its manager has
 * no logger. When the call ends, it puts back the outer sink only if no store
 * took its own: an eviction that took it replaced the piece table, so the
 * outer manager's eviction is no longer measured against `from`.
 */
export function withEvictionWarnSink<T>(
  sink: WarnSink | undefined,
  from: PieceTableState,
  dispatch: () => T,
): T {
  const outer = evictionWarnSinks.get(from);
  const entry: EvictionWarnEntry = { sink: sink?.warn === undefined ? undefined : sink };
  evictionWarnSinks.set(from, entry);
  try {
    return dispatch();
  } finally {
    // Only an entry still in place was not taken. A nested call restores the
    // entry it found, so this finds its own entry unless a store took it.
    if (evictionWarnSinks.get(from) === entry) {
      if (outer === undefined) evictionWarnSinks.delete(from);
      else evictionWarnSinks.set(from, outer);
    }
  }
}

/**
 * Take the sink `withEvictionWarnSink` set for an eviction reduced from
 * `from`, while its dispatch runs. It is taken once, and is undefined when the
 * dispatching manager has no logger.
 */
export function evictionWarnSinkFor(from: PieceTableState): WarnSink | undefined {
  const entry = evictionWarnSinks.get(from);
  if (entry === undefined) return undefined;
  evictionWarnSinks.delete(from);
  return entry.sink;
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
 * Warn through `sink`, reporting a throw from `warn` through `sink.error`, or
 * globally when it has none, instead of letting it escape. For warnings about
 * work that has already happened, which a logger's failure must not undo or
 * interrupt.
 */
export function warnSafely(
  sink: WarnSink | undefined,
  message: string,
  failureMessage: string,
): void {
  if (sink?.warn === undefined) return;
  try {
    sink.warn(message);
  } catch (error) {
    reportCaughtError(sink, failureMessage, error);
  }
}

/**
 * The message of a caught value, for a message of our own. Anything can be
 * thrown, so a value that is not an Error is named by `String`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
