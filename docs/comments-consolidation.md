# Comments Consolidation Plan

Consolidate the legacy `Comment` table (model discussions) and the `CommentV2` + `Thread` pair
(everything else) into one comment table that is cheap to page, easy to drill into, and
depth-limited by design.

Execution tracking lives in the companion checklist:
[comments-consolidation-checklist.md](comments-consolidation-checklist.md).

Status: **proposal, decisions settled 2026-08-24** (Briant):

1. Questions & Answers comments are **not migrated** — dropped with the surface.
2. The model page **keeps its current UI** for now — the migration swaps the storage under it,
   not the presentation (display depth 1, flat root+replies).
3. Hard stored-depth cap of **20** with clamp-to-sibling: approved.
4. Reactions/reports unification is **in scope** (revised 2026-08-24 — originally deferred, but the
   old join tables FK-reference the old comment tables, so deferring it would block Phase 6
   teardown indefinitely).
5. The table is named **`CommentV3` permanently** — no post-teardown rename.

## Why the current system is expensive

**Two parallel systems.** `Comment` is hard-bound to `modelId` with a self-referencing `parentId`;
`CommentV2` hangs off a `Thread` row, and *nesting* is modeled by giving each parent comment its own
child `Thread`. Every cross-cutting concern pays twice: notifications (`new-thread-response` and
mentions are literal SQL `UNION`s of both tables), moderation endpoints take `{ commentIds, commentV2Ids }`,
reactions/reports each have two join tables, the event-engine has two CDC handlers, and the
moderator app renders "Model comments" and "Other comments" as separate panels.

**Thread makes everything indirect.** `Thread` has ~15 nullable entity FK columns, resolved with a
dynamic `findUnique({ [`${entityType}Id`]: entityId })` cast through `as unknown as`. A nested
comment's own thread carries *no* entity FK, so answering "what is this comment on?" requires
`comment → thread → rootThread → COALESCE across 15 columns`. That fallback chain is re-implemented
in at least 9 places (notifications ×4, permalinks, moderator app ×2, event-engine, creator-studio).

**"Load more replies" costs a recursive CTE.** Because reply pages live in child threads,
`getReplyThreads` walks `Thread.parentThreadId` recursively, then fetches comments for the selected
thread ids, then regroups them in JS (`commentsv2.reply-threads.ts`). It works, but every level of
the tree is a join through a second table, and reply counts require trigger-maintained
`Thread.commentCount` plus a per-request `groupBy` for hidden counts.

## Target data model

One row per comment. Every row knows its entity, its parent, its root, and its depth — no
resolution chain, no second table on the read path.

```prisma
enum CommentEntityType {
  model
  image
  post
  article
  review
  bounty
  bountyEntry
  challenge
  comicChapter
  appListing
  model3d
  model3dReview
}

model CommentV3 {
  id           Int       @id @default(autoincrement()) // sequence seeded past max(CommentV2.id, Comment.id)
  entityType   CommentEntityType
  entityId     Int
  parentId     Int?      // null = top-level
  parent       CommentV3? @relation("Replies", fields: [parentId], references: [id], onDelete: Cascade)
  rootId       Int?      // top-level ancestor; null for top-level comments
  depth        Int       @default(0) // 0 = top-level

  userId       Int
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  content      String
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  tosViolation Boolean   @default(false)
  hidden       Boolean   @default(false) // NOT NULL — fixes v1/v2's nullable booleans
  locked       Boolean   @default(false) // "no new replies under me"
  pinnedAt     DateTime?

  reactionCount Int      @default(0) // maintained as today
  childCount    Int      @default(0) // direct replies, trigger-maintained
  legacyV1Id    Int?     @unique     // original legacy Comment.id, for old permalinks/notifications

  replies      CommentV3[] @relation("Replies")
}

model CommentTopic {
  entityType   CommentEntityType
  entityId     Int
  locked       Boolean           @default(false)
  commentCount Int               @default(0) // trigger-maintained, replaces Thread.commentCount

  @@id([entityType, entityId])
}
```

Schema-review notes (2026-08-25 pass, complexity trimmed):
- **No `path` column / no GIN index.** An earlier draft carried `path Int[]` + GIN for
  subtree-of-a-non-root fetches. Dropped: `rootId` + `depth` + `(parentId, id)` cover every hot
  path, and the one thing `path` served — prefetching a *re-rooted* comment's subtree — is rare,
  bounded (budget × depth ≤ 20), and fine as per-parent paging or a small recursive CTE. If deep
  subtree ops ever become hot, `path` is derivable from `parentId` and can be added with a
  backfill later. This also removes the array-maintenance from insert/clamp logic and backfill.
