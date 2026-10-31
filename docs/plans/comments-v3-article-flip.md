# Comments v3, Phase 4: the article flip

The first surface to read and write `CommentV3` directly. Background and the rules this follows:
`docs/comments-consolidation.md` (design) and `docs/comments-consolidation-checklist.md` (Phase 4).
Comments on this plan: `@dev:` inline; mine are `@ai:`.

## Decisions taken

- **Article first** (2026-10-26). Lowest risk of the first-tier surfaces after bounty; its comment
  count and stat cache are the only metric it feeds.
- **No feature flags** (2026-10-26). Reads cut over in one deploy, writes in a later one. Safety
  comes from that order instead of a flag:
  - **Stage A, reads.** Old tables still receive every article write and the mirror keeps
    `CommentV3` complete, so a revert is instant and loses nothing.
  - **Stage B, writes.** New article comments exist only in `CommentV3`; rolling back needs the
    reverse copy, proven on the dev database on 2026-10-26.
- **Moderated exactly as `CommentV2` is** (2026-10-30, Briant; replaces "text-scan, not Clavata").
  `CommentV3` has the text-scan profile and the `queueScamScan` call, and also the Clavata path:
  `trg_moderation_commentv3` (migration `20261211120000_comment_v3_moderation_trigger`) queues
  each direct insert or content edit, `entity-moderation.ts` consumes it, and it is a Clavata
  cutover target, owned by text scan on `CommentV2`'s rollout until it has its own. The trigger
  skips rows the mirror copies, which the old table's trigger already queued, so a comment is
  scanned once. A backfill rerun calls the mirror's row functions outside a trigger, so while the
  trigger is enabled its copies are queued too; the job drops one it cannot report. Until the old-row sync goes, an edit to a pre-flip article comment also updates
  its `CommentV2` row and is queued under both types.
- **Tombstones render as placeholders** (2026-10-27). A deleted comment that still has live
  replies shows "This comment was deleted" with no author, content, reactions or menu, and its
  replies stay under it. It shows while a comment below it is visible to the viewer through
  comments the viewer may see; deleting a ToS removal or an excluded author's comment never opens
  what it hid. The delete mutation keeps a comment with replies on the page so the refetch brings
  it back as the placeholder.
- **A tombstone keeps its author** (2026-10-29). Deleting a comment that has replies keeps
  `userId` and blanks the content, as the mirror stores today; the display hides the author.
  Erasure needs nothing more: deleting an account keeps the `User` row and removes its personal
  details, so the id points at nothing personal.
- **Reports are listed once** (2026-10-29). The mirror copies every old comment report into
  `CommentV3Report`, so the `commentV3` report entity matches only reports with no old link (no
  `CommentReport` or `CommentV2Report` row for the same report). The filter goes in Phase 6 with
  the old entities.
- **Article writes, then every read, then the other surfaces' writes** (2026-10-30, Briant).
  Stage B ships as built. Next, one read flip moves every other surface's section and every
  remaining reader of the old tables to `CommentV3`. Once nothing reads the old tables, the
  old-row sync is removed and each other surface's writes flip without it. A comment written after
  the article flip has no `CommentV2` row; the sync keeps the row of an older one in step, so that
  a reader still on the old tables does not serve it after it is deleted or removed, and an
  old-table update does not make the mirror copy it back. Stage B already gives the block checks,
  reaction tracking, `goodContentReward` and the comment owner lookup a `CommentV3` fallback.
- **One write path for every surface** (2026-10-30, Briant; built with their write flips, not in
  stage B). Comic chapters and model comments write through the `commentv3` mutations like every other surface: `comics.createChapterComment`
  and the v1 model-comment writes are removed, not ported. The model's lock toggles
  (`Model.locked`, `Model.meta.commentsLocked`) also set `CommentTopic.locked`, so the one lock
  check covers models.

## Why article first

Articles with hundreds or thousands of comments stop working. Measured 2026-10-26 on the five
heaviest (up to 5,170 comments, 2,340 top-level), first page in the default oldest-first sort,
through the article page's own request:

| Cost                                   | Range                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| Comments on the page                   | 57 to 59 (20 top-level plus up to 40 auto-expanded replies)                   |
| Payload                                | 215 to 458 KB, of which the full per-comment reaction lists are 145 to 403 KB |
| Largest single reaction list           | 477 to 1,531 reactors                                                         |
| Separate reply-count requests after it | 23 to 45, one per comment the page sent no reply data for                     |

