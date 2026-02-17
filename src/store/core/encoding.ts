/**
 * Shared TextEncoder/TextDecoder singletons for the Reed document editor.
 * Centralizes encoding instances to avoid redundant per-module instantiation.
 */

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();
