/**
 * Public API namespaces grouped by task and operation cost.
 *
 * - `store.*`     — store lifecycle, actions, type guards, and unsafe low-level helpers
 * - `query.*`     — O(1) and tree-height-bounded read operations
 * - `scan.*`      — O(n) operations (full document traversals)
 * - `events.*`    — event emitter and document event factories
 * - `rendering.*` — viewport calculations and position/line-column conversion
 * - `history.*`   — undo/redo state queries
 * - `diff.*`      — diff algorithm and setValue operations
 * - `position.*`  — branded position constructors, arithmetic, and constants
 * - `attention.*` — piece-anchored boundary references (the third Reed layer)
 * - `checkpoint.*` — capture state as JSON-safe data and load it back
 *
 * Each namespace member documents its cost with `@complexity` JSDoc tags.
 * The cost algebra is internal to `store/core`.
 */

export type {
  QueryApi,
  QueryLineIndexApi,
  LineCountInfo,
  ScanApi,
  RenderingApi,
  HistoryApi,
  AttentionApi,
  CheckpointApi,
} from "./interfaces.js";
export { store } from "./store.js";
export { query } from "./query.js";
export { scan } from "./scan.js";
export { events } from "./events.js";
export { rendering } from "./rendering.js";
export { history } from "./history.js";
export { diff } from "./diff.js";
export { position } from "./position.js";
export { attention } from "./attention.js";
export { checkpoint } from "./checkpoint.js";
