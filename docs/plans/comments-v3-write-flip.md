# CommentV3 write flip: every read-flipped surface

Status: **release 1 merged; release 2 built, not deployed** (release 1 2026-11-03, release 2
2026-11-05; the dev rollback rehearsal passed 2026-11-05). Follows `comments-v3-article-flip.md`. Model
comments are not in this flip: they move last, reads and writes together, once this one has shipped.

> **Superseded in part by `comments-v3-phase5.md`.** Phase 5 removes the surface switches
> (`v3ReadSurfaces`/`v3WriteSurfaces`), the old-row sync, the reverse copy (so there is no rollback
> to the old tables), `commentsv2.service.ts`, the CommentV2 event-engine handler and its parity
> test, and drops the mirror triggers. "Metrics", "What still reads the old tables" and the
> rollback notes below describe the state before it.

## Decisions (Briant, 2026-11-03)

- **All read-flipped surfaces flip at once**: image, post, review, bounty, bounty entry, challenge,
  crucible, storyline, 3D model, app listing, comic chapter (`v3ReadSurfaces`). Article already
  writes CommentV3.
- **One write service and one router.** Every CommentV3 write goes through `commentv3`. Comics stop
  writing comments from `comics.router.ts`; the daily-challenge judge stops calling the v2
  `upsertComment`.
- **Per-surface rules live in one place**, a registry the write path asks rather than branching on
  `entityType` itself.
- **Comments are not held for legal review** (Briant, 2026-11-04, on the CSAM reviewer's word):
  every comment hold, v2's included, was removed by #7820 (#7788 re-landed after its revert in
  #7794). Release 1 has no hold code.
- **No feature flag on comic comment writes**: the comic pages check the flag themselves.

## The surface registry

`src/server/services/commentv3/surfaces.ts`, keyed by every `CommentEntityType`, so a new entity
type does not compile until it has an entry:

```ts
type CommentSurface = {
  assertVisible?(entityId: number, ctx: CommentReadContext): Promise<void>; // reads and writes
  assertWritable?(entityId: number, ctx: ProtectedContext): Promise<void>; // create and edit
  onCreated?(comment: StoredCommentV3, ctx: ProtectedContext): void; // side effects only
};
```

- The ClickHouse type a new top-level comment is tracked as is not in it either: `commentTrackTypes`
  in `clickhouse/tracker.ts` maps entity types to `CommentType`, beside that type; a reply is `Comment`.
- The owner is not in it: `getBlockCheckOwnerIds` resolves every current entity type's owner (on
  the primary, except image, post and article, which try the replica first). Its switch does not
  cover `CommentEntityType`, so a new comment entity type needs an owner case added there by hand.
  The controller uses it for block checks and hide and pin rights.
- Entries reuse each surface's existing helper: storyline (its feature flag and visibility, and the
  takedown check on writes), crucible, bounty and bounty entry visibility, article and post access,
  the image's live comment metric, and comics' `new-comic-comment` notification.
- A reply is checked against its parent's surface: every CommentV3 row carries its section's
  `entityType` and `entityId`, so v2's walk up the threads to find a storyline or crucible is gone.
- `assertCommentEntityVisible` was the v2 equivalent; it went with `commentv2.controller.ts` in
  release 2.

## The one write path

- `commentv3/comment-write.service.ts` holds the create and the edit (stickers, insert, scam scan);
  the `commentv3` controller adds the checks, tracking and `onCreated`.
- **The challenge judge** calls `writeJudgeComment`, which writes CommentV3 directly (release 2;
  before it, images went through `upsertComment`). No event points: only the `commentv3`
  controller awards them, and the judge does not go through it. It only creates:
  the manual re-judge endpoints (`re-review`, `challenge-review-replay`) are removed, and so is
  the one-off `backfill-theme-elements`.
- A comment removed for ToS is refused to a member editing, deleting or replying to it, as on v2:
  v3 answers all three as not found, where v2 answers the edit and the delete as forbidden. The
  content owner's hide and pin follow the section's write rules, so the owner of a storyline taken
  down for ToS cannot hide or pin in it, as on v2. Hide and pin answer a member a comment removed
  for ToS as not found too.
