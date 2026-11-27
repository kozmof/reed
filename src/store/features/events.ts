import { PersistentMap } from "../core/persistent-map.js";
import { transformRemoteRanges } from "./remote-ranges.js";
/**
 * Event system for the Reed document editor.
 * Provides a pub/sub mechanism for document changes and editor events.
 */

import type { DocumentState, ReedLogger } from "../../types/state.js";
import type { ContentChangeAction, DocumentAction } from "../../types/actions.js";
import { byteOffset, type ByteOffset, type AttentionID } from "../../types/branded.js";
import { utf8ByteLength } from "../core/encoding.js";
import { MAX_OBSERVER_REENTRANT_STEPS, reportCaughtError } from "./diagnostics.js";

// =============================================================================
// Event Types
// =============================================================================

/**
 * Describes the action that produced an event and the other events that
 * action produced. Every event from one action shares one frozen origin
 * object, so `a.origin === b.origin` tells whether two events came from the
 * same action.
 *
 * `types` is fixed before the first of the action's events is delivered. A
 * handler can use it to check for events that arrive after its own, such as
 * the `history-change` that follows a `selection-change` on undo.
 *
 * @example
 * ```ts
 * doc.addEventListener("selection-change", (e) => {
 *   if (e.origin.action.type === "SET_SELECTION") return; // explicit move
 *   if (e.origin.types.includes("content-change")) {
 *     // the selection followed an edit
 *   }
 * });
 * ```
 */
export interface EventOrigin {
  /**
   * Identifies the action within its store. Every event from one action has
   * the same id. An action delivered later has a larger id, including one a
   * store listener or event handler dispatched in reaction. An action that
   * emits no events still uses an id, so ids skip values. Use them to
   * correlate events, not to count actions.
   */
  readonly id: number;
  /**
   * The action whose commit produced the event. It is the object passed to
   * `dispatch`, not a copy, and the origin's freeze does not reach it.
   * `DocumentActions` creates frozen actions. If you build actions yourself,
   * do not change one after dispatching it, or events that hold it report the
   * change. An event keeps the whole action alive, payload included. An
   * event from `LOAD_CHUNK` or `LOAD_CHUNKS` holds the caller's chunk bytes,
   * and the document stores its own copy. An event from `APPLY_REMOTE` holds the change set. When you keep
   * events for a long time, copy out only what you need, such as
   * `origin.action.type`.
   */
  readonly action: DocumentAction;
  /**
   * Every event type the action emits, in delivery order, including the event
   * that carries this origin. It lists the events the store prepared. A
   * handler that disposes the store stops the rest of the action's events, so
   * those never arrive.
   */
  readonly types: readonly (keyof DocumentEventMap)[];
  /**
   * Identifies the outermost transaction open when the action was dispatched,
   * or null when none was open. Every action in one `batch` has the same id.
   * So does every action between an outermost `beginTransaction` and its
   * `commitTransaction`, nested transactions included. A later transaction
   * has a larger id. Rolling back the outermost transaction discards all of
   * its events, so its id never appears. Rolling back a nested transaction
   * discards only that transaction's events. The outer transaction's events
   * still carry the id when it commits. These ids are counted separately from
   * `id`.
   */
  readonly transactionId: number | null;
}

/**
 * Base event interface.
 */
export interface DocumentEvent {
  readonly type: keyof DocumentEventMap;
  readonly timestamp: number;
  /**
   * The action that produced this event, and the other events it produced.
   * Event stores set it on every event they emit, and a
   * `DocumentStoreWithEvents` types it as required on its listeners and its
   * `events` emitter (see `StoreEvent`). It is absent on events created
   * without one, such as by an event factory called without `origin`.
   */
  readonly origin?: EventOrigin;
}

/**
 * Fired when document content changes.
 */
export interface ContentChangeEvent extends DocumentEvent {
  readonly type: "content-change";
  /** The action that caused the change */
  readonly action: ContentChangeAction;
  /** Document state before the change */
  readonly prevState: DocumentState;
  /** Document state after the change */
  readonly nextState: DocumentState;
  /**
   * Disjoint byte ranges affected by this change, each as [start, end).
   * For INSERT / DELETE / REPLACE, this is always a single-element array.
   * For APPLY_REMOTE with non-contiguous changes, each changed sub-range is
   * listed separately so consumers can skip unaffected regions.
   */
  readonly affectedRanges: readonly (readonly [ByteOffset, ByteOffset])[];
}