- **No `nsfw`, no `metadata` — pending a Phase 0 check.** `CommentV2.metadata` appears in no
  selector and has no writer we could find; comment `nsfw` is accepted on upsert input but read
  nowhere in the v2 UI, and v1's NSFW comment filter is commented out. Phase 0 counts
  `metadata IS NOT NULL` and `nsfw = true` in prod; if ~0, they stay dropped (and the upsert
  input's `nsfw` field is removed), otherwise they come back as plain columns.
- **`CommentTopic` has no surrogate id** — nothing references it; `(entityType, entityId)` is the
  natural PK and saves a sequence plus a second unique index.
- **`userId` cascade is a backstop, not the deletion path.** User rows are soft-deleted in
  practice; comment removal on account deletion goes through `user.service.ts`, which is where the
  tombstone decision (above) gets applied. The FK cascade only fires on a hard User delete.

Reactions and reports get one join table each, replacing the v1/v2 pairs:

```prisma
model CommentV3Reaction {
  id        Int             @id @default(autoincrement())
  commentId Int
  comment   CommentV3       @relation(fields: [commentId], references: [id], onDelete: Cascade)
  userId    Int
  user      User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  reaction  ReviewReactions
  createdAt DateTime        @default(now())
  updatedAt DateTime        @updatedAt

  @@unique([commentId, userId, reaction])
}

model CommentV3Report {
  commentId Int
  comment   CommentV3 @relation(fields: [commentId], references: [id], onDelete: Cascade)
  reportId  Int       @unique
  report    Report    @relation(fields: [reportId], references: [id], onDelete: Cascade)

  @@id([reportId, commentId]) // same shape as CommentV2Report, least churn in report plumbing
  @@index([commentId])
}
```

Reaction rows get fresh ids (nothing durable references a reaction row id); `commentId` maps 1:1
for v2 and via `legacyV1Id` for v1. Report rows re-point the same way — the `Report` row itself
(status, reason, rewards history) is untouched, only the join moves.

`CommentTopic` is the one Thread responsibility that can't live on a comment row: an entity-level
lock must exist before any comment does (today's `toggleLockCommentsThread` creates a locked empty
thread), and `challenge.service.ts` + `getCommentCount` read an entity-level count. It is created
lazily, exactly like `Thread` is today — but keyed by `(entityType, entityId)` instead of 15 FK
columns. Entity FKs are dropped entirely; entity deletion cleans up comments via an
`onDelete` handled in the service (see Phase 5 note) or a periodic sweep, since polymorphic keys
can't carry a real FK. (Today `Thread` FKs are `SetNull`, which already orphans comments silently —
we are not losing integrity we currently have.)

### Indexes (raw SQL, several partial)

```sql
-- top-level pages, Oldest/Newest keyset. Deliberately NOT filtered on hidden: hidden rows are
-- rare, a residual filter is cheap, and the same index then serves the moderator hidden-comments
-- view (which would otherwise have no index at all).
CREATE INDEX ... ON "CommentV3" ("entityType", "entityId", id)
  WHERE "parentId" IS NULL AND "pinnedAt" IS NULL;
-- top-level pages, MostReactions keyset
CREATE INDEX ... ON "CommentV3" ("entityType", "entityId", "reactionCount" DESC, id DESC)
  WHERE "parentId" IS NULL AND "pinnedAt" IS NULL;
-- pinned comments (small, first page only)
CREATE INDEX ... ON "CommentV3" ("entityType", "entityId") WHERE "pinnedAt" IS NOT NULL;
-- reply pages + reply hidden counts
CREATE INDEX ... ON "CommentV3" ("parentId", id);
-- whole-subtree fetch for auto-expand
CREATE INDEX ... ON "CommentV3" ("rootId", depth, id);
-- moderation / user lookup / account deletion / judge gate
CREATE INDEX ... ON "CommentV3" ("userId", id);
```

(If the tombstone decision lands, the two top-level partials gain `AND "deletedAt" IS NULL`.)

## The interactions, as queries

Every interaction is one index-backed query on one table:

| Interaction | Query |
|---|---|
| First page of an entity's comments | `WHERE entityType/entityId AND parentId IS NULL ORDER BY <sort> LIMIT n` (keyset cursor, same 3 sort modes as today) |
| Does this comment have replies? / "Show N replies" | `childCount` on the row — **no query**, kills v1's per-page `GROUP BY parentId` and the childless-comment bookkeeping in `reply-threads.ts` |
| Load more replies under a comment | `WHERE parentId = ? AND id > cursor ORDER BY id LIMIT k` |
| Auto-expand replies d levels deep for a page of roots | `WHERE rootId = ANY(pageIds) AND depth <= d AND NOT hidden ORDER BY rootId, depth, id` — **no recursive CTE**; the existing budget selector (`selectReplyThreadsWithinBudget`) ports over using `childCount` |
| Drill into / re-root on a deep comment | `parentId = commentId` page-by-page (each level pages the same way); bulk prefetch of its subtree, if ever needed, is a small recursive CTE bounded by budget × depth cap |
| Deep-link / notification / moderation "what is this on?" | the row itself carries `entityType`, `entityId`, `rootId` — **single-row read**, replaces the 15-column COALESCE chain in 9 call sites |
| Entity comment count / locked | one `CommentTopic` row |

## Depth limiting

Today `constants.comments.getMaxDepth` (10 for article/bounty/challenge, 3 for image/bountyEntry,
5 default) is a **UI ceiling**: at the ceiling the client re-roots the view on that comment
(`setRootThread`) and depth in the DB grows unbounded. v1 model comments are a hardcoded two
levels (root + flat replies; replies "to a reply" are just @mentions on the same parent).

