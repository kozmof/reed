# ADR 001 — Checkpoint compatibility and chunk payload growth

- Migration policy status: accepted
- Skeleton checkpoint status: proposed
- Date: 2026-09-14
- Supersedes: nothing
- Related: `src/store/features/checkpoint-migrate.ts`, `spec/11-checkpoint.md`

## Context

`CHECKPOINT_VERSION` has been `1` for the life of the format. Restore compared
the version for exact equality and raised `VERSION_UNSUPPORTED` on anything
else. Without a migration path, a format change would make existing checkpoints
unreadable. The registry defines that path before the first version change.

Chunked documents use `exact` capture because normalized capture would discard
unloaded ranges. Exact capture includes every resident chunk as base64, so
payload size grows with resident content even when the user makes no edits.
The following measurements use unedited 4 KiB chunks.

| Chunks resident | Bytes viewed | Checkpoint chars | Ratio |
| --------------: | -----------: | ---------------: | ----: |
|               1 |        4,096 |            6,126 |  1.50 |
|               8 |       32,768 |           44,662 |  1.36 |
|              32 |      131,072 |          176,874 |  1.35 |
|              64 |      262,144 |          353,162 |  1.35 |

Payload size grows with resident chunks. Browsing a file can increase checkpoint size even without edits if those chunks remain loaded.

## Decision 1 — Migration policy (accepted, implemented)

`minimumSupportedVersion()` derives the supported source window by walking
backward through the registered migration steps. An empty registry supports only `CHECKPOINT_VERSION`. Adding steps extends the supported range.

Migrations advance one version at a time (`v1 -> v2 -> v3`), never
direct jumps. Each step is written once, against the format immediately
preceding it, and is exercised by every later upgrade. A direct `v1 -> v3` step
would have to be rewritten each time the format moves again.

Migrations operate on raw wire data, before validation. The validators
describe the current format, so an older payload must be migrated first.
Field-level resource limits apply when validation reads the migrated payload.

Unknown fields are preserved. A checkpoint written by a newer patch release
of the same version may carry fields this build does not read. Dropping them
would silently downgrade a round trip, so each step shallow-copies and rewrites
only what it owns.

Downgrade is not supported. A checkpoint from a future version fails with
`VERSION_UNSUPPORTED` rather than a lossy best effort. Callers that hold the
original file can branch on that code and re-load from source, which is always
better than restoring an approximation of state the build cannot represent.

Error codes stay stable. Migration failure reuses `VERSION_UNSUPPORTED`, the
code callers already branch on, with a message naming the supported window.

## Decision 2 — Skeleton checkpoint (proposed, not implemented)

The proposed format would store document structure and user edits while letting
the loader fetch unmodified chunk bytes. Checkpoint size would then depend on edits.

Sketch:

- Unmodified chunk pieces store a reference containing the source identity,
  chunk index, byte range, checksum, and encoding.
- Chunks overlapped by user edits serialise inline, as today. The existing
  eviction-refusal rule identifies chunks whose ranges overlap edits. These
  chunks need inline bytes to preserve their edited content.
- Restore re-fetches referenced chunks through the loader and verifies the
  checksum.

Implementing this proposal requires a v2 wire format and decisions about the
following requirements.

1. Source identity. Choose a stable source identifier, such as a path, content
   hash, or application-supplied token. File I/O remains the caller's responsibility.
2. Restore with an unavailable source. Fail closed, or restore a degraded
   state that reports which ranges are missing? The latter needs a public way to
   express "this document is partially unavailable", which the API has no
   vocabulary for today.
3. Stale or mismatched source. A checksum mismatch must never substitute
   wrong bytes silently. Whether it is fatal or per-chunk degradable is the same
   question as (2).
4. Loader compatibility. A checkpoint referencing external chunks is only
   restorable by a caller that supplies a compatible loader, which makes restore
   conditional on runtime configuration for the first time.

Until those are settled, v1 remains the only format, and the migration dispatch
above exists to support a future format through an additional migration step.

## Consequences

- Introducing v2 means appending one step to `CHECKPOINT_MIGRATIONS` and bumping
  `CHECKPOINT_VERSION`. Routing, ordering, idempotence, unknown-field
  preservation, and failure are already covered by
  `checkpoint-migrate.test.ts` against synthetic fixtures.
- Chunked checkpoints keep growing with resident chunks until Decision 2 ships.
  Evict eligible chunks before capture to reduce the payload with the current format.
- Any v2 payload change is a wire-format change and takes explicit semver
  treatment.