The page needs only per-type reaction counts and the viewer's own reactions, and the reply count
of every comment it renders. Comment count is not the cost; these three are, and the fixes are:

1. Reaction counts and the viewer's reactions, never the reactor list.
2. Every rendered comment's reply count in the page response.
3. A page budget measured in rendered comments: top-level comments are added in sort order until
   the page, replies included, reaches the budget, so a comment with a large thread costs its
   share and fewer top-level comments load.

## Stage A: reads, through a reusable v3 comment suite

Twelve surfaces mount today's `CommentsV2` components, each repeating the same provider and
layout boilerplate around nested providers that each fetch on their own. Instead of patching that
per surface, stage A builds a `CommentsV3` suite: one read API and one set of components that
any surface mounts. Article is its first user; each later flip is "mount the suite" rather than a
port. Reads are safe on every surface from day one, since the mirror keeps `CommentV3` complete
while writes still go to the old tables.

### Read API: a `commentv3` tRPC router (Kysely, `kyselyV3Read`)

| Procedure                                             | Returns                                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getSection({ entityType, entityId, sort, cursor? })` | The topic (locked, live count), and one budgeted page: top-level comments plus their opened replies, as a flat list with each parent's child ids, reply count and reply cursor |
| `getReplies({ parentId, sort, cursor? })`             | The next page of one comment's replies, in the same shape, with their own reply counts and first replies within the budget                                                     |
| `getThread({ commentId, entityType, entityId })`      | A focused view for deep links and drilling in: the ancestor chain (from `path`), the comment, and its first replies                                                            |

Each comment carries: id, parent, answered comment (`replyToId`), depth, content, timestamps,
pin, hidden, ToS flag (moderators only), the author (the cached cosmetics and profile picture
path that main uses), reaction counts by type, the viewer's reactions, and its reply count.

Rules kept from the v2 reads: the ToS and moderator rules, the hidden, blocked and blocked-by
exclusions with the content-owner exemption, pinned first, the existing per-surface entity gates
(`assertCommentEntityVisible`), and the surface's display depth from `constants.comments`.
Sorts are `(createdAt, id)` and `(reactionCount, id)` as the design specifies. A tombstone with
something visible below it is sent as a placeholder (`deleted`, author and content withheld);
one with nothing visible below it is left out (Decisions taken).

The budget: top-level comments are taken in sort order; each costs one plus its opened replies
(shallowest first, at most the reply page size per parent, down to the auto-expand depth); the
page stops before the comment that would pass the budget, but always holds at least one. Subtree
sizes come from one grouped count on `rootId`, reply counts from one grouped count on
`parentId`, reactions from one grouped count on `CommentV3Reaction`.

### Client: `src/components/CommentsV3/`

- **`CommentSection`**, the one mount point. Props: entity type and id; `ownerId`, with
  `ownerBadge` and `ownerModerates` to keep the "op" badge and owner hide/pin apart; extra
  `badges`; `hideWhenLocked`, `forceLocked`; `title` (`null` drops the header), `hideSort`,
  `borderless` (every editor), `emptyState`, `anchorId`; `deepLinks` (off for a second section
  on a page). It is keyed by entity, so paging a modal between entities starts clean. It owns the
  section state, sort, deep-link focus, the composer and "load more". The page budget is per
  surface on the server (`constants.comments.getV3PageBudget`).
- **One normalized cache per section** (comments by id, children by parent, cursors), filled by
  `getSection`, `getReplies` and `getThread`, instead of a provider per reply level.
- **Leaves:** `CommentItem` (author, body, menu, reactions, replies toggle), `CommentReplies`,
  `CommentReactionBar` (counts), `CommentComposer`, the hidden-comment placeholder, and the
  focused-thread banner.
- **Reused, not rebuilt:** the rich-text form and sticker picker, `RenderHtml`, `UserAvatar`,
  the `Reactions` bar (it already takes counts plus the viewer's reactions), `SortFilter`,
  `LoadMoreButton`, and the report, hide-user and block-user menu items.
- **Mutations behind one adapter** (`useCommentMutations`): until a surface's writes flip it
  calls today's `commentv2` procedures and updates the v3 cache; at that surface's stage B it
  calls `commentv3` mutations. The switch for a surface is one line.

### Comment links

Every way a reader arrives at a comment keeps working, including links already in inboxes:

| Link                                                                  | Today                                                                                                   | In the v3 section                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/comments/v2/<id>` (permalinks, copy link, moderator tools, strikes) | resolves the entity and redirects with `highlight`, `commentParentType=comment`, `commentParentId=<id>` | `/comments/<id>` is the address copied and linked from now on; `/comments/v2/<id>` stays as an alias of the same page. The section focuses `<id>` through `getThread` |
| Notification links (`threadUrlMap`)                                   | `highlight`, `commentParentType`, `commentParentId`; older ones also `threadId`                         | the same parameters: focus on `commentParentId` when it is a comment, highlight `highlight`; `threadId` is ignored, as it is today                                    |
| Owner notifications (`?highlight=<id>`)                               | the target is fetched with the first page                                                               | highlighted in the list when the first page holds it; otherwise focus its own thread                                                                                  |
| `#comments`                                                           | mounted on first paint only for this hash; otherwise when scrolled near                                 | the section always mounts with the page (one bounded request), so the hash needs no special case                                                                      |

