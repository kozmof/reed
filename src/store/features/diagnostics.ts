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
 * depth limit allows.
 */
export const MAX_OBSERVER_DELIVERED_ACTIONS = 10_000;

/**
 * Loggers a store without a logger of its own warns through when an eviction
 * discards history. A ChunkManager lends its logger to the store it manages,
 * so a manager configured with a logger still hears of the loss, and a store
 * with its own logger warns only through that, so the warning comes once.
 */
export interface EvictionWarnLenders {
  /** The lent loggers, earliest first. The store warns through the first. */
  readonly loggers: Pick<ReedLogger, "warn">[];
}

// Keyed by every store object a caller can hold: the base store and its event
// wrapper share one entry.
const evictionWarnLenders = new WeakMap<object, EvictionWarnLenders>();

/**
 * Register `store` to accept lent loggers, sharing `base`'s registration when
 * `store` wraps it, and return the registration.
 */
export function acceptEvictionWarnLenders(store: object, base?: object): EvictionWarnLenders {
  const lenders = (base === undefined ? undefined : evictionWarnLenders.get(base)) ?? {
    loggers: [],
  };
  evictionWarnLenders.set(store, lenders);
  return lenders;
}

/**
 * Lend `logger` to `store` for its eviction warnings, and return a function
 * that takes it back. A store Reed did not build, such as a wrapper of one,
 * accepts none, and then `logger` hears nothing.
 */
export function lendEvictionWarnLogger(
  store: object,
  logger: Pick<ReedLogger, "warn">,
): () => void {
  const lenders = evictionWarnLenders.get(store);
  if (lenders === undefined) return () => {};
  // A wrapper object per loan, so lending one logger twice takes back one.
  const loan: Pick<ReedLogger, "warn"> = { warn: (...args) => logger.warn?.(...args) };
  lenders.loggers.push(loan);
  return () => {
    const at = lenders.loggers.indexOf(loan);
    if (at >= 0) lenders.loggers.splice(at, 1);
  };
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
