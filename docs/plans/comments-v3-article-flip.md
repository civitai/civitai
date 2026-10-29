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
- **Text-scan, not Clavata.** `Comment` and `CommentV2` are in the Clavata cutover set on
  production, so `CommentV3` needs a text-scan profile and the `queueScamScan` call, and no
  `trg_moderation_commentv3` trigger or `EntityType` enum migration.
- **Tombstones render as placeholders** (2026-10-27). A deleted comment that still has live
  replies shows "This comment was deleted" with no author, content, reactions or menu, and its
  replies stay under it. It shows while a comment below it is visible to the viewer through
  comments the viewer may see; deleting a ToS removal or an excluded author's comment never opens
  what it hid. The delete mutation keeps a comment with replies on the page so the refetch brings
  it back as the placeholder.

## Open decisions (needed before the stage they block)

2. **Stage B: a tombstone's author** (D6 left this open). Keep `userId` (as the mirror does
   today), null it, or point it at a sentinel user; plus a privacy check that a tombstone that
   keeps `userId` satisfies erasure. @ai: recommend keeping `userId` and blanking content, as
   the mirror already stores, with the display hiding the author.
3. **Stage B: report double counting.** The mirror copies every old comment report into
   `CommentV3Report`, so adding a `commentV3` report entity next to the old two lists each
   mirrored report twice. @ai: recommend the `commentV3` entity matching only reports with no
   old link (`NOT EXISTS` on `CommentReport` and `CommentV2Report`), and dropping that filter in
   Phase 6 with the old entities.

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
- Writes still go through `commentv2` (via `useCommentMutations`) until stage B.
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

| Surface                | Mount                                                                      | Also needed                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Post                   | `title`, `anchorId="comments"`                                             | budget override                                                                                                            |
| Image (page and modal) | `title={null} hideSort borderless`                                         | budget override; `deepLinks={false}` when stacked over another section                                                     |
| Resource review        | `title={null} hideSort`                                                    | budget override; the "N comments" heading reads a v2 count                                                                 |
| Bounty                 | `title={null} hideSort emptyState={null}`                                  | owner hide/pin is new there: decide `ownerModerates`                                                                       |
| Bounty entry           | `title={null} hideSort borderless`                                         | budget override; `ownerModerates`                                                                                          |
| Challenge              | `title="Discussion" hideWhenLocked`, judge badge with `ownerBadge={false}` | `ownerId` is the creator                                                                                                   |
| Crucible, storyline    | `title="Discussion" hideWhenLocked`                                        | none                                                                                                                       |
| 3D model               | `hideWhenLocked`                                                           | `getThreadEntityOwnerId` has no `model3d` case (owner exemption)                                                           |
| App listing            | Divider and "Discussion" title, `hideWhenLocked`                           | no `appListing` owner case; its browser test mocks the v2 provider                                                         |
| Comic chapter          | needs design                                                               | writes go through `comics.createChapterComment`; permalinks and thread links land on the project page; plain-text composer |
| Model discussion       | needs design                                                               | still the v1 masonry and dialog; `model` rows mix v1 and v2 ids                                                            |

Questions and answers have no `CommentEntityType`; their components are not flipped.

Before the first surface that shows a comment count outside the section (review, comic, bounty,
3D model), `getSection` returns `CommentTopic.commentCount`. Before comic, app listing or post,
decide whether `assertCommentEntityVisible` gains early-access, unapproved and unpublished gates:
it matches v2 today, but `getThread` opens comments by id.

## Stage B: writes

A v3 write service (`commentsv3.service.ts`, Kysely through `kyselyV3Write` so `updatedAt` is
stamped), used for article comments and, in later flips, every surface. Each path branches on
`resolveSurface`.

- **Create and edit.** Blocklist, block checks from the stored row (not client input), the article
  access gate, stickers, `queueScamScan` with a `CommentV3` entity type, event points, the
  depth clamp (the insert trigger already derives `path`, `rootId` and `depth`), and the lock
  check on every insert (`CommentTopic.locked` or a locked ancestor), which closes the v2 gap
  where a deep reply under a locked thread was accepted. That is an intended behaviour change.
- **Delete.** D6: tombstone with replies or a clamped answerer, hard delete when childless, after
  the mirror's two-step row lock; collapse tombstones on both edges; hold retention. Covers single
  delete, moderator bulk delete, ban and remove-all-content, and user erasure.
- **Moderation.** Hide (owner and moderator), pin, lock, ToS set and restore with the full chain
  (reports actioned, reporters rewarded, author notified) against `CommentV3Report`, block-hide,
  scam cleanup and restore, CSAM hold removal.
- **Reactions.** Toggle, block check, ClickHouse tracking, rewards (`goodContentReward` reads the
  v2 table today, so a v3-only comment would silently earn nothing), notifications.
- **Reports.** `ReportEntity.CommentV3` in both enums, `report-entities.ts` and the relabel
  snapshot's join list (with decision 3), `report.service.ts` maps and the
  `findReportToFoldInto` case, the context URL from the row's `entityType`, and the report menu
  sending `CommentV3` on article comments.
- **Mutes.** Comment and section mutes write `CommentMute` / `CommentTopicMute`, keeping the shared
  `commentv2.mute` rate limit.
- **Text-scan.** A `CommentV3` profile, entity type, retention entry, scam adapter entry and CSAM
  hold case; verdict and retention lookups alias old ids (v2 by id, v1 by `legacyV1Id`).
- **Counts.** An event-engine `CommentV3` handler (table config, Kafka topic, `REPLICA IDENTITY
FULL`) that counts article comments, replies included, takes one off on the tombstone and not
  again when it collapses, and dedupes against `comment-v2.ts` by comment id. `articleStatCache`
  purged after a count recompute.
- **Moderator app.** Bulk delete, remove-as-ToS and restore accept v3 ids; the hold triage gains a
  `CommentV3` type.
- **Rollback.** Fix `reverseRootThreads` creating empty model threads (it counts v1-shaped pending
  comments, which need no thread), then rerun the reverse-copy proof on the dev database with
  real stage B writes before the deploy.

## Order

1. Stage A on this branch: PR, deploy, verify on production (responses, timings, notification
   links). Reverting it is a plain revert.
2. Stage B on this branch after stage A has run cleanly: PR, the reverse-copy rerun, deploy.
3. Then the checklist's article surface items are ticked and bounty follows the same pattern.
