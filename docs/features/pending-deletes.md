# Pending deletes (deletes a child-safety case keeps)

A delete of an image or post that is in an open child-safety case is not carried out at once. The
row stays and the delete is queued as a `PendingDelete` JobQueue row (except in
`removeBlockedImages`, which keeps it in its own queue; below), and the main app's
`pending-deletes` job carries it out once the case closes. Parent cleanups (an article delete, a
replaced cover) use the same queue. What counts as an open case is `childSafetyImageCase` /
`childSafetyPostCase`; this page covers the machinery around it, not the case rules.

## Where it lives

| Piece | File |
|---|---|
| The delete statement: locks, keeps, queues, deletes, reports | `packages/civitai-db-queries/src/content-deletion.db.ts` (`deleteImageRows`, `deletePostRows`) |
| The queue: row data, kind, merge, blocked rules, due and settle, owner notice read | `packages/civitai-db-queries/src/pending-deletes.db.ts` |
| What counts as an open case | `packages/civitai-db-queries/src/child-safety-case.db.ts` |
| Each app's image delete (caches, search, posts) | `src/server/services/image.service.ts` (`deleteImages`), `apps/moderator/src/lib/server/image-deletion.ts` |
| The job | `src/server/jobs/pending-deletes.ts` (every 5 minutes) |

## The delete statement

`deleteImageRows` / `deletePostRows` are the only DELETEs on `Image` and `Post` (guard:
`no-direct-image-post-delete`). Every call, whoever the actor and whatever condition the caller
passes, runs one statement that:

1. locks the listed rows the actor may delete and the caller's condition allows;
2. leaves each locked row in an open case and queues it as a `PendingDelete`;
3. deletes the rest and, for images, queues what the caller asks for: their stored files (unless
   `files` is absent), post recounts (`recountPosts`) and CDN takedowns (`cdnTakedown`);
4. returns `{ deleted, kept, gone }`: the deleted rows, the kept ids (with `ownerTold`, below), and the
   listed ids that were already gone.

A row the caller's condition or the actor's ownership excludes is in none of the three, and is
neither deleted nor queued: the condition is checked once, here, and never replayed later.

Two callers do not queue what they keep (`queueKept: false`), because they retry from a queue of
their own: both deletes in `image-ingestion.ts`'s `removeBlockedImages`. A kept row's
`BlockedImageDelete` row stays for a later run, and only that job's run may send a takedown's
retraction.

## The queued row

One row per entity (`JobQueue` type `PendingDelete`, unique on entity). Its `data` says how to carry
the delete out later:

| Kind | Data | Written by | Carried out as |
|---|---|---|---|
| `own` | `{ ownerId }` | the owner deleting their own row | the owner |
| `other` | `{ deletedBy, moderatorDelete?, keepStoredFiles? }` | anyone else: a moderator (`deletedBy: 'moderator:<id>'`) or a system caller (its name) | the system, with those flags; a moderator's post delete as a moderator's |
| `cleanup` | `{ cleanup: true, moderatorDelete? }` | `queueImageDeletes` (a parent letting go of an image) | the system, only while the image is still unused |

The kind is not stored: `pendingKindOf` (TypeScript) and `pendingKind` (SQL) read it from the data,
and every rule starts from that reading; the merge rank, the waiting interval and the cleanup replay
also read `moderatorDelete`, `ownerId` and `deletedBy` directly.

When a second delete lands on a queued row, the stronger kind's data wins (a moderator's delete or
cleanup, then an outright `own`/`other`, then an owner's cleanup) and the row takes the earlier of the
two due times, so a merge makes a waiting row due now. An outright ask (`ownerId`, `deletedBy`)
survives the merge, so a cleanup that carries one goes even if the image is in use again. A second
delete that is no stronger and adds no outright ask changes nothing.

## The job

Every run, per entity type, `pending-deletes`:

1. reads due rows (`readDueDeletes`): first attempts before retries, earliest due first;
2. reads whether each is still present and still blocked (`imageDeleteBlocked`, `postDeleteBlocked`,
   and for posts a hold on its text);
3. carries out the unblocked ones through `replay(kind, data)`, batching rows that replay alike;
4. settles each (`settleDeletes`): **done** (deleted, gone, or left by the replay because it no longer
   applies: in use again, given away, kept by a hold marker), **waiting** (blocked again; due again at
   the next run, or in an hour for a plain cleanup), or **failed** (retried on its own next run).

What blocks a row: its case, for every kind; for someone else's post delete, also any of its images
that still has a pending delete of its own (those go first); for a cleanup, also a held owner and,
for an owner's cleanup, open moderation; and, for any post, a hold on its text
(`heldPostTextPostIds`).

Cleanups and other people's deletes run as `PENDING_DELETES_ACTOR`; an owner's runs as the owner.
When it deletes as `PENDING_DELETES_ACTOR`, a row already in the queue is left as it is
(`ON CONFLICT DO NOTHING`, so the job never turns an owner's row into its own), while an image it
reaches through a post it carries out, and finds in a case of its own, is queued anew.

## Who is told

- **The owner** sees the one generic message (`DELETE_AFTER_REVIEW_MESSAGE`) only for their own
  delete of an image whose case they can already see (`ownerTold`, from `childSafetyVisibleCase`).
  Every other kept delete by a member answers as if it went. `imagesPendingDeletion` is the same
  rule, read later (the image page's banner).
- **A moderator** deleting through the main app's image or post delete (`deleteImageHandler`,
  `deletePost`) is told when the delete was kept; bulk and account-wide deletes (`removeAllContent`,
  the mod and admin delete endpoints) do not report it. The moderator app returns such an image as
  refused `review` and leaves it in search.

## Holds

The account and review holds (`legal-hold.service.ts`, the moderator app's `heldImages`) still run
alongside this. Today they are often the caller's condition, so an in-case image they cover is left
by the condition and never queued; and the moderator app refuses held images (except a marked
owner's, which go to the delete) before its delete runs. Once the holds are removed, every in-case
image reaches the case check and is queued, except in `removeBlockedImages` (`queueKept: false`).
