/**
 * Event system for the Reed document editor.
 * Provides a pub/sub mechanism for document changes and editor events.
 */

import type { DocumentState } from "../../types/state.js";
import type { ContentChangeAction, DocumentAction } from "../../types/actions.js";
import { byteOffset, type ByteOffset } from "../../types/branded.js";
import { utf8ByteLength } from "../core/encoding.js";

// =============================================================================
// Event Types
// =============================================================================

/**
 * Base event interface.
 */
export interface DocumentEvent {
  readonly type: keyof DocumentEventMap;
  readonly timestamp: number;
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
 * Fired when selection changes.
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
  | SaveEvent
  | DirtyChangeEvent;

/**
 * Event type to handler mapping.
 */
export interface DocumentEventMap {
  "content-change": ContentChangeEvent;
  "selection-change": SelectionChangeEvent;
  "history-change": HistoryChangeEvent;
  save: SaveEvent;
  "dirty-change": DirtyChangeEvent;
}

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
 * Create a new document event emitter.
 */
export function createEventEmitter(): DocumentEventEmitter {
  const handlers = new Map<string, Set<EventHandler<AnyDocumentEvent>>>();

  return {
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

      return () => {
        typeHandlers!.delete(handler as EventHandler<AnyDocumentEvent>);
        if (typeHandlers!.size === 0) {
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
      const typeHandlers = handlers.get(type);
      if (typeHandlers) {
        // Snapshot handlers to guarantee stable delivery under subscribe/unsubscribe churn.
        const handlersSnapshot = Array.from(typeHandlers);
        for (const handler of handlersSnapshot) {
          try {
            handler(event);
          } catch (error) {
            console.error(`Event handler error for '${type}':`, error);
          }
        }
      }
    },

    removeAllListeners(): void {
      handlers.clear();
    },
  };
}

// =============================================================================
// Event Helpers
// =============================================================================

/**
 * Create a content change event.
 */
export function createContentChangeEvent(
  action: ContentChangeAction,
  prevState: DocumentState,
  nextState: DocumentState,
  affectedRanges: readonly (readonly [ByteOffset, ByteOffset])[],
): ContentChangeEvent {
  return Object.freeze({
    type: "content-change" as const,
    timestamp: Date.now(),
    action,
    prevState,
    nextState,
    affectedRanges,
  });
}

/**
 * Create a selection change event.
 */
export function createSelectionChangeEvent(
  prevState: DocumentState,
  nextState: DocumentState,
): SelectionChangeEvent {
  return Object.freeze({
    type: "selection-change" as const,
    timestamp: Date.now(),
    prevState,
    nextState,
  });
}

/**
 * Create a history change event.
 */
export function createHistoryChangeEvent(
  direction: "undo" | "redo",
  prevState: DocumentState,
  nextState: DocumentState,
): HistoryChangeEvent {
  return Object.freeze({
    type: "history-change" as const,
    timestamp: Date.now(),
    direction,
    prevState,
    nextState,
  });
}

/**
 * Create a save event.
 */
export function createSaveEvent(state: DocumentState): SaveEvent {
  return Object.freeze({
    type: "save" as const,
    timestamp: Date.now(),
    state,
  });
}

/**
 * Create a dirty change event.
 */
export function createDirtyChangeEvent(isDirty: boolean, state: DocumentState): DirtyChangeEvent {
  return Object.freeze({
    type: "dirty-change" as const,
    timestamp: Date.now(),
    isDirty,
    state,
  });
}

function clampPosition(position: number, totalLength: number): ByteOffset {
  if (!Number.isFinite(position)) return byteOffset(0);
  return byteOffset(Math.max(0, Math.min(position, totalLength)));
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
      return [[start, byteOffset(start + utf8ByteLength(text))]];
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
      return [[start, byteOffset(start + insertLength)]];
    }
    case "APPLY_REMOTE": {
      type Entry = { start: number; size: number; byteChange: number };
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
            entries.push({ start, size: len, byteChange: len });
            if (totalLength !== undefined) totalLength += len;
          }
        } else if (
          change.type === "delete" &&
          typeof change.length === "number" &&
          change.length > 0
        ) {
          const start =
            totalLength === undefined ? change.start : clampPosition(change.start, totalLength);
          const rawEnd = byteOffset(change.start + change.length);
          const end = totalLength === undefined ? rawEnd : clampPosition(rawEnd, totalLength);
          const size = end - start;
          if (size > 0) {
            entries.push({ start, size, byteChange: -size });
            if (totalLength !== undefined) totalLength -= size;
          }
        }
      }

      if (nextState !== undefined && nextState === prevState)
        return [[byteOffset(0), byteOffset(0)]];
      if (entries.length === 0) return [[byteOffset(0), byteOffset(0)]];

      // Adjust each entry's start to nextState coordinate space.
      // Each entry.start is in intermediate space (after applying all previous entries).
      // A subsequent entry j that sits at or before entry i's start shifts entry i by entry j's byteChange.
      const ranges: [ByteOffset, ByteOffset][] = [];
      for (let i = 0; i < entries.length; i++) {
        let delta = 0;
        for (let j = i + 1; j < entries.length; j++) {
          if (entries[j].start <= entries[i].start) delta += entries[j].byteChange;
        }
        const s = entries[i].start + delta;
        ranges.push([byteOffset(s), byteOffset(s + entries[i].size)]);
      }
      return ranges;
    }
    default:
      return [[byteOffset(0), byteOffset(0)]];
  }
}