/**
 * Fired when the selection changes: on SET_SELECTION, and whenever another
 * action moves the selection, such as INSERT, DELETE, REPLACE, or APPLY_REMOTE
 * moving it past the edited text, UNDO or REDO restoring it, or LOAD_CHUNK,
 * LOAD_CHUNKS, EVICT_CHUNK, or EVICT_CHUNKS shifting it. An action that leaves
 * the selection in place fires nothing, including a SET_SELECTION with the
 * ranges the selection already has. An editor that sets the caret an edit
 * already moved to therefore gets one event per edit.
 *
 * `origin.action` names the action that moved the selection.
 * `origin.types` lists the other events that action fires, such as
 * `content-change` for an edit or `history-change` for undo and redo.
 */
export interface SelectionChangeEvent extends DocumentEvent {
  readonly type: "selection-change";
  readonly prevState: DocumentState;
  readonly nextState: DocumentState;
}

/**
 * Fired when undo/redo occurs.
 *
 * `nextState.selection` holds the cursor position that Reed restored from
 * the history entry. Subscribe to this event once to keep application cursor
 * state in sync with undo/redo, rather than calling getSnapshot() after every
 * undo/redo dispatch.
 *
 * @example
 * ```ts
 * store.addEventListener('history-change', ({ nextState }) => {
 *   const head = query.getSelectionHead(nextState);
 *   if (head !== undefined) {
 *     const text = scan.getValue(nextState.pieceTable) as string;
 *     const charOff = store.byteToCharOffset(text, position.rawByteOffset(head));
 *     setCursor(clampNormal(charOff, text));
 *   }
 * });
 * ```
 */
export interface HistoryChangeEvent extends DocumentEvent {
  readonly type: "history-change";
  readonly direction: "undo" | "redo";
  readonly prevState: DocumentState;
  readonly nextState: DocumentState;
}

/**
 * Fired when an action discards undo or redo entries without undoing or
 * redoing them, so the undo and redo counts drop:
 * - EVICT_CHUNK or EVICT_CHUNKS discards the entries that point into the
 *   chunks it evicts, under the `"drop"` eviction policy, or under
 *   `"pin-bounded"` with `overLimit` or through EVICT_CHUNKS.
 * - UNDO or REDO meets an entry that no longer resolves inside the document:
 *   that entry and the entries behind it on the same stack are dropped.
 * - APPLY_REMOTE clears both stacks, since history is not rebased against
 *   remote edits.
 * - HISTORY_CLEAR clears both stacks.
 *
 * Nothing is undone or redone. Dropping history does not move the selection,
 * but the same eviction can: an endpoint inside the evicted chunk collapses to
 * where the chunk was, and `selection-change` fires for that separately.
 */
export interface HistoryDropEvent extends DocumentEvent {
  readonly type: "history-drop";
  readonly prevState: DocumentState;
  readonly nextState: DocumentState;
  /** Undo entries discarded. */
  readonly undoDropped: number;
  /** Redo entries discarded. */
  readonly redoDropped: number;
}

/**
 * Fired when stored attention state changes.
 *
 * Creating or deleting an attention changes its stored state. Content edits
 * can also rewrite points when pieces split or points are re-anchored after deletion.
 * `changedIds` lists all created, deleted, or migrated attentions.
 *
 * An edit before a tracked span can shift its resolved offset without changing
 * its stored points, so it does not fire this event. Subscribe to `content-change`
 * to recompute resolved positions on every edit.
 */
export interface AttentionChangeEvent extends DocumentEvent {
  readonly type: "attention-change";
  readonly prevState: DocumentState;
  readonly nextState: DocumentState;
  /** IDs of attentions created, deleted, or re-anchored by this change. */
  readonly changedIds: readonly AttentionID[];
}

/**
 * Fired when document is saved.
 */
export interface SaveEvent extends DocumentEvent {
  readonly type: "save";
  readonly state: DocumentState;
}

/**
 * Fired when document dirty state changes.
 */
export interface DirtyChangeEvent extends DocumentEvent {
  readonly type: "dirty-change";
  readonly isDirty: boolean;
  readonly state: DocumentState;
}

/**
 * Union of all document events.
 */