A link to a comment that is gone, hidden from the viewer or under something hidden from them, or
on another entity than the page (`getThread` checks the comment belongs to the page asking) falls
back to the whole section instead of an empty one.

### Also in stage A

- `ArticleDetailComments` mounts `CommentSection`; the `CommentsV2` suite stays for the other
  surfaces until each moves.
- Notification deep links for article comments use `parentId` (checklist, Phase 4).
- Tests: the read API against real Postgres (PGlite, the shared fixture) for sorts, cursors, the
  budget, reply counts, reaction counts, exclusions, pins, deep links and tombstones; component
  tests for the section, expansion and focus.
- Verification before deploy: the queries timed on the production replica, and the heavy
  articles above measured again through the new API.

### Stage A as built (2026-10-27)

- Server in `services/commentv3/read.service.ts`; viewer exclusions shared with the v2 suite via
  `comment-exclusions.service.ts`. `ArticleDetailComments` mounts `CommentSection` with the page
  (the scroll-triggered lazy mount and `forceEagerComments` are gone).
- A `?highlight` alone is shown in the list when the first page holds it and focused otherwise; a
  reply past its parent's first page of replies is focused itself.
- Writes went through `commentv2` (via `useCommentMutations`) until stage B.
- Measured on the heaviest articles through the production replica: one request per page, 19 to
  37 KB, about a quarter of a second warm.
- @ai: open knob. With `v3PageBudget` 40 and `v3RepliesPerRoot` 10, oldest-first opens 3 to 5
  top-level comments on the heaviest articles (newest-first 12 to 24). Fewer replies per thread
  shows more conversations up front.

## Flipping another surface

Each later read flip is: add the surface to `constants.comments.v3ReadSurfaces`, mount
`CommentSection` where its `CommentsV2` section was, set a page budget override if it sits in a
narrow column, and move its tests. What else each one needs, from a review of every
`CommentsV2` mount (2026-10-27):

| Surface                | Mount                                                                      | Also needed                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Post                   | `title`, `anchorId="comments"`                                             | budget override                                                                                                                       |
| Image (page and modal) | `title={null} hideSort borderless`                                         | budget override; `deepLinks={false}` when stacked over another section                                                                |
| Resource review        | `title={null} hideSort`                                                    | budget override; the "N comments" heading reads a v2 count                                                                            |
| Bounty                 | `title={null} hideSort emptyState={null}`                                  | owner hide/pin is new there: decide `ownerModerates`                                                                                  |
| Bounty entry           | `title={null} hideSort borderless`                                         | budget override; `ownerModerates`                                                                                                     |
| Challenge              | `title="Discussion" hideWhenLocked`, judge badge with `ownerBadge={false}` | `ownerId` is the creator                                                                                                              |
| Crucible, storyline    | `title="Discussion" hideWhenLocked`                                        | none                                                                                                                                  |
| 3D model               | `hideWhenLocked`                                                           | `getThreadEntityOwnerId` has no `model3d` case (owner exemption)                                                                      |
| App listing            | Divider and "Discussion" title, `hideWhenLocked`                           | no `appListing` owner case; its browser test mocks the v2 provider                                                                    |
| Comic chapter          | needs design                                                               | writes move to the `commentv3` mutations at its write flip; permalinks and thread links land on the project page; plain-text composer |
| Model discussion       | needs design                                                               | still the v1 masonry and dialog; `model` rows mix v1 and v2 ids                                                                       |