- Comic chapters keep what `comics.createChapterComment` (removed) checked (content, the owner's
  block, the comment rate limits, which it kept in a bucket of its own and which now share the
  `commentv3:write` bucket of `commentv3.create` and `update`; a missing chapter fails the topic's key) and
  drop its `comicCreator` feature flag: comics as a whole sit behind it. Their comments follow the
  comic reader's visibility instead, through the reader's own rules in
  `services/comics/chapter-visibility.ts`: a published chapter whose panels are all clean, in a
  published project not taken down for ToS, whose author is not banned and has not blocked or been
  blocked or hidden by the reader. Its owner and a moderator see any chapter. Nobody sees one in a
  deleted project, one with no ready panels, or a mature comic on the green domain. Two reader
  rules are not applied: its `comicCreator` flag, and its early-access lock, so a reader without
  access to an early-access chapter can still read and write its comments.
- Thread mute and comment reports use the same gate as reactions (`assertCommentActionable`). A
  removed comment, or one in a section the caller cannot see, is not found; a comment in a
  storyline taken down for ToS is refused to members. A report filed under
  the old comment type goes through it too, since a pre-flip comment keeps its id in both tables.
- **Comics, at the flip**: `comics.createChapterComment` and its branch in `useCommentMutations` are
  removed (release 2); the chapter page creates through `commentv3.create`. Block-hide resolves a
  chapter's owner through its project (`SECTION_OWNERS` in `block-hide-comments.service.ts`, `V3_SECTION_OWNERS` until Phase 5).

## Metrics

The event engine counts every `v3ReadSurfaces` surface from CommentV3 already, before the flip: the
mirror copies each CommentV2 write into it, so the count does not depend on which table a comment
was written to. `comment-v2.ts` skips those surfaces by the thread's entity column and now counts only
`UserMetric.commentCount`, on 3D-model-review and club-post threads (model joined the CommentV3
surfaces in the model flip, `comments-v3-model-flip.md`); an orphaned thread has
no owner and counts nothing. `comment-v3-surfaces.parity.test.ts` pins its list to
`v3ReadSurfaces`. Crucible and storyline have no entry, as CommentV2 never counted them. Phase 5
deletes `comment-v2.ts`, `COMMENT_V3_SURFACES` and that test: `comment-v3.ts` counts the comments of
every surface in its own `SURFACES` map.

## What still reads the old tables

Audited 2026-11-03 for every surface but model: each remaining `CommentV2`/`Thread` reader is the
backfill, reverse copy and mirror, the old-row sync and the delete and ToS functions left in
`commentsv2.service.ts`, or a
moderation path (reports, account wipe, scam cleanup, block-hide) that routes CommentV3
rows by `v3WriteSurfaces`, so it follows the flip. Old reports still key on the old link tables
until Phase 6. Release 2 deleted the v2 write path; model comments wrote v1 until the model flip
(`comments-v3-model-flip.md`, built 2026-11-06), and 3D model reviews have no comment UI. Phase 5
removes these readers, except those listed under "Kept, with reasons" in `comments-v3-phase5.md`.

## ClickHouse comment tracking (open)

`ctx.track.comment` feeds the moderator app's comment-spam detection
(`comment-spam.service.ts`, `user-signals.service.ts`) and the model metrics' `type = 'Model'`
read. v2 tracks image, post, review, bounty and bounty entry comments and every reply; release 1
does the same on the v3 write. Article, challenge, crucible, storyline, 3D model, app listing and
comic chapter comments are not tracked, because `CommentType` has no value for them.

- @ai: whether ClickHouse's `comments.type` column accepts new values (an Enum would reject them) is
  for an infra owner to confirm before adding them.

## Order

**Release 1**, the flip off: everything above. No migration.

**Release 2**, the flip (built 2026-11-05, not deployed): `v3WriteSurfaces` copies
`v3ReadSurfaces`, so every surface but model writes CommentV3; `comics.createChapterComment` is
removed; `writeJudgeComment` writes CommentV3 only; and `upsertComment` is deleted with the rest of
the v2 write path (below), so only the `commentv3` controller awards comment event points.

The `commentv2` application code goes with it, since nothing calls it once every surface but model
writes CommentV3 (model comments write through the v1 `comment` router):

- Deleted: the `commentv2` router, controller and schema, `commentv2.selector.ts` and
  `commentsv2.reply-threads.ts`. `commentsv2.service.ts` keeps only what other code calls: the
  judge read, the owner lookup, `isCommentGoneForMembers` and the old-row delete and ToS functions.
- Moved to `commentv3`: the section lock (moderator-only in its handler), the section and thread
  mutes and their status reads (`commentv3/section.service.ts`), and the reaction gate
  `assertCommentActionable`, which now reads the comment's own section in CommentV3. The rate-limit
  keys are `commentv3:write` and `commentv3:mute`.
- So a page loaded before the deploy fails its comment writes, mutes and lock with a missing
  procedure, not a reload prompt, until it reloads; comic chapter comments included.

Kept until release 2 has soaked, as the rollback path: the old tables, the mirror trigger, the
reverse copy and the old-row sync (old reports still key on the old link tables). Code shared with
v1 model comments went with the model flip (`comments-v3-model-flip.md`), or waits for Phase 6.
Phase 5 removes the mirror triggers, the reverse copy and the old-row sync, and with them this
rollback path.

**Dev rollback rehearsal, 2026-11-05: passed.** On every write surface, release 2 shaped writes on
the dev database (a top-level comment, a reply to it, a reply to a pre-flip comment, an edit of a
pre-flip comment, a topic lock, a section mute, a comment mute and a reaction), then the reverse copy:
the old tables held each, with the right thread links, and a comment deleted after the first pass
lost its old row on the second. The dry counts were zero after, and the writes were removed.
