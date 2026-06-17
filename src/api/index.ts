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
 * - `cost.*`      — cost algebra for annotating algorithmic complexity
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
export { cost } from "./cost-doc.js";