export type AnyDocumentEvent =
  | ContentChangeEvent
  | SelectionChangeEvent
  | HistoryChangeEvent
  | HistoryDropEvent
  | AttentionChangeEvent
  | SaveEvent
  | DirtyChangeEvent;

/**
 * Event type to handler mapping.
 */
export interface DocumentEventMap {
  "content-change": ContentChangeEvent;
  "selection-change": SelectionChangeEvent;
  "history-change": HistoryChangeEvent;
  "history-drop": HistoryDropEvent;
  "attention-change": AttentionChangeEvent;
  save: SaveEvent;
  "dirty-change": DirtyChangeEvent;
}

/**
 * An event as a `DocumentStoreWithEvents` listener receives it. The store sets
 * `origin` on every event it emits, so `origin` is required here.
 */
export type StoreEvent<E extends AnyDocumentEvent> = E & { readonly origin: EventOrigin };

/**
 * Event type to the event a `DocumentStoreWithEvents` listener receives.
 */
export type StoreEventMap = {
  readonly [K in keyof DocumentEventMap]: StoreEvent<DocumentEventMap[K]>;
};

// =============================================================================
// Event Handler Types
// =============================================================================

/**
 * Handler function for a specific event type.
 */
export type EventHandler<T extends AnyDocumentEvent> = (event: T) => void;

/**
 * Unsubscribe function returned by addEventListener.
 */
export type Unsubscribe = () => void;

// =============================================================================
// Event Emitter
// =============================================================================

/**
 * Event emitter for document events.
 * Provides type-safe pub/sub for all document events.
 */
export interface DocumentEventEmitter {
  /**
   * Add an event listener for a specific event type.
   * @returns Unsubscribe function
   */
  addEventListener<K extends keyof DocumentEventMap>(
    type: K,
    handler: EventHandler<DocumentEventMap[K]>,
  ): Unsubscribe;

  /**
   * Remove an event listener.
   */
  removeEventListener<K extends keyof DocumentEventMap>(
    type: K,
    handler: EventHandler<DocumentEventMap[K]>,
  ): void;

  /**
   * Emit an event to all registered handlers.
   */
  emit<K extends keyof DocumentEventMap>(type: K, event: DocumentEventMap[K]): void;

  /**
   * Remove all event listeners.
   */
  removeAllListeners(): void;
}

/**
 * The event emitter of a `DocumentStoreWithEvents`, at `store.events`. It is
 * the emitter `addEventListener` registers handlers on, so every event it
 * carries has an `origin`. Handlers receive a `StoreEvent`, and `emit`
 * requires one. To emit an event yourself, pass an origin to its factory.
 *
 * @example
 * ```ts
 * const state = doc.getSnapshot();
 * const origin = { id: 0, action, types: ["selection-change"], transactionId: null } as const;
 * doc.events.emit("selection-change", createSelectionChangeEvent(state, state, origin));
 * ```
 */
export interface StoreEventEmitter {
  /**
   * Add an event listener for a specific event type.
   * @returns Unsubscribe function
   */
  addEventListener<K extends keyof StoreEventMap>(
    type: K,
    handler: EventHandler<StoreEventMap[K]>,
  ): Unsubscribe;

  /**
   * Remove an event listener.
   */
  removeEventListener<K extends keyof StoreEventMap>(
    type: K,
    handler: EventHandler<StoreEventMap[K]>,
  ): void;

  /**
   * Emit an event to all registered handlers. The event must carry an
   * `origin`, as every event the store emits does. An event without one,
   * passed through a wider type such as `DocumentEventEmitter`, is reported
   * through the store's logger and dropped.
   */
  emit<K extends keyof StoreEventMap>(type: K, event: StoreEventMap[K]): void;

  /**
   * Remove all event listeners.
   */
  removeAllListeners(): void;
}

/**
 * Create a new document event emitter.
 */
export function createEventEmitter(logger?: Pick<ReedLogger, "error">): DocumentEventEmitter {
  return createProbedEventEmitter(logger).emitter;
}

/**
 * Create an event emitter typed as a store's `events`, for a store wrapper or
 * test double that implements `DocumentStoreWithEvents` itself. It behaves as
 * `createEventEmitter` does, except that its types require an `origin` on
 * every event, and `emit` reports and drops an event without one.
 */
