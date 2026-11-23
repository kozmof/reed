# Collaboration Status

## 1. What Exists Today

Reed provides actions for applying remote changes. It does not provide a complete collaboration system.

Implemented:

- `RemoteChange` type (`insert` / `delete`)
- `APPLY_REMOTE` action
- shared edit path updating the piece table, lazy line index, and attention layer

Remote changes intentionally do not push undo history. Applying a remote edit clears
both local undo and redo stacks because stored offsets are not rebased. Empty or
otherwise ineffective remote actions preserve history. New local edits start a
fresh history after the remote edit. Manage collaborative undo outside Reed if your application needs it.

## 2. Remote Change Shape

`insert`:

- `start`
- `text`

`delete`:

- `start`
- `length`

## 3. Local Selection

`APPLY_REMOTE` adjusts the local selection after each remote change.

- An endpoint before the change keeps its offset. An endpoint after the change shifts by the net change in byte length.
- A caret at the insertion point stays before the remote text.
- Text inserted at either edge of a range stays outside the range.
- An endpoint inside deleted text moves to the start of the deletion.

## 4. Event Semantics (Current)

With `store.createDocumentStoreWithEvents`:

- `APPLY_REMOTE` emits `content-change`, and `selection-change` when it moves the selection.
- `dirty-change` is emitted when remote edits transition dirty state.
