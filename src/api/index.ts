/**
 * Complexity-stratified and domain-categorized API namespaces.
 *
 * - `store.*`     — store lifecycle, actions, type guards, and unsafe low-level helpers
 * - `query.*`     — O(1) and O(log n) read operations (tree-based lookups)
 * - `scan.*`      — O(n) operations (full document traversals)
 * - `events.*`    — event emitter and document event factories
 * - `rendering.*` — viewport calculations and position/line-column conversion
 * - `history.*`   — undo/redo state queries
 * - `diff.*`      — diff algorithm and setValue operations
 * - `position.*`  — branded position constructors, arithmetic, and constants
 * - `attention.*` — piece-anchored boundary references (the third Reed layer)
 *
 * Algorithmic complexity is documented on each namespace member with
 * `@complexity` JSDoc tags; the cost algebra itself is internal to `store/core`.
 */

export type { QueryApi, QueryLineIndexApi, ScanApi, HistoryApi } from "./interfaces.js";
export { store } from "./store.js";
export { query } from "./query.js";
export { scan } from "./scan.js";
export { events } from "./events.js";
export { rendering } from "./rendering.js";
export { history } from "./history.js";
export { diff } from "./diff.js";
export { position } from "./position.js";
export { attention } from "./attention.js";