export function createStoreEventEmitter(logger?: Pick<ReedLogger, "error">): StoreEventEmitter {
  return guardStoreEventEmitter(createEventEmitter(logger), logger);
}

/**
 * Wrap `emitter` so that its `emit` delivers only events with an `origin`.
 * Code that widens the result to a `DocumentEventEmitter` can still pass an
 * event without one. `emit` reports such an event through `logger` and drops
 * it, so no handler receives an event without an origin.
 *
 * The handlers registered through the wrapper reach `emitter` unchanged.
 * Nothing else may emit on `emitter`, or its handlers could receive an event
 * without an origin.
 */
export function guardStoreEventEmitter(
  emitter: DocumentEventEmitter,
  logger: Pick<ReedLogger, "error"> | undefined,
): StoreEventEmitter {
  // Every event reaching `emitter` passes the check in `emit`, so a handler
  // typed for a StoreEvent receives one.
  type Handler = EventHandler<AnyDocumentEvent>;
  return {
    addEventListener: (type, handler) => emitter.addEventListener(type, handler as Handler),
    removeEventListener: (type, handler) => emitter.removeEventListener(type, handler as Handler),
    emit(type, event) {
      const origin: unknown = (event as DocumentEvent).origin;
      if (typeof origin !== "object" || origin === null) {
        reportCaughtError(
          logger,
          `Dropped a '${type}' event without an origin`,
          new TypeError("A store's events.emit requires an event with an origin"),
        );
        return;
      }
      emitter.emit(type, event);
    },
    removeAllListeners: () => emitter.removeAllListeners(),
  };
}

/**
 * An emitter together with a check for whether any handler is registered.
 * The event store uses it to skip building events no handler can receive.
 */
export interface ProbedEventEmitter {
  readonly emitter: DocumentEventEmitter;
  readonly hasListeners: () => boolean;
}

/** Create an emitter as `createEventEmitter` does, with a listener check. */
export function createProbedEventEmitter(logger?: Pick<ReedLogger, "error">): ProbedEventEmitter {
  const handlers = new Map<string, Set<EventHandler<AnyDocumentEvent>>>();
  type QueuedEvent = {
    [K in keyof DocumentEventMap]: { readonly type: K; readonly event: DocumentEventMap[K] };
  }[keyof DocumentEventMap];
  const pendingEvents: QueuedEvent[] = [];
  let emitting = false;

  function drainEvents(): void {
    if (emitting) return;
    emitting = true;
    let deliverySteps = 0;
    try {
      while (pendingEvents.length > 0) {
        if (deliverySteps >= MAX_OBSERVER_REENTRANT_STEPS) {
          pendingEvents.length = 0;
          reportCaughtError(
            logger,
            "Document event cycle exceeded the re-entrancy limit",
            new Error(
              `Event handlers queued more than ${MAX_OBSERVER_REENTRANT_STEPS} synchronous events`,
            ),
          );
          break;
        }

        const queued = pendingEvents.shift()!;
        const typeHandlers = handlers.get(queued.type);
        if (typeHandlers) {
          // Snapshot handlers to guarantee stable delivery under subscribe/unsubscribe churn.
          const handlersSnapshot = Array.from(typeHandlers);
          for (const handler of handlersSnapshot) {
            try {
              handler(queued.event);
            } catch (error) {
              reportCaughtError(logger, `Event handler error for '${queued.type}'`, error);
            }
          }
        }
        deliverySteps++;
      }
    } finally {
      emitting = false;
    }
  }

  const emitter: DocumentEventEmitter = {
    addEventListener<K extends keyof DocumentEventMap>(
      type: K,
      handler: EventHandler<DocumentEventMap[K]>,
    ): Unsubscribe {
      let typeHandlers = handlers.get(type);
      if (!typeHandlers) {
        typeHandlers = new Set();
        handlers.set(type, typeHandlers);
      }
      typeHandlers.add(handler as EventHandler<AnyDocumentEvent>);

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        typeHandlers.delete(handler as EventHandler<AnyDocumentEvent>);
        // A stale unsubscribe may outlive removeAllListeners() and a later
        // registration for the same event type. Only remove the map entry when
        // it still points at the Set this subscription originally joined.
        if (typeHandlers.size === 0 && handlers.get(type) === typeHandlers) {
          handlers.delete(type);
        }
      };
    },

    removeEventListener<K extends keyof DocumentEventMap>(
      type: K,
      handler: EventHandler<DocumentEventMap[K]>,
    ): void {
      const typeHandlers = handlers.get(type);
      if (typeHandlers) {
        typeHandlers.delete(handler as EventHandler<AnyDocumentEvent>);
        if (typeHandlers.size === 0) {
          handlers.delete(type);
        }
      }
    },

    emit<K extends keyof DocumentEventMap>(type: K, event: DocumentEventMap[K]): void {
      pendingEvents.push({ type, event } as QueuedEvent);
      drainEvents();
    },

    removeAllListeners(): void {
      handlers.clear();
    },
  };
  // Emptied Sets leave the map, but checking sizes does not rely on it.
  const hasListeners = (): boolean => {
    for (const typeHandlers of handlers.values()) if (typeHandlers.size > 0) return true;
    return false;
  };
  return { emitter, hasListeners };
}

