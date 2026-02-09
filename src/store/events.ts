/**
 * Event system for the Reed document editor.
 * Provides a pub/sub mechanism for document changes and editor events.
 */

import type { DocumentState } from '../types/state.ts';
import type { DocumentAction } from '../types/actions.ts';
import { textEncoder } from './encoding.ts';

// =============================================================================
// Event Types
// =============================================================================

/**
 * Base event interface.
 */
export interface DocumentEvent {
  readonly type: string;
  readonly timestamp: number;
}

/**
 * Fired when document content changes.
 */
export interface ContentChangeEvent extends DocumentEvent {
  readonly type: 'content-change';
  /** The action that caused the change */
  readonly action: DocumentAction;
  /** Document state before the change */
  readonly prevState: DocumentState;
  /** Document state after the change */
  readonly nextState: DocumentState;
  /** Byte range affected [start, end) */
  readonly affectedRange: readonly [number, number];
}

/**
 * Fired when selection changes.
 */
export interface SelectionChangeEvent extends DocumentEvent {
  readonly type: 'selection-change';
  readonly prevState: DocumentState;
  readonly nextState: DocumentState;
}

/**
 * Fired when undo/redo occurs.
 */
export interface HistoryChangeEvent extends DocumentEvent {
  readonly type: 'history-change';
  readonly direction: 'undo' | 'redo';
  readonly prevState: DocumentState;
  readonly nextState: DocumentState;
}

/**
 * Fired when document is saved.
 */
export interface SaveEvent extends DocumentEvent {
  readonly type: 'save';
  readonly state: DocumentState;
}

/**
 * Fired when document dirty state changes.
 */
export interface DirtyChangeEvent extends DocumentEvent {
  readonly type: 'dirty-change';
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
  'content-change': ContentChangeEvent;
  'selection-change': SelectionChangeEvent;
  'history-change': HistoryChangeEvent;
  'save': SaveEvent;
  'dirty-change': DirtyChangeEvent;
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
    handler: EventHandler<DocumentEventMap[K]>
  ): Unsubscribe;

  /**
   * Remove an event listener.
   */
  removeEventListener<K extends keyof DocumentEventMap>(
    type: K,
    handler: EventHandler<DocumentEventMap[K]>
  ): void;

  /**
   * Emit an event to all registered handlers.
   */
  emit<K extends keyof DocumentEventMap>(
    type: K,
    event: DocumentEventMap[K]
  ): void;

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
      handler: EventHandler<DocumentEventMap[K]>
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
      handler: EventHandler<DocumentEventMap[K]>
    ): void {
      const typeHandlers = handlers.get(type);
      if (typeHandlers) {
        typeHandlers.delete(handler as EventHandler<AnyDocumentEvent>);
        if (typeHandlers.size === 0) {
          handlers.delete(type);
        }
      }
    },

    emit<K extends keyof DocumentEventMap>(
      type: K,
      event: DocumentEventMap[K]
    ): void {
      const typeHandlers = handlers.get(type);
      if (typeHandlers) {
        for (const handler of typeHandlers) {
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
  action: DocumentAction,
  prevState: DocumentState,
  nextState: DocumentState,
  affectedRange: readonly [number, number]
): ContentChangeEvent {
  return Object.freeze({
    type: 'content-change' as const,
    timestamp: Date.now(),
    action,
    prevState,
    nextState,
    affectedRange,
  });
}

/**
 * Create a selection change event.
 */
export function createSelectionChangeEvent(
  prevState: DocumentState,
  nextState: DocumentState
): SelectionChangeEvent {
  return Object.freeze({
    type: 'selection-change' as const,
    timestamp: Date.now(),
    prevState,
    nextState,
  });
}

/**
 * Create a history change event.
 */
export function createHistoryChangeEvent(
  direction: 'undo' | 'redo',
  prevState: DocumentState,
  nextState: DocumentState
): HistoryChangeEvent {
  return Object.freeze({
    type: 'history-change' as const,
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
    type: 'save' as const,
    timestamp: Date.now(),
    state,
  });
}

/**
 * Create a dirty change event.
 */
export function createDirtyChangeEvent(
  isDirty: boolean,
  state: DocumentState
): DirtyChangeEvent {
  return Object.freeze({
    type: 'dirty-change' as const,
    timestamp: Date.now(),
    isDirty,
    state,
  });
}

/**
 * Determine the affected byte range for a document action.
 */
export function getAffectedRange(action: DocumentAction): readonly [number, number] {
  switch (action.type) {
    case 'INSERT':
      return [action.start, action.start + textEncoder.encode(action.text).length];
    case 'DELETE':
      return [action.start, action.end];
    case 'REPLACE': {
      const insertLength = textEncoder.encode(action.text).length;
      return [action.start, action.start + insertLength];
    }
    default:
      return [0, 0];
  }
}