The new model makes both real:

- **Display depth** stays per-surface in `constants.comments`, driving auto-expand and the re-root
  behavior exactly as now. Model comments become `entityType: 'model'` with display depth 1,
  reproducing today's flat UX — the model page keeps its current presentation (decision 2).
- **Stored depth gets a hard cap** (propose 20, as a `CHECK (depth <= 20)`): the write path clamps a
  reply that would exceed it to be a *sibling* (parent = ancestor at cap−1), preserving the
  @mention-style conversation without unbounded trees. `depth`/`rootId` come from the parent row
  at insert (`parent.depth + 1`, `parent.rootId ?? parent.id`) — clients never send them; the
  rare clamp walks `parentId` upward, which only ever happens at the cap.

## Deletion semantics — open decision

The schema above says `parentId ... onDelete: Cascade`, which makes deleting a comment destroy its
**entire subtree — including other users' replies**. That is what legacy v1 does, but it is *not*
what v2 does: deleting a CommentV2 `SetNull`s its child thread's `commentId`, so replies are
retained but become unreachable. Neither is obviously right, and the cascade is the dangerous
default (a user — or an account deletion via `user.service.ts` — hard-deleting other people's
writing).

**Recommendation: soft-delete when `childCount > 0`, hard-delete otherwise.** A deleted comment
with replies becomes a tombstone (`deletedAt` set, content blanked at read time, author hidden);
a childless comment deletes outright. This matches what users *see* today on both systems (the
parent disappears or hollows out, replies keep rendering or not per surface), avoids destroying
other users' content, and keeps `childCount`/`commentCount` trigger math simple. Requires a
`deletedAt DateTime?` column and `AND "deletedAt" IS NULL` in the partial indexes. Account
deletion then tombstones the user's parented comments and hard-deletes the rest — a behavior to
confirm against privacy/GDPR expectations (today's code hard-deletes the rows; replies to them
already survive in v2, so retention of *other users'* replies is unchanged either way).

If instead we keep hard-delete-with-cascade everywhere, that's a deliberate product change from
v2's behavior and should be called out at rollout.

## Moderation, blocking, and comment-gating — preserve-behavior checklist

These are service-layer behaviors, so the table swap doesn't break them by construction — but each
must be explicitly re-verified on the new service, because they're what a naive port drops.

**Moderator actions** (all live in the services being rewritten):
- **Hide** (`toggleHideComment`, both systems): `hidden` column carries over; the read paths'
  `hidden`/`hiddenCount` handling is already in the query design.
- **Pin** (`togglePinComment`): v1 restricts pinning to root comments (raw SQL enforces
  `parentId IS NULL`); v2 pins within any thread page. The new model pins within a comment's
  sibling page (`pinnedAt` ordered first, as today), which subsumes both — the v1 restriction
  becomes moot rather than ported.
- **Lock**: three semantics exist today; the new model reproduces two and *improves* one:
  (a) entity-level lock (`toggleLockCommentsThread`, can pre-exist comments) → `CommentTopic.locked`;
  (b) v1's per-comment lock, which propagates to **direct children only** (`updateMany where
  parentId = id`) → per-comment `locked` checked against the direct parent on write, same reach;
  (c) **known gap being closed**: v2's entity lock is only checked when a comment lands in the
  entity's own thread — a reply to a nested comment checks its parent's child-thread lock, so a
  locked article can still receive deep replies server-side (the UI hides the button; the API
  doesn't enforce it). The new write path checks `CommentTopic.locked` on **every** insert (the
  row's `entityType`/`entityId` makes that one lookup), closing the gap. Flag it as an intentional
  behavior change, not a regression.
- **TOS violation** flows (v1 `setTosViolation` handler and v2 `bulkSetCommentV2TosViolation`):
  both do set-flag → action matching reports → reward reporters → notify the author. The merged
  service keeps that whole chain, against `CommentV3Report`.
- Bulk delete/TOS endpoints, the `entity-moderation` auto-mute job, the Clavata scan triggers, and
  strikes/appeals on comments are covered in the phases below.

**User blocking** — two enforcement points, restated here as behaviors to re-verify:
- **Write-time**: creating a comment checks `throwIfBlockedByEntityOwner`; *editing* re-resolves
  owners from the stored comment (`getBlockCheckOwnerIdsForComment` in `block-check.service.ts`),
  deliberately not trusting client-supplied entity params. That owner resolution currently walks
  `rootThreadId` — it becomes a single-row read, but the don't-trust-the-client property must
  survive the rewrite.
- **Read-time**: hidden/blocked/blockedBy exclusion lists (`boundExcludedUserIds`, including the
  bind-parameter cap) with the **content-owner exemption** (`isViewerContentOwner` — an owner
  still sees a blocker's comments on their own content, for reporting). Phase 5's "unify exclusion
  logic" bullet is where this lands; the exemption is the easiest part to lose. Notification
  queries carry their own `notBlockedBetween` filters — preserved through the Phase 5 rewrites.

**Preventing users from commenting**:
- Mute/ban/onboarding gating is `guardedProcedure` (`trpc.ts` — `isOnboarded` + `isMuted`) on both
  `comment.upsert` and `commentv2.upsert`. It's router-level and the routers don't change; the only
  requirement is that the unified upsert stays behind `guardedProcedure`.
- The `entity-moderation` job's auto-mute also bulk-hides the muted user's recent comments — its
  dual-table branches are in the Phase 5 cron-jobs section.
- `throwOnBlockedLinkDomain` (content blocklist) runs inside `upsertComment` on create **and**
  edit; carries over with the service.
- Verified: there is **no** per-entity "comments disabled" flag anywhere — entity/comment locks are
  the only mechanism, so nothing else needs a home in the new model.

## ID strategy — the part that keeps history working

Old ids are load-bearing in three places: notification `details` rows carry a `version`
discriminator (`comment.detail-fetcher.ts` splits on it), permalinks (`/comments/v2/<id>`,
`?dialog=commentThread&highlight=<id>`), and ClickHouse `commentEvents.commentId` (which already
mixes both id spaces with no discriminator — pre-existing corruption we can stop, not fix).

Plan:
- **CommentV2 rows keep their ids.** They're the overwhelming majority and every modern link format
  points at them.
- **One shared sequence during the transition.** Seeding CommentV3's sequence "past max" once is
  not enough: CommentV2 keeps allocating ids all through dual-write, and flips are per-surface, so
  two independent allocators would run in overlapping ranges and collide. Instead, Phase 1 creates
  the CommentV3 sequence seeded past `max(CommentV2.id, Comment.id)` and **re-points `Comment` and
  `CommentV2`'s id defaults at that same sequence**. From then on all three tables draw from one id
  space — no headroom guessing, no `setval` choreography at each flip, and dual-written rows carry
  the same id on both sides by construction.
- **Legacy v1 rows get new ids**, with the original id in `legacyV1Id` (unique). The notification
  detail-fetcher's `version !== 2` branch resolves via `legacyV1Id` — that shim is permanent (old
  notification rows never go away) but tiny.
- ClickHouse tracking starts sending `entityType` + new comment id explicitly on every event;
  `model.metrics.ts`'s dependence on `entityId = modelId` for `type='Model'` is preserved during
  transition and re-pointed in Phase 5.

## Migration plan

The tRPC contract (`commentv2` router shapes) and the client (`CommentsProvider`, `Comment.tsx`)
stay as-is — the swap happens inside the service layer, so UI churn is near zero for v2 surfaces.

**Phase 0 — measure & decide.** Prod queries (blocked from this session, need a human or an
allowed session): row counts for `Comment`/`CommentV2`/`Thread`; v1 depth distribution (rows with
`parentId` whose parent also has `parentId` — believed unreachable in UI); Thread orphan count
(all entity FKs null — note `Thread.imageId` and `Thread.challengeId` have **no FK constraint in
prod**, an accepted drift in `schema-drift/drift-baseline.json`, so orphans pointing at deleted
images/challenges are expected, not hypothetical); per-entityType comment volume; `Thread` rows for
dead surfaces (`clubPostId`, `questionId`/`answerId`). Two schema facts to confirm:
`Thread.modelId`/`challengeId`/`model3dId` are declared `@unique` but their back-relations are
lists (`Model.threads Thread[]` etc.) — verify they are truly 1:1 in prod before assuming one
`CommentTopic` row per entity.
**Prerequisite:** `ComicChapter` needs an integer surrogate id (same pattern as
`AppListing.serialId` — note `Thread.appListingId` already references that surrogate, not the TEXT
ULID) because its Thread key is composite `(projectId, position)`.

**Phase 1 — schema.** New tables (`CommentV3`, `CommentTopic`, `CommentV3Reaction`,
`CommentV3Report`), indexes, `CHECK` constraints, count triggers (`childCount`,
`CommentTopic.commentCount`, and a port of `update_comment_reaction_count` — the trigger on
`CommentV2Reaction` from migration `20251020155046` — onto `CommentV3Reaction`). Two more
DB-level items found in the sweep:
- **Clavata auto-moderation triggers**: `trg_moderation_comment`/`trg_moderation_commentv2`
  (migration `20250521094141`) enqueue `('ModerationRequest', entityType, id)` into `JobQueue` on
  insert/content-update. CommentV3 needs the equivalent trigger, which needs a `CommentV3` value in
  the `EntityType` pg enum — an additive enum change, so the expand/contract deploy-first rule
  applies — and `entity-moderation.ts` must consume the new value.
- **`packages/civitai-db-schema/src/kysely/updated-at-tables.ts`** is a hand-curated allowlist, not
  generated: add the new tables or their `updatedAt` silently never updates under Kysely writers.
Deploy the regenerated client *before* applying the enum-bearing migration writes anything
(expand/contract rule in CLAUDE.md). Migrations applied manually as always.

**Phase 2 — dual-write, deployed to production first.** Both existing comment write paths
(`comment.service` upsert/delete/hide/pin/lock and `commentsv2.service.upsertComment` etc.) also
write CommentV3 in the same transaction, and `reaction.service.ts` (`comment` and `commentOld`
entity types) plus report creation dual-write their new tables the same way — `commentOld`
resolving the target row via `legacyV1Id`. Two write paths that are easy to miss because they
aren't in the comment services: **account deletion** (`user.service.ts` deletes reaction + comment
rows directly — it must delete from the new tables too, or a deleted account's comments resurrect
on flip) and **`toggleLockCommentsThread`** (must set `Thread.locked` and `CommentTopic.locked`
together, same reasoning as the entity-moderation dual-hide). Note the `no-io-in-transaction`
guard — the dual write is same-DB SQL, which is fine.

Dual-write ships **before** the backfill runs: with the live edge already maintained, one
converged backfill pass makes the table complete and it *stays* complete — no moving-target
window to chase. Before enabling, provision the CDC pipeline for the new table: add
`public.CommentV3` to `apps/event-engine/src/config/index.ts`'s table subscription list and create
the `postgres.CommentV3` Kafka topic (`apps/event-engine/scripts/create-kafka-topics.ts`) — a gap
here silently stops comment-driven metrics for rows that only exist in the new table.

**Phase 3 — backfill.** Runs under live dual-write, so every copy job uses skip-existing semantics
(`ON CONFLICT (id) DO NOTHING` — a dual-written row is always at least as fresh as the copy).
Idempotent, batched copy jobs:
- v2 comments: `threadId → (entityType, entityId)` via the thread's root chain; `parentId` = the
  thread's `commentId`; `depth`/`rootId` computed by walking `parentThreadId` (one recursive
  pass, offline). Ids and `createdAt`/`updatedAt` preserved; nullable `hidden`/`locked` coalesce to
  false.
- v1 comments: direct copy with `entityType='model'`, `legacyV1Id` set, new ids from the shared
  sequence.
- Topics: one `CommentTopic` per entity-bearing Thread, copying `locked`; `commentCount` recomputed
  by trigger-equivalent count. **The counted set must match today's trigger exactly — all rows,
  including hidden and self-authored** — because `challenge.service.ts` and `getCommentCount` read
  it raw.
- Reactions: `CommentV2Reaction` copies with the same `commentId`; `CommentReaction` maps through
  `legacyV1Id`. Recompute `CommentV3.reactionCount` from the copied rows at the end.
- Reports: `CommentV2Report` copies as-is; `CommentReport` maps through `legacyV1Id`. The `Report`
  rows themselves don't move.
- Skip orphaned-thread comments (unreachable today) and their reactions/reports; log counts.
- Parity checks: per-entity counts vs `Thread.commentCount`, reaction counts vs the two source
  tables, spot checksums.

Once the backfill has converged and parity holds, the cross-surface **readers** move (see the
Phase 4 prerequisite) — still before any write flip.

**Rollback story** (why reads flip before writes): while writes still land in the old tables,
flipping a surface's reads back is instant and lossless — dual-write kept both sides current. Once
a surface's *writes* flip, new rows exist only in CommentV3; rolling that back requires a
reverse-copy (CommentV3 → old tables, trivial since ids are shared) — keep that script ready
before the first write flip, and don't remove a surface's old write path until it has soaked.

**Phase 4 — flip reads, then writes, per surface, behind Flipt.** **Prerequisite — readers move
first:** dual-write makes CommentV3 a complete superset of both old tables, so every cross-surface
reader (notification `prepareQuery`s, the moderator app, creator-studio analytics, metrics jobs,
the daily-challenge judge gate) is re-pointed at CommentV3 during the dual-write window, **before
the first write flip**. Dual-write is one-directional (old → new), so once a surface's writes flip
its new comments exist only in CommentV3 — any reader still on the old tables would silently miss
them. With readers moved first, a write flip strands nothing and the old tables go quietly stale.
Order by risk: bounty/bountyEntry
or article first, image/post (highest volume) mid, **model comments last** (they change system, not
just implementation — the model discussion UI moves onto the unified provider). A surface's flip
includes its reactions and reports: reads of reactions come from `CommentV3Reaction`, and the model
surface's client switches its reaction entityType from `commentOld` to `comment` (its comment ids
are new ids from that point). After each surface's reads and writes are flipped and stable, its old
write path is removed; `commentOld` is removed once the model surface is flipped.

Per-surface cutover checklist additions from the residue sweep:
- **article/post flips**: explicitly purge `articleStatCache` / `postStatCache`
  (`src/server/redis/caches.ts` ~1492-1585) after any comment-count recompute — both are 24h-TTL
  caches over the metric tables and would serve stale counts for a day otherwise.
- **image flip**: `EntityMetric` rows with `metricType='Comment'` (surfaced by the
  `EntityMetricImage` view) are written on comment create/delete — re-point that writer with the
  image surface.
- **comicChapter flip**: `ChapterComments.tsx` bypasses the comment providers and passes
  `parentThreadId` in its mutation input — the comics client changes shape with its surface flip,
  unlike every provider-based surface.

**Phase 5 — downstream re-point.** Ordering note: the **read-only** consumers in this phase
(notification queries, moderator app reads, creator-studio, metrics jobs, the challenge gate) move
once the Phase 3 backfill converges, *before* the first Phase 4 write flip — see the Phase 4
prerequisite. What lands after the flips is the cleanup that requires old write paths to be gone
(enum/endpoint collapses, `commentOld` removal, handler retirement). Notifications and the
moderator app are the two largest consumers and get their own sections below. The rest:
- event-engine: one CDC handler on `CommentV3` replaces `comments.ts` + `comment-v2.ts`; owner
  resolution becomes one entity lookup instead of the 15-way COALESCE. Kafka table subscriptions
  change — coordinate the handler swap with the write flip per surface, or run both handlers with
  the new one deduping on comment id during the dual-write window.
- Metrics jobs (`article/bounty/post/model3d.metrics.ts`): count from CommentV3.
  Preserve `ModelMetric.commentCount` = **distinct commenters** semantics. `question/answer.metrics.ts`
  retire with that surface.
- Creator-studio analytics (`analytics.ts` all-time tile + per-image series): single-table query;
  model comments become visible there for the first time (feature win, note it in release comms).
- Unify exclusion logic (`boundExcludedUserIds` + hidden/blocked handling) into one shared helper —
  today it's duplicated between v1 and v2 with subtle drift.
- Cron jobs touching the tables directly (beyond the metrics jobs above):
  - `src/server/jobs/entity-moderation.ts` — auto-mute cleanup treats `Comment` and `CommentV2` as
    separate entity types with separate selectors and `updateMany` hide branches. Collapses to one
    `CommentV3` branch; during Phases 2–4 it must hide in **both** old and new tables (a
    moderation hide applied only to the non-authoritative side would silently unhide on flip).
  - `src/server/jobs/daily-challenge-processing.ts` — the judge's "already reviewed" gate is a raw
    `Thread JOIN CommentV2 WHERE th."imageId" = ... AND cm."userId" = judge` in two places; becomes
    a single `WHERE entityType='image' AND entityId=... AND userId=...` lookup (add a covering
    check that `(entityType, entityId, userId)` is answerable from the planned indexes — it is via
    the `(userId, id)` index only for small per-user sets; if slow, extend `(entityType, entityId,
    id)` usage or add `(entityType, entityId, userId)`). Its judge-comment **writes** already go
    through `upsertComment`, so dual-write covers them; `getJudgeCommentForImage` in
    `commentsv2.service.ts` is the matching read to port. Flip these with the `image` surface.
  - `src/server/jobs/job-queue.ts` — `EntityType.Comment`/`CommentV2` mappings are marked
    `// unused`; delete them in Phase 6 rather than porting.
  - `src/server/jobs/update-user-score.ts` — touches comments only via `ArticleMetric.commentCount`
    and ClickHouse `entityMetricEvents` (`metricType='commentCount'`), both downstream of the
    metrics/CDC work above; no direct change, but its inputs must not gap during the CDC handler
    swap — include comment-count continuity in the Phase 5 event-engine verification.
- Reaction/report consumers: `reaction.service.ts` drops the `commentOld` branch;
  `goodContent.reward.ts`'s `typeToTable` and the buzz-tip labels in `src/utils/buzz.ts` collapse to
  one mapping; `ReportEntity.Comment`/`ReportEntity.CommentV2` collapse to one value in
  `report-helpers.ts` + `report.service.ts` (accept both from clients for one release), and
  `ReportModal.tsx` lists one comment entity. The reaction entity enum
  (`src/server/schema/reaction.schema.ts` — contains both `'comment'` and `'commentOld'`) and its
  twin switch in `reaction.controller.ts` (which also emits `Comment_*` vs `CommentV2_*` ClickHouse
  events) collapse too; keep both input values accepted for a release since it's a breaking tRPC
  input change, and note ClickHouse history keeps the old event-type literals forever — readers
  (`apps/creator-studio/src/lib/server/analytics.ts:329`, `analytics-detail.ts`) must match old
  literals alongside `CommentV3_*`. Client twin: the `commentOld` key in
  `src/components/Reaction/Reactions.tsx`.
- Raw-SQL stragglers found in the full sweep, each a contained rewrite:
  `src/server/services/resourceReview.service.ts` (**owns** its Thread — creates one eagerly on
  review create and reads `thread.commentCount` through `resourceReview.selector.ts` into
  `ResourceReviewCard`/`ResourceReviewDetail`; replace with lazy `CommentTopic` + `COALESCE(0)`,
  a client-visible shape change), `src/server/services/collection.service.ts` (~2662,
  Thread-join count), `src/server/metrics/post.metrics-old.ts` (live sibling of `post.metrics.ts`
  — migrate or delete), `src/pages/api/mod/daily-challenge/re-review.ts`,
  `src/server/notifications/report.notifications.ts` (CASE over both report join tables), and the
  Q&A thread `_count` reads in `answer.controller.ts`/`question.controller.ts` (retire with the
  surface, decision 1).
- Entity-label/URL maps: `src/utils/string-helpers.ts` (`commentV2`/`CommentV2` → 'Comment'
  entries), `src/pages/moderator/strikes.tsx` entity→URL map, and
  `src/server/utils/moderator-endpoint-catalog.generated.ts` (regenerate). The
  `src/pages/comments/v2/[id].tsx` permalink redirect keeps working because v2 ids are preserved —
  just re-point its query; moderator tooling and strike links depend on that route.
- Moderator app extras beyond the section above: `queue-thresholds.ts` (`commentV2` threshold key
  and `report:commentV2` mapping — renaming the key silently zeroes thresholds),
  `src/lib/reports.ts` label maps. The moderator **database** (tracked schema
  `apps/moderator/prisma/schema.prisma`) has sibling `Comment Int?`/`CommentV2 Int?` columns on
  `ModerationQueueMetrics` — populated by an external Retool-era job, nothing in the monorepo
  writes them, so collapsing them is a moderator-DB DDL change coordinated with whoever owns that
  job; low priority, tail-end of Phase 5.
- Tooling: `scripts/local-dev/gen_seed.ts` hand-builds Thread/CommentV2 rows — rewrite with the
  new tables or local dev seeding breaks; `scripts/metric-migration/metric-backfill-config.ts` is
  the comment-count backfill tool (beware its line-96 `chMetricType: 'Comment'` vs `'commentCount'`
  inconsistency).
- Search indexes (`images`/`metrics-images`/`models`/`articles`/`bounties`) only consume
  denormalized `commentCount` metrics, never the tables — safe as long as the metric feeds don't
  gap; if a count source changes discontinuously, schedule a full reindex rather than incremental.

### Notifications impact (Phase 5 detail)

`src/server/notifications/comment.notifications.ts` defines ~16 notification types. On the current
schema they fall into three shapes; all three simplify:

- **Pure-v1** (`new-comment`, `new-comment-response`, `new-comment-nested`, plus the `"Comment"`
  join in `reaction.notifications.ts`): move from `"Comment"` + `parentId` self-joins to
  `CommentV3 WHERE entityType = 'model'`. The permalink they emit
  (`?dialog=commentThread&highlight=<id>`) must carry the **new** id — the client dialog reads it
  against the live table, so nothing else changes.
- **Per-entity v2** (`new-image-comment`, `new-post-comment`, `new-article-comment`,
  `new-bounty-comment`, `new-bounty-entry-comment`, `new-challenge-comment`,
  `new-app-listing-comment`, `new-review-response`, the three `model3d` types, `new-comment-reply`):
  each is today a `CommentV2 → Thread` join on one entity FK (reply variants double-join through the
  child thread's `commentId`). All become `WHERE entityType = X AND parentId IS [NOT] NULL` on one
  table — near-mechanical rewrites, and candidates for one parameterized query builder instead of a
  dozen near-copies.
- **Both-table UNIONs** (`new-thread-response` here, and `mention.notifications.ts`): the UNION
  disappears; thread-participant fanout becomes `ARRAY_AGG(userId) ... WHERE parentId = c.parentId`
  (siblings) instead of one arm each for `parentId` (v1) and `threadId` (v2).

Two things must hold through the transition:
- **Historical rows are forever.** `Notification.details` carries `version: 2` (absent = v1) and old
  comment ids. `comment.detail-fetcher.ts` keeps its split permanently: `version === 2` resolves by
  id directly (ids preserved), otherwise via `legacyV1Id`. New notifications write `version: 3` with
  new ids so the fetcher stays unambiguous.
- **Cutover alignment.** Notification `prepareQuery`s run off `lastSent` windows against whichever
  table they query. Because CommentV3 is complete during dual-write, the simple safe order is:
  rewrite **all** notification queries against CommentV3 once, during the dual-write window, before
  any surface's write flip. No per-surface flag coupling needed — a query on CommentV3 sees every
  comment regardless of which side wrote it. The only forbidden state is a query still on an old
  table after that surface's writes flipped.

Also fix in passing: `reaction.notifications.ts` links `?dialog=commentThread&commentId=<rootId>` —
verify the root-resolution logic against `rootId` on the new row (it currently self-joins to find
the v1 root).

### Moderator app impact (Phase 5 detail)

`apps/moderator` (Kysely, direct DB) has the v1/v2 split baked into six modules; consolidation
deletes about half of each:

- `user-account.service.ts`: `getComments()` (v1) and `getCommentsV2()` (v2, hand-built
  `coalesce` over `THREAD_TARGETS` that **omits** challenge/comicChapter/model3d/appListing — those
  render with a null entity today) merge into one query reading `entityType`/`entityId` off the row.
  The merge fixes the missing-entity bug for free; keep the surfaces list exhaustive via the enum.
- `user-lookup.service.ts`: `COUNT_SOURCES` collapses "Model comments" + "Image comments" into one
  CommentV3 count (optionally grouped by entityType); `getCommentFlags()` extends from v1-only to
  all comments — a **behavior change to flag to the mod team**, since flag counts will rise.
- `user-signals.service.ts::getCommentBurst`: two-table sum becomes one count.
- `reports.service.ts::commentContextUrl`: the 10-branch Thread-FK `CASE` + `rootThreadId` fallback
  becomes a single `entityType` switch on the row.
- `report-entities.ts`: the two `{ reportTable, table }` entries collapse to one
  `{ 'CommentV3Report', 'CommentV3' }` entry once the report backfill lands (Phase 3 maps
  `CommentReport` rows through `legacyV1Id`, so no legacy-id handling survives here).
- `entity-url.ts` + `retool/user-lookup/CommentsPanel.svelte`: `modelCommentUrl()`/`commentV2Url()`
  collapse to one builder; the "Model comments"/"Other comments" panels and the separate
  `commentIds`/`commentV2Ids` checkbox groups become one list. The backing mod endpoints
  (`src/pages/api/mod/comment/bulk-delete.ts`, `remove-as-tos.ts`) accept a single `commentIds`
  list; keep the old dual-list shape as an accepted alias for one release so the moderator app and
  main app can deploy independently.

Sequencing: the moderator app's read rewrite lands **during the dual-write window, before the
first write flip** (CommentV3 is complete then, and dual-write is one-directional — waiting until
after flips would leave mod tooling blind to new comments on flipped surfaces). Its old-table code
paths are deleted with Phase 6. Pre-existing dead link to note while in there:
`src/pages/moderator/strikes.tsx` links v1 comments to `/comments/<id>`, a route that doesn't exist.

**Phase 6 — contract.** Drop `Thread` (and its 15 FK columns' reverse relations), `Comment`,
`CommentV2`, `CommentReaction`, `CommentV2Reaction`, `CommentReport`, `CommentV2Report`; drop the
triggers `update_thread_comment_count`, `trg_moderation_comment`/`trg_moderation_commentv2`, and
`comment_reaction_count_update`. Drop order: reaction/report join tables first (they FK-reference
the comment tables), then `Comment`/`CommentV2`, then `Thread`. Also:
- Remove the two `Thread` entries (`missing-foreign-key|Thread|imageId/challengeId`) from
  `schema-drift/drift-baseline.json` and update the remediation plan + its
  `production-plan.test.ts`, or the drift gate fails on a table that no longer exists.
- **Leave the `Comment`/`CommentV2` values in the `EntityType` pg enum permanently.** Removing a pg
  enum value requires a type rewrite across every column using it, and historical `UserStrike`,
  `Appeal`, `JobQueue`, `EntityCollaborator`, and `ModerationRule` rows carry those values. Instead:
  new rows write `CommentV3`, and readers alias old values (`CommentV2` → id-direct, `Comment` →
  via `legacyV1Id`). Same policy for persisted strings elsewhere (notification `details.version`,
  ClickHouse event types, moderation queue keys).

### What we get to delete

`Thread` entirely; the recursive CTE in `getReplyThreads`; the dynamic
`as unknown as Prisma.ThreadWhereUniqueInput` casts (5 sites); the 15-column COALESCE chain (9
sites); the v1/v2 UNIONs in notifications; one CDC handler; the duplicate reaction and report join
tables (four tables become two); the `commentOld` reaction type and one `ReportEntity` value; the `{ commentIds, commentV2Ids }` dual-id API shape; the duplicated exclusion logic; the
per-page reply-count `GROUP BY`.

### Explicitly not migrated

- `clubPost` threads — clubs are dead code; rows (if any) are left behind and dropped with Thread.
- `question`/`answer` — decided (decision 1): not migrated; rows drop with Thread, and
  `QuestionAnswerComments.tsx` + `question/answer.metrics.ts` retire alongside.
- Comments attached to orphaned Threads (all entity FKs null) — unreachable today.

## Sweep coverage (2026-08-24)

Two thorough residue sweeps (DB-level and app-level) ran over the whole workspace. Everything they
found is folded into the phases above. Categories checked and **verified empty** — so future
readers don't re-sweep them: CSAM services, mod-activity logging, chat, webhooks, email templates,
RSS/sitemaps, `api/testing/*` debug endpoints, signals, notification-cache, feature flags,
Prisma-mapped views (all `commentCount*` view fields source from `*Metric` tables),
`prisma/programmability/`, `@no-type` slim-schema handling, `packages/civitai-db-queries`,
`packages/civitai-db`, and the `apps/notifications`/`auth`/`orchestrator-gateway`/`storage` apps.
The string-typed `entityType` tables (`BuzzTip`, `ModActivity`, `File`, `Link`, `EntityAccess`,
etc.) have no code writing comment values into them today. One deliberate non-match:
`StickerSurface = 'chat' | 'comment'` in `src/shared/utils/sticker-token.ts` is a UI-surface union,
not a table reference — leave it alone in any rename sweep. Likewise the root
`prisma/schema.prisma` (gitignored, stale by ~1,500 lines vs the generated one in
`packages/civitai-db-schema/prisma/`) still contains `Comment`/`CommentV2`/`Thread` definitions —
it is a leftover build artifact, not residue; don't chase or edit it.

**Test blast radius**: ~20 unit/integration files hardcode CommentV2/Thread shapes (services,
notifications, permalink, controllers, event-engine handler tests) — mostly mechanical mock-shape
rewrites. Three need judgment, not find-and-replace: the two moderator SQL-assertion tests
(`reports.sql.test.ts`, `reports.queries.explain.test.ts` assert exact SQL text and query plans)
and `schema-drift/.../production-plan.test.ts`. One E2E gate: `tests/preview-engagement.spec.ts`
drives `commentv2.upsert`/`delete` end-to-end and keeps working as long as the tRPC contract stays
(the plan keeps it).