// =============================================================================
// Event Helpers
// =============================================================================
//
// Each factory takes an optional `origin` as its last argument. The event
// store always passes one. An event created without it has no `origin` property.
// Called with an origin, a factory returns a `StoreEvent`, the type a store's
// `events.emit` requires.
// Each factory writes `origin` into the event literal instead of adding it to
// the event afterward, so every event the store emits keeps one object shape.

/**
 * Create a content change event.
 */
export function createContentChangeEvent(
  action: ContentChangeAction,
  prevState: DocumentState,
  nextState: DocumentState,
  affectedRanges: readonly (readonly [ByteOffset, ByteOffset])[],
  origin: EventOrigin,
): StoreEvent<ContentChangeEvent>;
export function createContentChangeEvent(
  action: ContentChangeAction,
  prevState: DocumentState,
  nextState: DocumentState,
  affectedRanges: readonly (readonly [ByteOffset, ByteOffset])[],
  origin?: EventOrigin,
): ContentChangeEvent;
export function createContentChangeEvent(
  action: ContentChangeAction,
  prevState: DocumentState,
  nextState: DocumentState,
  affectedRanges: readonly (readonly [ByteOffset, ByteOffset])[],
  origin?: EventOrigin,
): ContentChangeEvent {
  const timestamp = Date.now();
  return Object.freeze(
    origin === undefined
      ? { type: "content-change", timestamp, action, prevState, nextState, affectedRanges }
      : { type: "content-change", timestamp, action, prevState, nextState, affectedRanges, origin },
  );
}

/**
 * Create a selection change event.
 */
export function createSelectionChangeEvent(
  prevState: DocumentState,
  nextState: DocumentState,
  origin: EventOrigin,
): StoreEvent<SelectionChangeEvent>;
export function createSelectionChangeEvent(
  prevState: DocumentState,
  nextState: DocumentState,
  origin?: EventOrigin,
): SelectionChangeEvent;
export function createSelectionChangeEvent(
  prevState: DocumentState,
  nextState: DocumentState,
  origin?: EventOrigin,
): SelectionChangeEvent {
  const timestamp = Date.now();
  return Object.freeze(
    origin === undefined
      ? { type: "selection-change", timestamp, prevState, nextState }
      : { type: "selection-change", timestamp, prevState, nextState, origin },
  );
}

/**
 * Create a history change event.
 */
export function createHistoryChangeEvent(
  direction: HistoryChangeEvent["direction"],
  prevState: DocumentState,
  nextState: DocumentState,
  origin: EventOrigin,
): StoreEvent<HistoryChangeEvent>;
export function createHistoryChangeEvent(
  direction: HistoryChangeEvent["direction"],
  prevState: DocumentState,
  nextState: DocumentState,
  origin?: EventOrigin,
): HistoryChangeEvent;
export function createHistoryChangeEvent(
  direction: HistoryChangeEvent["direction"],
  prevState: DocumentState,
  nextState: DocumentState,
  origin?: EventOrigin,
): HistoryChangeEvent {
  const timestamp = Date.now();
  return Object.freeze(
    origin === undefined
      ? { type: "history-change", timestamp, direction, prevState, nextState }
      : { type: "history-change", timestamp, direction, prevState, nextState, origin },
  );
}

/**
 * Create a history drop event. `dropped` holds the undo and redo entries the
 * action discarded without undoing or redoing them, as the reducer counted
 * them, so the event and the store's eviction warning report the same loss.
 */
