# CommentV3 write flip: every read-flipped surface

Status: **release 1 built, not deployed** (2026-11-03). Follows `comments-v3-article-flip.md`. Model
comments are not in this flip: they move last, reads and writes together, once this one has shipped.

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
- `assertCommentEntityVisible` (v2) shares the storyline and crucible helpers with it, and goes with
  the v2 read procedures in Phase 6.

## The one write path

- `commentv3/comment-write.service.ts` holds the create and the edit (stickers, insert, scam scan);
  the `commentv3` controller adds the checks, tracking and `onCreated`.
- **The challenge judge** calls `writeJudgeComment`: through `upsertComment` while images write
  CommentV2, through the v3 write once they flip. No event points either way. It only creates:
  the manual re-judge endpoints (`re-review`, `challenge-review-replay`) are removed, and so is
  the one-off `backfill-theme-elements`.
- A comment removed for ToS is refused to a member editing, deleting or replying to it, as on v2:
  v3 answers all three as not found, where v2 answers the edit and the delete as forbidden. The
  content owner's hide and pin follow the section's write rules, so the owner of a storyline taken
  down for ToS cannot hide or pin in it, as on v2.
- Comic chapters keep what `comics.createChapterComment` checked (content, the owner's block, the
  comment rate limits, which it kept in a bucket of its own and which now share the one every
  comment write uses; a missing chapter fails the topic's key) and drop its feature flag.
- **Comics, at the flip**: `comics.createChapterComment` and its branch in `useCommentMutations` are
  removed; the chapter page creates through `commentv3.create`.

## Metrics

The event engine counts every `v3ReadSurfaces` surface from CommentV3 already, before the flip: the
mirror copies each CommentV2 write into it, so the count does not depend on which table a comment
was written to. `comment-v2.ts` skips those surfaces by the thread's entity column and now counts only
`UserMetric.commentCount`, on model, 3D-model-review and club-post threads; an orphaned thread has
no owner and counts nothing. `comment-v3-surfaces.parity.test.ts` pins its list to
`v3ReadSurfaces`. Crucible and storyline have no entry, as CommentV2 never counted them.

## What still reads the old tables

Audited 2026-11-03 for every surface but model: each remaining `CommentV2`/`Thread` reader is the
v2 write path (kept for model comments and a rollback), the backfill, reverse copy and mirror, or a
moderation path (reports, account wipe, scam cleanup, block-hide) that routes CommentV3
rows by `v3WriteSurfaces`, so it follows the flip. Old reports still key on the old link tables
until Phase 6.

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

**Release 2**, the flip: `v3WriteSurfaces` becomes `v3ReadSurfaces`, comics' old write is
removed, and `writeJudgeComment` loses its `upsertComment` branch. A page loaded before it writes through `commentv2`, which refuses a flipped surface, until
it reloads, as article did. Review sweep and a dev rollback rehearsal (the reverse copy covers every
surface) before it. The old-row sync stays until Phase 6: old reports still key on the old link
tables.
