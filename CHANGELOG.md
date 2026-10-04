# Changelog

All notable changes to dsh-draft-keeper are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-05

First release. Measured against harness `0.2.0-rc.2` (desktop build).

### Added

- **Per-session draft mirroring.** While images sit in the composer, a headless child of the `conversation.input.dock` slot subscribes to the composer's state and mirrors the bytes of every image draft into IndexedDB, keyed by `sessionId`, with an in-page cache that answers before the database does.
- **Restore through the official channel.** When the composer comes back with nothing attached and is in its `plain` phase, the mirrored images are rebuilt as `File` objects (name, type and `lastModified` preserved) and handed to `conversation.createDrafts` + `input.addAttachments`, so the next submit sends ordinary attachments. A rejected `addAttachments` releases the drafts it just created.
- **Forget on zero.** The moment the live attachment set goes from non-empty to empty — the message was sent, or the user removed them — the stored row is dropped, so nothing reappears after the user was done with it.
- **Images only, by design.** Only `kind === "image"` drafts are mirrored; a document draft re-entering `createDrafts` would restart a host upload.
- **Caps and ordering.** 12 images and 32 MB per session; one restore attempt per composer lifetime, up to 6 tries while the composer stays idle; captures are serialized per session through a promise chain so a later capture can never overtake an earlier one, and an unchanged attachment-id set never re-reads bytes.
- Local only: no host routes, no configuration, no network — IndexedDB and an in-page `Map`.

### Notes

- The host half (`index.js`) is an empty `apply()`: it exists so the bundle is installable, all behaviour is in the client half.
- Known boundary: a draft that the harness itself discards on submit is intentionally not resurrected.
