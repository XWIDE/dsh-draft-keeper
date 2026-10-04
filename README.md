<div align="center">

[English](README.md) | [简体中文](README.zh.md)

</div>

# dsh-draft-keeper

## In one line

The image you just pasted into the composer is still there after you switch conversations and come back.

## Why it exists

Paste a screenshot into the composer and the harness holds it as a **runtime-only draft attachment**: an in-memory object whose bytes are uploaded only when you press send. It belongs to the *mounted composer*, not to the conversation — so switching to another conversation and back (or any other remount of the composer) leaves you with an empty box and a screenshot you have to take again.

Nothing else can put it back for you: there is no host-side copy yet, because the upload only happens at send time. This plugin keeps its own copy, in your browser, and hands it back through the official channel.

## What it does

- **Mirrors while you work.** Every image draft sitting in the composer is written to IndexedDB, keyed by session, with an in-page cache that answers before the database does. Typing does not re-read bytes: the attachment-id set is the signature.
- **Puts them back the official way.** When the composer returns empty and idle, the mirrored images are rebuilt as `File` objects — name, type and `lastModified` preserved — and handed to `conversation.createDrafts` + `input.addAttachments`. What you send afterwards is an ordinary attachment, indistinguishable from a fresh paste. If `addAttachments` refuses them, the drafts it just created are released.
- **Forgets the moment you are done.** As soon as the live attachment set goes from non-empty to empty — the message was sent, or you removed the images yourself — the stored row is dropped. A draft you were finished with never comes back.
- **Images only, on purpose.** Only `kind === "image"` drafts are mirrored: a document draft re-entering `createDrafts` would restart a host upload. Documents are left exactly as the host handles them.
- **Caps and ordering.** 12 images / 32 MB per session; captures are serialized per session through a promise chain, so a later capture can never overtake an earlier one; at most 6 restore attempts while the composer stays idle.

## How it works

| Piece | What it does |
| --- | --- |
| `conversation.input.dock` child (id `draft-keeper`, order 30) | Headless component: mounting it *is* the composer's lifetime signal. It subscribes to `input.state` and reacts to every published snapshot. |
| capture | Non-empty attachment ids → resolve the live drafts (`conversation.resolveDraftAttachments`), read each image's bytes, store `{name, type, lastModified, bytes}`. Skipped when the id set is unchanged. |
| restore | Empty ids, nothing observed before, `state.phase === "plain"` → rebuild `File`s and re-attach them. It stays quiet while the composer is adjudicating a send, and does not interfere if attachments are already present. |
| forget | Ids went from non-empty to empty → drop the row. Sent or removed, either way it must not return. |
| storage | IndexedDB `dsh-draft-keeper` (store `drafts`, key `sessionId`, row `{sessionId, records, updatedAt}`) plus an in-page `Map`. Everything is per browser profile, per session. |

The host half (`index.js`) is an empty `apply()`: it exists so the bundle is installable, and all of the behaviour lives in the client half.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/XWIDE/dsh-draft-keeper/main/install.sh | sh
```

Manual equivalent:

```sh
dsh plugin --profile web add git+https://github.com/XWIDE/dsh-draft-keeper.git
```

Then **restart the app once** so the bundle joins the host's module graph:

- **DSH desktop app**: restart DSH NEXT (its title-bar restart menu's *Reload interface* is enough for the browser half afterwards).
- **`dsh web`**: restart the `dsh` process, then refresh the page.

There is no build step and no runtime dependency, so a source install works as-is: no `allowBuilds` prompt.

## Compatibility

| dsh-draft-keeper | Harness | Notes |
| --- | --- | --- |
| 0.1.0 | **0.2.0-rc.2 (measured)** | Developed and tested against the desktop build of `0.2.0-rc.2`; `install` / `start` verified on a real profile, `uninstall` / `rollback` declared `unknown` because they have not been exercised on this release. |

Requires Node.js 22.19+ or 24+ for the host half (the same floor the harness CLI runs on). The client half declares no npm dependencies and pins no official `@deepseek-ai/*` package, so host roster versions cannot break the install.

## Configuration

None. There is nothing to configure and no UI: install it and it does its one job.

## Limits

- **Images only.** Documents and other file drafts are not mirrored, deliberately (see above).
- **Per session, per browser.** The mirror lives in the browser profile that pasted the image; a different browser or a cleared site-data store starts empty.
- **12 images / 32 MB per session.** Beyond that the oldest captures stop being added (the live composer is never touched).
- **Timing.** Restore waits for the composer to be empty and in its `plain` phase, and gives up after 6 attempts for that mount. If you start typing with attachments already present, the keeper stays out of the way.

## Privacy

Pasted image bytes are stored **locally**, in this browser's IndexedDB, for the session they were pasted into. Nothing is sent anywhere — no host route, no network request, no telemetry — and the stored row is dropped as soon as the composer's attachment set is emptied (sent, or removed by you).

## Troubleshooting

- **Nothing came back after switching conversations** — only images are kept; if the other conversation never had an image draft, there is nothing to restore. Also check that the composer was empty: the keeper deliberately does not touch a composer that already has attachments.
- **It did not restore while a turn was running** — the composer is not in its `plain` phase then. It retries while the composer stays mounted, up to 6 times.
- **An image did not come back after sending** — that is the design: once the attachment set goes to zero, the stored row is dropped so nothing resurrects after the fact.
- **The images are gone after clearing site data** — the mirror is browser storage; clearing it removes the copies (the sent messages are untouched).

## Development

```sh
node tests/harness.mjs     # 18 checks: capture, restore, forget, caps, phase handling
```

The harness runs on plain Node with no dependencies (fake composer shell, fake IndexedDB, fake React).

## Uninstall

```sh
dsh plugin --profile web remove dsh-draft-keeper
```

Optionally clear the mirror in the browser's site data (IndexedDB database `dsh-draft-keeper`); it is small and drops itself as soon as drafts are emptied.

## License

MIT — see [LICENSE](LICENSE).
