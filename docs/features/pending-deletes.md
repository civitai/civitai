# Pending deletes (deletes a child-safety case keeps)

A delete of an image or post that is in an open child-safety case is not carried out at once. The
row stays and the delete is queued as a `PendingDelete` JobQueue row (except in
`removeBlockedImages`, which keeps it in its own queue; below), and the main app's
`pending-deletes` job carries it out once the case closes. Parent cleanups (an article delete, a
replaced cover) use the same queue. What counts as an open case is `childSafetyImageCase` /
`childSafetyPostCase`; this page covers the machinery around it, not the case rules. An owner's
delete of their own row also waits while a CSAM report not yet sent names them or lists the image
(for a post, an image in it): `ownerReportHold`.

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
2. leaves each locked row in an open case, or the actor's own row under `ownerReportHold`, and
   queues it as a `PendingDelete`;
3. blocks each image it keeps, whoever deletes it (an owner, a moderator, any system
   caller, or the job replaying a delete), as `writeModeratorBlock` does (`ingestion = 'Blocked'`, `nsfwLevel`
   Blocked, `blockedFor = 'moderated'` unless it is `CSAM`, every review flag but `csam` cleared, and `appeal` kept while an appeal is pending), and
   drops its account-deletion grace markers, so it leaves feeds, search and the review queues while
   its case keeps it, and neither a queue's accept nor an account restore can lift it. Only a
   moderator's delete that queues what it keeps rewrites an image already blocked; any other leaves it
   as it is, so a takedown keeps its reason and an account-deletion grace block stays liftable by a
   restore. Blocking queues the image for `remove-blocked-images` (`trg_blocked_image_delete_queue`); unless a
   moderator's delete did the blocking, a second statement drops that queue row, so the queued delete,
   not the purge's retention clock, decides when it goes;
4. deletes the rest and, for images, queues what the caller asks for: their stored files (unless
   `files` is absent), post recounts (`recountPosts`) and CDN takedowns (`cdnTakedown`);
5. returns `{ deleted, kept, hidden, gone }`: the deleted rows, the kept ids, the kept images it
   blocked (with their owner and post), and the listed ids that were already gone.

Each app takes a blocked image out of search and busts its caches, as for one a hold marker's
trigger blocked, and drops it from the comics and home blocks showing it. A kept post is unpublished as a moderator's unpublish does (`publishedAt` cleared, the
`unpublishedAt`/`unpublishedBy`/`prevPublishedAt` stamps written, `unpublishedReason = 'pending-delete'`),
so it leaves public reads and stays visible to its owner and moderators; `deletePost` then runs the
unpublish follow-ups. The `trg_post_pending_delete_keep_unpublished` trigger (migration
`20271126120000_post_pending_delete_publish_guard`) keeps such a post unpublished, its stamp intact,
whatever path tries to publish it, while its `PendingDelete` row exists. A kept draft is stamped too; a
post a moderator already unpublished keeps its own reason. Once that row is gone without
the post, a publish goes through and drops the stamp. An account restore
(`releaseAccountDeletionPendingDeletes`) leaves the drain's delete of an image or post whose case is
still open, marked `releasedOnRestore`, so it cannot make that content publishable: the content stays
hidden until the case closes. Then `pending-deletes` releases it (drops the row and keeps the content, still hidden as the delete left it)
only if the case found nothing; on a finding (blocked for CSAM, listed on a CSAM report, or an actioned
child-safety report on the image, its post or its review) it carries out the delete as queued.
`deletePost` runs the unpublish follow-ups (`afterPostsUnpublish`) for a post it kept; the other
`deletePostRows` callers do not yet. A publish the trigger refuses makes `updatePost` answer that the
post can't be published right now.
`deletePost` deletes a post's images first, so those a case keeps are blocked. An owner's image blocked this way is no longer a plain owner delete when the
queued delete runs, so it does not keep an object shop artwork uses.

Lifting a block (a moderator's unblock, an approved appeal, an account restore's lift of a grace
block) releases any moderator's pending delete on that image: both apps'
`dropBlockedImageDeleteQueue` also call `releaseModeratorPendingDeletes`, which drops a queued delete
only a moderator asked for, strips the moderator's ask from one the owner also asked for, and leaves a
moderator's cleanup to go only while the image is unused. A plain cleanup the moderator's delete
outranked in the merge is already gone, so the lift drops it too. A review queue's Accept posts the flag its card showed and is refused (`ImageChangedError`) when it has changed, so a page loaded before a moderator's delete cannot lift the image.

A row the caller's condition or the actor's ownership excludes is in none of the lists, and is
neither deleted nor queued: the condition is checked once, here, and never replayed later.

Some callers do not queue what they keep (`queueKept: false`), because a queued delete is carried
out without their condition or outside their own run:

- both deletes in `image-ingestion.ts`'s `removeBlockedImages`: a kept row's `BlockedImageDelete`
  row stays for a later run, and only that job's run may send a takedown's retraction;
- `remove-replaced-images`: a kept image stays in its `ReplacedImageDelete` queue, so the
  re-adoption check runs again before it goes;
- `job-queue-clean-if-empty`: a kept empty post stays, since a queued delete would take it even
  after its owner filled it again.

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

- **A member** gets the same reply to their own image or post delete whether it went or was kept
  (`DELETE_PROCESSING_MESSAGE`), so the reply never says that a hold applies. Only the image
  page's banner (`imagesPendingDeletion`) shows `DELETE_AFTER_REVIEW_MESSAGE`, to the owner, for
  a kept delete of theirs on a case they can already see (`childSafetyVisibleCase`).
- **A moderator** deleting through the main app's image or post delete (`deleteImageHandler`,
  `deletePost`) is told when the delete was kept; bulk and account-wide deletes (`removeAllContent`,
  the mod and admin delete endpoints) do not report it. The moderator app returns such an image as
  refused `review`.

## Holds

The account and review holds (`legal-hold.service.ts`, the moderator app's `heldImages`) still run
alongside this. Today they are often the caller's condition, so an in-case image they cover is left
by the condition and never queued; and the moderator app refuses held images (except a marked
owner's, which go to the delete) before its delete runs. Once the holds are removed, every in-case
image reaches the case check and is queued, except in the `queueKept: false` callers above.