export function createHistoryDropEvent(
  prevState: DocumentState,
  nextState: DocumentState,
  dropped: { readonly undo: number; readonly redo: number },
  origin: EventOrigin,
): StoreEvent<HistoryDropEvent>;
export function createHistoryDropEvent(
  prevState: DocumentState,
  nextState: DocumentState,
  dropped: { readonly undo: number; readonly redo: number },
  origin?: EventOrigin,
): HistoryDropEvent;
export function createHistoryDropEvent(
  prevState: DocumentState,
  nextState: DocumentState,
  dropped: { readonly undo: number; readonly redo: number },
  origin?: EventOrigin,
): HistoryDropEvent {
  const timestamp = Date.now();
  const undoDropped = dropped.undo;
  const redoDropped = dropped.redo;
  return Object.freeze(
    origin === undefined
      ? { type: "history-drop", timestamp, prevState, nextState, undoDropped, redoDropped }
      : { type: "history-drop", timestamp, prevState, nextState, undoDropped, redoDropped, origin },
  );
}

/**
 * Compute the IDs whose attention entry differs between two layer states.
 *
 * Covers created (present only in next), deleted (present only in prev), and
 * migrated (same ID, different frozen `Attention` object) attentions. Copy-on-
 * write guarantees an unchanged attention keeps the same object reference, so a
 * reference comparison is sufficient. Persistent maps skip shared subtrees.
 * Externally supplied maps require a full scan.
 */
export function diffChangedAttentionIds(
  prevState: DocumentState,
  nextState: DocumentState,
): readonly AttentionID[] {
  const prev = prevState.attention.attentions;
  const next = nextState.attention.attentions;
  if (prev === next) return [];

  if (prev instanceof PersistentMap && next instanceof PersistentMap) return next.changedKeys(prev);

  const changed: AttentionID[] = [];
  for (const [id, attention] of next) {
    if (prev.get(id) !== attention) changed.push(id); // created or migrated
  }
  for (const [id] of prev) {
    if (!next.has(id)) changed.push(id); // deleted
  }
  return changed;
}

/**
 * Create an attention change event.
 */
export function createAttentionChangeEvent(
  prevState: DocumentState,
  nextState: DocumentState,
  changedIds: readonly AttentionID[],
  origin: EventOrigin,
): StoreEvent<AttentionChangeEvent>;
export function createAttentionChangeEvent(
  prevState: DocumentState,
  nextState: DocumentState,
  changedIds: readonly AttentionID[],
  origin?: EventOrigin,
): AttentionChangeEvent;
export function createAttentionChangeEvent(
  prevState: DocumentState,
  nextState: DocumentState,
  changedIds: readonly AttentionID[],
  origin?: EventOrigin,
): AttentionChangeEvent {
  const timestamp = Date.now();
  return Object.freeze(
    origin === undefined
      ? { type: "attention-change", timestamp, prevState, nextState, changedIds }
      : { type: "attention-change", timestamp, prevState, nextState, changedIds, origin },
  );
}

/**
 * Create a save event.
 */
export function createSaveEvent(state: DocumentState, origin: EventOrigin): StoreEvent<SaveEvent>;
export function createSaveEvent(state: DocumentState, origin?: EventOrigin): SaveEvent;
export function createSaveEvent(state: DocumentState, origin?: EventOrigin): SaveEvent {
  const timestamp = Date.now();
  return Object.freeze(
    origin === undefined
      ? { type: "save", timestamp, state }
      : { type: "save", timestamp, state, origin },
  );
}

/**
 * Create a dirty change event.
 */
export function createDirtyChangeEvent(
  isDirty: boolean,
  state: DocumentState,
  origin: EventOrigin,
): StoreEvent<DirtyChangeEvent>;
export function createDirtyChangeEvent(
  isDirty: boolean,
  state: DocumentState,
  origin?: EventOrigin,
): DirtyChangeEvent;
export function createDirtyChangeEvent(
  isDirty: boolean,
  state: DocumentState,
  origin?: EventOrigin,
): DirtyChangeEvent {
  const timestamp = Date.now();
  return Object.freeze(
    origin === undefined
      ? { type: "dirty-change", timestamp, isDirty, state }
      : { type: "dirty-change", timestamp, isDirty, state, origin },
  );
}

