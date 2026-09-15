# ADR 001 — Checkpoint compatibility and chunk payload growth

- Status: **accepted** for the migration policy; **proposed** for the skeleton checkpoint
- Date: 2026-09-14
- Supersedes: nothing
- Related: `src/store/features/checkpoint-migrate.ts`, `spec/11-checkpoint.md`

## Context

`CHECKPOINT_VERSION` has been `1` for the life of the format. Restore compared
the version for exact equality and raised `VERSION_UNSUPPORTED` on anything
else. That is correct but terminal: the first time the format needs to change,
every checkpoint already written by a deployed build becomes unreadable, and the
upgrade path has to be designed under release pressure.

Separately, chunked documents cannot use `normalized` capture — flattening a
partially loaded file would discard its unloaded ranges — so they always take
the `exact` path, which base64-inlines every resident chunk. Payload size
therefore tracks _everything the user has looked at_, not what they have
changed. Measured on 4 KiB chunks with no edits at all:

| Chunks resident | Bytes viewed | Checkpoint chars | Ratio |
| --------------: | -----------: | ---------------: | ----: |
|               1 |        4,096 |            6,126 |  1.50 |
|               8 |       32,768 |           44,662 |  1.36 |
|              32 |      131,072 |          176,874 |  1.35 |
|              64 |      262,144 |          353,162 |  1.35 |

Growth is linear in chunks viewed. A long read-only browse of a large file
produces a large checkpoint describing a document the user never edited.

## Decision 1 — Migration policy (accepted, implemented)

**Supported source window.** Derived from the migration registry rather than
maintained by hand: `minimumSupportedVersion()` walks backwards through the
registered steps. With the registry empty it equals `CHECKPOINT_VERSION`, and it
widens automatically as steps are appended.

**Stepwise registry.** Migrations are single-version (`v1 -> v2 -> v3`), never
direct jumps. Each step is written once, against the format immediately
preceding it, and is exercised by every later upgrade. A direct `v1 -> v3` step
would have to be rewritten each time the format moves again.

**Migrations operate on raw wire data, before validation.** The validators
encode the shape of the _current_ version, so an older payload cannot be
validated until it has been brought forward. Resource limits still apply: they
are enforced when fields are read, which happens after migration, so a migration
cannot be used to smuggle an oversized payload past the budget.

**Unknown fields are preserved.** A checkpoint written by a newer patch release
of the same version may carry fields this build does not read. Dropping them
would silently downgrade a round trip, so each step shallow-copies and rewrites
only what it owns.

**Downgrade is not supported.** A checkpoint from a future version fails with
`VERSION_UNSUPPORTED` rather than a lossy best effort. Callers that hold the
original file can branch on that code and re-load from source, which is always
better than restoring an approximation of state the build cannot represent.

**Error codes stay stable.** Migration failure reuses `VERSION_UNSUPPORTED`, the
code callers already branch on, with a message naming the supported window.

## Decision 2 — Skeleton checkpoint (proposed, not implemented)

The intent is to separate _document structure and user edits_ from _externally
reloadable chunk bytes_, so checkpoint size tracks edits rather than browsing.

Sketch:

- Chunk pieces whose bytes are unmodified serialise as a **reference**: source
  identity, chunk index, byte range, checksum, and encoding — not the bytes.
- Chunks overlapped by user edits serialise **inline**, as today. The existing
  eviction-refusal rule already identifies exactly this set: a chunk that cannot
  be evicted because edits overlap it is a chunk that cannot be represented as a
  pure reference.
- Restore re-fetches referenced chunks through the loader and verifies the
  checksum.

**This is deliberately not implemented in this change.** It requires a v2 wire
format and several product decisions that are not the deletion fix's to make:

1. **Source identity.** What names a source stably enough to survive a restart —
   a path, a content hash, an application-supplied opaque token? Reed does not
   own file I/O and must not start.
2. **Restore with an unavailable source.** Fail closed, or restore a degraded
   state that reports which ranges are missing? The latter needs a public way to
   express "this document is partially unavailable", which the API has no
   vocabulary for today.
3. **Stale or mismatched source.** A checksum mismatch must never substitute
   wrong bytes silently. Whether it is fatal or per-chunk degradable is the same
   question as (2).
4. **Loader compatibility.** A checkpoint referencing external chunks is only
   restorable by a caller that supplies a compatible loader, which makes restore
   conditional on runtime configuration for the first time.

Until those are settled, v1 remains the only format, and the migration dispatch
above exists so that answering them later is an append, not a redesign.

## Consequences

- Introducing v2 means appending one step to `CHECKPOINT_MIGRATIONS` and bumping
  `CHECKPOINT_VERSION`. Routing, ordering, idempotence, unknown-field
  preservation, and failure are already covered by
  `checkpoint-migrate.test.ts` against synthetic fixtures.
- Chunked checkpoints keep growing with resident chunks until Decision 2 ships.
  Callers that care can evict before capturing; that is a workaround, not a fix,
  and it is why the numbers above are recorded here.
- Any v2 payload change is a wire-format change and takes explicit semver
  treatment.