Questions and answers have no `CommentEntityType`; their components are not flipped.

Before the first surface that shows a comment count outside the section (review, comic, bounty,
3D model), `getSection` returns `CommentTopic.commentCount`. Before comic, app listing or post,
decide whether `assertCommentEntityVisible` gains early-access, unapproved and unpublished gates:
it matches v2 today, but `getThread` opens comments by id.

## Stage B: writes

One v3 write path for article comments now and every surface later; each path branches on the
comment's surface. What it covers, beyond the SQL itself:

- **Create and edit.** Blocklist, block checks from the stored row (not client input), the article
  access gate, stickers, `queueScamScan` with a `CommentV3` entity type, event points, the depth
  clamp (the insert trigger derives `path`, `rootId` and `depth`), and the lock check on every
  insert (`CommentTopic.locked` or a locked ancestor). That closes the v2 gap where a deep reply
  under a locked thread was accepted, an intended behaviour change.
- **Delete.** D6: tombstone with replies or a clamped answerer, hard delete when childless;
  collapse tombstones on both edges; hold retention. Covers single delete, moderator bulk delete,
  ban and remove-all-content, and user erasure. A tombstone's `CommentV3Report` links are deleted
  with it.
- **Moderation.** Hide (owner and moderator), pin, ToS set and restore with the full chain
  (reports actioned, reporters rewarded, author notified) against `CommentV3Report`, block-hide,
  scam cleanup and restore, CSAM hold removal. Lock and mutes stay on the `commentv2` procedures.
- **Reactions.** Toggle, block check, ClickHouse tracking, rewards (`goodContentReward` read only
  the v2 table, so a v3-only comment would have earned nothing), notifications.
- **Reports.** `ReportEntity.CommentV3` in both enums, `report-entities.ts` and the relabel
  snapshot's join list (reports listed once, Decisions taken), `report.service.ts` maps and the
  `findReportToFoldInto` case, the context URL, and the report menu sending `CommentV3` on
  article comments.
- **Counts.** An event-engine `CommentV3` handler (table config, Kafka topic,
  `REPLICA IDENTITY FULL`); see "as built".
- **Moderator app.** Bulk delete, remove-as-ToS and restore accept v3 ids; the hold triage gains a
  `CommentV3` type.
- **Rollback.** The reverse copy, rehearsed on the dev database with real stage B writes before
  the deploy. It carries `removedByAuthor` to the old tables (`metadata.removedByAuthor` on
  CommentV2, the column on Comment); the dev rehearsal predates that, so rerun it with a held
  author's deleted comment.

### Stage B as built (2026-10-29, not yet deployed)

- `constants.comments.v3WriteSurfaces` (`['article']`) is the switch; `isV3WriteSurface` reads it.
  The SQL is in `services/commentv3/write.service.ts` over a `SqlRunner`, so callers share a
  Prisma transaction with their sticker spend or old-table arm; moderator actions are in
  `services/commentv3/moderation.service.ts`. Delete runs D6 itself, set-based and waiting on
  row locks rather than skipping them as the mirror's `commentv3_mirror_delete` does.
  Tombstoning deletes the comment's `CommentV3Report` links, as a hard delete's cascade does, so
  its reports leave the queue; the `Report` row stays.
- Legal holds follow the CommentV2 rules (2026-10-30, Briant). Every delete, single or bulk, keeps
  a comment whose author or anyone below it is held, as a ToS violation; one its author deleted is
  marked `removedByAuthor` (migration `20261217120000_comment_v3_removed_by_author`), as is one a
  content wipe keeps. A ToS restore leaves both hidden, and reports them as kept. A ToS removal
  counts a comment already hidden and actions its reports without telling its author again. An
  article with a held author's comment that exists only in CommentV3 is not deleted, since its
  comments cannot be detached as a CommentV2 thread is: the owner's delete is refused, and a
  content wipe keeps it, taken down as a violation (`UnpublishedViolation` with a
  `removedWithOwner` record), so neither its owner nor a pending scan or schedule republishes it.
  The `removedByAuthor` mark is also set on a comment's CommentV2 twin and carried by the reverse
  copy, so the old ToS restore leaves it hidden after a rollback or an article delete.
