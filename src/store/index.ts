/**
 * Store exports for the Reed document editor.
 */

// Store factory
export { createDocumentStore, isDocumentStore } from './store.ts';

// Action creators
export { DocumentActions, serializeAction, deserializeAction } from './actions.ts';

// State factories
export {
  createInitialState,
  createEmptyPieceTableState,
  createPieceTableState,
  createPieceNode,
  createEmptyLineIndexState,
  createLineIndexState,
  createLineIndexNode,
  createInitialSelectionState,
  createInitialHistoryState,
  createInitialMetadata,
  withState,
  withPieceNode,
  withLineIndexNode,
} from './state.ts';

// Reducer
export { documentReducer } from './reducer.ts';

// Piece table operations
export {
  pieceTableInsert,
  pieceTableDelete,
  getValue,
  getText,
  getLength,
  getLineCount,
  getLine,
  getValueStream,
  findPieceAtPosition,
  collectPieces,
} from './piece-table.ts';
export type { StreamOptions, DocumentChunk } from './piece-table.ts';

// Line index operations
export {
  lineIndexInsert,
  lineIndexDelete,
  findLineAtPosition,
  findLineByNumber,
  getLineStartOffset,
  getLineRange,
  getLineCountFromIndex,
  collectLines,
  rebuildLineIndex,
} from './line-index.ts';

// Diff and setValue operations
export {
  diff,
  computeSetValueActions,
  computeSetValueActionsOptimized,
  computeSetValueActionsFromState,
  setValue,
} from './diff.ts';
export type { DiffEdit, DiffResult, SetValueOptions } from './diff.ts';

// Event system
export {
  createEventEmitter,
  createContentChangeEvent,
  createSelectionChangeEvent,
  createHistoryChangeEvent,
  createSaveEvent,
  createDirtyChangeEvent,
  getAffectedRange,
} from './events.ts';
export type {
  DocumentEvent,
  ContentChangeEvent,
  SelectionChangeEvent,
  HistoryChangeEvent,
  SaveEvent,
  DirtyChangeEvent,
  AnyDocumentEvent,
  DocumentEventMap,
  EventHandler,
  Unsubscribe,
  DocumentEventEmitter,
} from './events.ts';

// Rendering utilities
export {
  getVisibleLineRange,
  getVisibleLines,
  getVisibleLine,
  estimateLineHeight,
  estimateTotalHeight,
  positionToLineColumn,
  lineColumnToPosition,
} from './rendering.ts';
export type {
  VisibleLine,
  ViewportConfig,
  VisibleLinesResult,
  ScrollPosition,
  LineHeightConfig,
} from './rendering.ts';

// History helpers
export {
  canUndo,
  canRedo,
  getUndoCount,
  getRedoCount,
  isHistoryEmpty,
} from './history.ts';