function clampPosition(position: number, totalLength: number): ByteOffset {
  if (!Number.isFinite(position)) return byteOffset(0);
  return safeByteOffset(Math.max(0, Math.min(position, totalLength)));
}

function safeByteOffset(position: number): ByteOffset {
  if (!Number.isFinite(position)) return byteOffset(0);
  return byteOffset(Math.max(0, Math.min(Math.trunc(position), Number.MAX_SAFE_INTEGER)));
}

function addOffset(position: number, length: number): ByteOffset {
  return safeByteOffset(position + length);
}

function normalizeLineEndings(text: string, lineEnding: "lf" | "crlf" | "cr"): string {
  if (!text.includes("\r") && !text.includes("\n")) return text;
  const lf = text.replace(/\r\n|\r/g, "\n");
  switch (lineEnding) {
    case "lf":
      return lf;
    case "crlf":
      return lf.replace(/\n/g, "\r\n");
    case "cr":
      return lf.replace(/\n/g, "\r");
  }
}

function insertedTextForState(actionText: string, state: DocumentState): string {
  return state.metadata.normalizeInsertedLineEndings
    ? normalizeLineEndings(actionText, state.metadata.lineEnding)
    : actionText;
}

/**
 * Determine the affected byte ranges for a document action.
 *
 * Returns one range per independently changed region so consumers can avoid
 * re-rendering unaffected regions. For INSERT / DELETE / REPLACE the result is
 * always a single-element array. For APPLY_REMOTE with non-contiguous changes,
 * each change contributes its own [start, end) range.
 */
export function getAffectedRanges(
  action: DocumentAction,
  prevState?: DocumentState,
  nextState?: DocumentState,
): readonly (readonly [ByteOffset, ByteOffset])[] {
  switch (action.type) {
    case "INSERT": {
      const start =
        prevState === undefined
          ? action.start
          : clampPosition(action.start, prevState.pieceTable.totalLength);
      const text =
        prevState === undefined ? action.text : insertedTextForState(action.text, prevState);
      return [[start, addOffset(start, utf8ByteLength(text))]];
    }
    case "DELETE": {
      if (prevState === undefined) return [[action.start, action.end]];
      const start = clampPosition(action.start, prevState.pieceTable.totalLength);
      const end = clampPosition(action.end, prevState.pieceTable.totalLength);
      return [[start, end]];
    }
    case "REPLACE": {
      const start =
        prevState === undefined
          ? action.start
          : clampPosition(action.start, prevState.pieceTable.totalLength);
      const text =
        prevState === undefined ? action.text : insertedTextForState(action.text, prevState);
      const insertLength = utf8ByteLength(text);
      return [[start, addOffset(start, insertLength)]];
    }
    case "APPLY_REMOTE": {
      type Entry = { type: "insert" | "delete"; start: number; end: number };
      const entries: Entry[] = [];
      let totalLength = prevState?.pieceTable.totalLength;

      for (const change of action.changes) {
        if (change.type === "insert" && change.text) {
          const text =
            prevState === undefined ? change.text : insertedTextForState(change.text, prevState);
          const len = utf8ByteLength(text);
          if (len > 0) {
            const start =
              totalLength === undefined ? change.start : clampPosition(change.start, totalLength);
            entries.push({ type: "insert", start, end: start + len });
            if (totalLength !== undefined) totalLength += len;
          }
        } else if (
          change.type === "delete" &&
          typeof change.length === "number" &&
          change.length > 0
        ) {
          const start =
            totalLength === undefined ? change.start : clampPosition(change.start, totalLength);
          const rawEnd = addOffset(change.start, change.length);
          const end = totalLength === undefined ? rawEnd : clampPosition(rawEnd, totalLength);
          if (end > start) {
            entries.push({ type: "delete", start, end });
            if (totalLength !== undefined) totalLength -= end - start;
          }
        }
      }

      if (nextState !== undefined && nextState === prevState)
        return [[byteOffset(0), byteOffset(0)]];
      if (entries.length === 0) return [[byteOffset(0), byteOffset(0)]];

      return transformRemoteRanges(entries).map(
        ([start, end]) => [safeByteOffset(start), safeByteOffset(Math.max(start, end))] as const,
      );
    }
    default:
      return [[byteOffset(0), byteOffset(0)]];
  }
}