- The `commentv3` router gains create, update, delete, hide, pin and ToS removal; the suite's
  adapter calls them on a write surface. Lock, comment mute and section mute keep their
  `commentv2` procedures, whose services branch on the surface. The other `commentv2` writes
  (upsert, delete, hide, pin) refuse a write-surface comment, so a stale page cannot skip the new
  lock and parent checks.
- A comment that started in CommentV2 keeps its CommentV2 row, and every CommentV3 write keeps it
  in step: edits and flags are copied to it and a delete removes it. Left stale, the old reads
  would serve deleted or removed content, and an update to the row would make the mirror trigger
  copy a deleted comment back. Paths that act on old rows by user (ban, account wipe, block-hide,
  scam cleanup) leave write-surface comments out of their old-table statement and set them through
  the CommentV3 write path, so every writer locks CommentV3 before CommentV2 and none can deadlock
  another; moderator bulk delete and ToS route write-surface ids the same way.
  Migration `20261210120000_comment_v3_mirror_changed_columns` makes the mirror copy only the
  columns an old-table update changed.
- Block checks and reaction tracking read CommentV3 only when there is no CommentV2 row; the old
  chain resolves the same owners when there is one.
- Counts: `comment-v3.ts` counts every comment on a write surface, whichever table it was written
  to, and `comment-v2.ts` skips those surfaces, so either service can deploy first; a test holds
  the event engine's surface list to `v3WriteSurfaces`. `articleStatCache` needs nothing new: the
  article metrics job already counts from CommentV3 and purges it.
- Text-scan: `CommentV3` follows the `CommentV2` rollout until it is given its own. Verdicts are
  not aliased across the two types: an article comment edited after the flip is scanned afresh
  under `CommentV3`, and its earlier `CommentV2` verdict and hold stay where they are.
- Moderator app: the `commentV3` queue is labelled "Comment (new)" until Phase 6 removes the old
  types; its lists key rows by label, so labels must differ.

Before the deploy, in this order:

1. ~~Apply `20261210120000_comment_v3_mirror_changed_columns` and the ClickHouse
   `2026-10-29-comment-v3-report-entity.sql`, then restart the tracker~~: applied in prod
   2026-10-30.
2. CDC for `CommentV3`: ~~`REPLICA IDENTITY FULL`~~ (applied in prod 2026-10-30,
   `apps/event-engine/scripts/sql/replica-identity.sql`). Still pending: the Kafka topic and read
   access on `CommentV3` for the CDC role (ask an infra owner); then release the event engine.
3. Grant moderators the new `commentV3` report queue in the moderator app.
4. ~~Apply `20261211120000_comment_v3_moderation_trigger`~~: applied in prod 2026-10-30, with
   `trg_moderation_commentv3` in the same enabled state as `trg_moderation_commentv2`. Still
   pending, after the deploy: cut `CommentV3` over wherever `CommentV2` is cut over, with
   `POST /api/admin/temp/text-scan-clavata-cutover` (`{action:'disable', entityType:'CommentV3'}`).
5. Apply `20261217120000_comment_v3_removed_by_author`. The code that reads the column ships with
   the deploy, so the column goes first.
6. ~~The reverse-copy rerun on the dev database~~: done 2026-10-29, every reverse step's dry count
   at zero. A reply under a tombstone with no old row now goes on a reply thread with no parent
   comment; `reverseRootThreads` no longer creates threads for v1-shaped model comments.

## Order

1. Stage A on this branch: PR, deploy, verify on production (responses, timings, notification
   links). Reverting it is a plain revert.
2. Stage B on this branch after stage A has run cleanly: PR, the pre-deploy steps in "Stage B as
   built", deploy.
3. The read flip for every other surface (`Flipping another surface`) and the remaining
   cross-surface readers, in one PR; image and post queries timed on the production replica
   first. A surface goes back to the old reads by leaving `v3ReadSurfaces`.
4. Remove the old-row sync (`syncOldRows` and its callers), since nothing reads the old tables.
5. Each other surface's write flip, one at a time and with no sync, comic chapters and model
   comments last.
