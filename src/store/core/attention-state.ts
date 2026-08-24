/** Dependency-light construction for the empty attention layer. */

import type { Attention, AttentionLayerState } from "../../types/attention.js";
import type { AttentionID } from "../../types/branded.js";
import { asReadonlyMap } from "./runtime-readonly.js";

/** Shared immutable empty attention state used by new documents and the public API. */
export const emptyAttentionLayerState: AttentionLayerState = Object.freeze({
  attentions: asReadonlyMap(new Map<AttentionID, Attention>()),
  nextID: 0,
});
