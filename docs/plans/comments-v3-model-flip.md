# CommentV3 model flip: model discussion reads and writes CommentV3

The last surface. Model comments move onto the `commentv3` endpoints in one release, reads and writes
together: the model page's cards and thread dialog read `commentv3`, every write goes through it, and
the v1 `comment` router is deleted. A read-only adapter (v1-shaped payloads from CommentV3 through the
`comment` router) was built first and dropped unshipped.

> **Superseded in part by `comments-v3-phase5.md`.** Phase 5 removes the old-row sync
> (`syncOldRows`), the surface switches (`v3ReadSurfaces`/`v3WriteSurfaces`), the reverse copy and
> the parity job, so there is no rollback to the old tables; drops the mirror triggers; deletes the
> CommentV2 event-engine handler, the `Comment`/`CommentV2` text-scan types and queue entries; and
> renames the mod endpoints' `commentV2Ids` to `commentIds`. The sections below describe the flip as
> built.

## Decisions (Briant, 2026-11-06)

1. **Hidden comments stay out of the list** (Briant revised "inline" after a dev check, 2026-11-06: a
   model's discussion can be a wall of hidden spam). The model section leaves hidden top-level comments out
   (`constants.comments.leavesOutHiddenComments`), its first page carries the visible and hidden
   counts, and "See N more hidden comments" opens them in a dialog (`HiddenCommentsModal`, the
   section with `hidden: true`), as the v1 page did. The `commentCountsSingleCall` flag is gone.
2. **The Most Comments sort is gone.** Nothing called `comment.getAll` with anything but `Newest`.
3. **The layout stays**: the masonry of cards and the thread dialog, fed by `commentv3` data.
4. **Reaction counts only.** The card shows counts and the viewer's own reactions, as every v3
   surface does; the who-reacted names (`ReactionPicker`) are gone.
5. **API-token callers of the `comment` router break**, as `commentv2`'s did. A stale browser tab
   gets the refresh prompt (#8065).
6. **The comments on old v2 model threads show.** 20 live comments on 18 models (no v1 id) that
   the v1 page never listed now appear with the rest.

## Server

- **Surface entry** (`commentv3/surfaces.ts`):
  - `assertVisible`: a published model, or its owner's; moderators see every model; a `poi` model
    only to its owner and moderators (`canViewPoiModel`), as the model page. It does not refuse a
    locked model, as the v1 endpoints did not; the page still shows "Discussion is turned off" for
    a locked model or one with comments locked.
  - `assertOpen`, a hook apart from `assertWritable` and run on create and edit only (the owner's
    hide and pin skip it, as under v1): refuses a member on a locked model or one with
    `meta.commentsLocked` (which v1 left to the page hiding the discussion), and any write on a
    model with no published version. With exactly one, the writer needs access to it (early
    access).
  - `trackAs`: the ClickHouse comment event is `{ type: 'Model', entityId: modelId }` for every
    comment, replies too, and the only one: the model metrics job finds the models to recount by it.
- **`v3ReadSurfaces` and `v3WriteSurfaces` gain `model`.** `model3dReview` is the only comment
  entity type left off them, and nothing writes its comments. No new CommentV2 row is written except by the
  rollback reverse copy; existing rows are still updated and deleted in step.
- **Old-row sync.** A pre-flip model comment's twin is its v1 `Comment` row (`legacyV1Id`), kept in
  step on edits, flags and locks. A v3 tombstone only blanks its v1 row: deleting it would cascade
  to the v1 replies, and through the mirror to their live CommentV3 rows. The reverse copy already
  handles model.
- **Comment lock.** `commentv3.toggleLock` (moderators) flips `CommentV3.locked`, with the v1 row's
  `locked` or the v2 reply Thread's in step. The v3 items carry `locked`, and the menu offers it on
  model comments only, as the v1 "Lock comment" was.
- **Old links.** 1.24M model comments have a v3 id different from their v1 id. `getThread` on a
  model resolves the id as one of that model's `legacyV1Id`s, and otherwise takes it as the
  comment's own (`resolveModelPageCommentId`). No model comment's v3 id equals another model
  comment's v1 id (measured 2026-11-06), and new ids are above every old one.
- **Notifications.** The model-page processors address a comment by `modelPageId`
  (`COALESCE(legacyV1Id, id)`), so milestone keys keep matching and links sent before the flip
  open the right thread; `getThread` resolves a link's `highlight` the same way.
  They cover every model comment, filter `notCommentMuted`, and stamp `version: 4`. The detail
  fetcher resolves an id by `legacyV1Id`, and, on a version-4 row only, by a model comment's own id.
  Replies, thread responses and mentions also filter `notOnHiddenModel`, the twin of the
  section's visibility check: on an unpublished or POI model a reply notifies only when it answers
  the owner, and thread responses and mentions go to no one; the owner still gets new-comment and
  new-comment-nested.
- **Event engine.** `commentV3Handler` counts model comments (`ModelMetric.commentCount` and the
  owner's `UserMetric.commentCount`); the `Comment`-table handler is deleted, and the CommentV2
  handler skips model threads. Deploy the event engine before or with the main app: until it runs,
  a v3-only model comment is not counted live. The model metrics job later corrects
  `ModelMetric.commentCount`, but the owner's `UserMetric.commentCount` misses it for good.
- **Page size.** A section page on the model holds 8 root comments, pinned ones included
  (`v3PageBudgetOverrides`; the model surface opens no replies). The v1 page loaded 8 unpinned
  comments plus every pinned one on desktop, and 4 on mobile; v3 uses 8 on both. The default would
  have been 40.
- **What else follows from model joining the write surfaces**, as on every other surface:
  - Blocking someone hides their comments on the blocker's models (`block-hide-comments`), the
    v1 row in step. The v1 page never hid them.
  - A thread or section mute now silences the three model-page notifications, which no mute
    reached before.
  - Removing a user's content (`removeAllContent`, `user.service.ts`) skips every v1 `Comment` row
    that has a CommentV3 twin (`legacyV1Id`): deleting it would cascade to the v1 replies and,
    through the mirror, to their live CommentV3 rows. The CommentV3 pass blanks or deletes the
    twin; only v1 rows with no twin are deleted.
  - The parity job counts the old-side presence checks (`v2_ghosts`, `thread_count_mismatch`, the
    `*_extra` links) as rows written on CommentV3 (`V3_NATIVE`): recorded, not paged. `v1_ghosts`
    still pages, since a new model comment has no `legacyV1Id`.
- **A hazard for later edits:** the v1 mirror's UPDATE trigger copies every mirrored column from
  the v1 row into CommentV3. Every CommentV3 write to those columns keeps the v1 row in step, so
  that copy is a no-op; a new write that skips the v1 sync would be reverted by the next v1 write.
- **Moderation by CommentV3 id.** Every model comment is moderated by its CommentV3 id, on the path
  the other surfaces use:
  - The mod endpoints `comment/bulk-delete`, `remove-as-tos` and `restore-from-tos` took only
    `commentV2Ids` (CommentV3 ids) after this flip; the v1 `commentIds` list was dropped. Phase 5
    renamed the field to `commentIds` (CommentV3 ids) and the bulk delete to `bulkDeleteComments`.
  - The moderator app lists a user's model comments by CommentV3 id (`entityType = 'model'`, not
    `legacyV1Id`) and links them through `/comments/<id>`, whose model URL now carries `commentId`
    for the thread dialog.
  - Ids that predate the flip are resolved through `legacyV1Id` (`commentV3IdsByOldId`, removed in
    Phase 5, whose hand-run SQL rewrites the stored records to CommentV3 ids instead): a CSAM hold
    on a `Comment` (the decision, and the moderator app's list, context and link), a scam review's
    `Comment` subject, and a scam-cleanup record of kind `comments`, which the overturn restores on
    CommentV3; no new record of that kind is written. A Clavata or text-scan verdict on a `Comment` row runs the `commentsV2` cleanup.
  - A report can no longer be filed on `ReportEntity.Comment`; old `CommentReport` links reach
    CommentV3 through `CommentV3Report`, which the mirror fills.
- **Deleted:** the `comment` router and controller, `comment.service.ts`, `hot-reads-4` (service and
  package statements), `getDbWithoutLag('commentModel')`, the comment selectors,
  `maskHiddenReactors`, the `commentOld` reaction type, `getBlockCheckOwnerIdsForModelComment`, the
  v1 `clearTos` table, the ban's v1 `updateMany` (`setUserCommentsV3Tos` keeps the v1 rows in step).
- **Kept until Phase 6**, with the table they serve: the `Comment` table, its mirror trigger and the
  reverse copy (the rollback path); `trg_moderation_comment` and what drains its queue (the `Comment`
  entry in `entity-moderation.ts`, the Clavata cutover target and the `Comment` text-scan profile),
  since a v1 row synced from a CommentV3 edit still queues a scan there; and `removeAllContent`'s
  delete of v1 rows with no CommentV3 twin, the only path that removes such a row when its author's content is removed.
  Phase 5 removed all of these but the `Comment` table itself (the mirror trigger and
  `trg_moderation_comment` by migration, the function kept).

## Client

- **The page** (`ModelDiscussion`) mounts a `CommentSectionProvider` (model, newest first, no deep
  links: the page's comment links open the thread dialog). The section leaves hidden comments out;
  the grid shows "Showing X of Y comments" from the first page's `counts: { visible, hidden }`,
  and "See N more hidden comments" opens the `hiddenComments` routed dialog (state `{ modelId }`,
  `HiddenCommentsModal`), which lists the section with `hidden: true`.
- **Cards** (`ModelDiscussionV2`, `CommentMasonryVirtual`, `CommentDiscussionItem`) list the
  section's root comments, with the shared `CommentMenu`, `Reactions` and inline edit.
- **Thread dialog** (`CommentThreadModal`) mounts its own provider in thread-only mode (`threadId`).
  It shows the root comment (`CommentItem` with `repliesElsewhere`, so no reply button or replies of
  its own), then "N Comments", a standing reply box (`CommentComposer` with a `parent`), then the
  replies (`CommentReplies`, paged in place).
- **Add Comment** (`CommentEditModal`) creates through `commentv3.create`.
- `CommentMenu` and `useCommentAbilities` are split out of `CommentItem` so the card shares them.

## Rollout

One release, no migration. The event engine deploys before or with the main app. The moderator
app deploys with the main app: before it, its model-comment actions send v1 ids the endpoints no
longer read and are refused; deployed first, it sends CommentV3 ids that the old endpoints look for
in CommentV2: they find nothing for a comment written to the v1 table, which is every model comment
but the few on old v2 model threads, and the app reports nothing affected. Before it ships, a read-only check that every live v1 model comment has
its v3 row (2 orphan replies whose parents are gone were the only gap on 2026-11-06). Rollback is the
reverse copy over `model`, then reverting the release (until Phase 5, which removes the reverse copy).

Soak checks after deploy:
- New model comments are v3-only.
- Pre-flip edits reach the v1 row.
- The three notifications fire.
- Old links open.
- `ModelMetric.commentCount` moves on a new comment.
- Write errors on `commentv3.*` stay at zero.

After the soak, Phase 5 removes the transition code (`comments-v3-phase5.md`) and Phase 6 can drop
the old tables.
