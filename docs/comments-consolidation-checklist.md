# Comments Consolidation — Execution Checklist

Working checklist for [comments-consolidation.md](comments-consolidation.md) — that doc holds the
rationale and detail; this one is the order of operations. Check items off as they land; each phase
ends with a **gate** that must be true before the next phase starts.

Schema is the **merged design** (2026-08-25, Koen's counter-proposal + adjustments): ltree `path`
set by a `BEFORE INSERT` trigger with `rootId`/`depth` GENERATED from it, `replyToId`, tombstone
deletion (`deletedAt` + `parentId ON DELETE RESTRICT`), comments FK'd to `CommentTopic`. Deletion
semantics are **decided** (D6): tombstone with replies, hard-delete childless. Per-thread
notification mute is **in scope** (D7, added 2026-09-01 after PR #4524 shipped it for CommentsV2).

## Phase 0 — Measure & decide

Prod measurements (read-only replica):

- [ ] Row counts: `Comment`, `CommentV2`, `Thread`, `CommentReaction`, `CommentV2Reaction`,
      `CommentReport`, `CommentV2Report`
- [ ] v1 depth distribution — count of `Comment` rows whose parent also has a parent (believed 0
      reachable; decides whether v1 backfill needs depth handling at all)
- [ ] Orphaned `Thread` count (all entity FKs null) and orphan comments under them
- [ ] `Thread` rows pointing at deleted images/challenges (the missing-FK drift)
- [ ] Per-entityType comment volume (drives flip order and index sizing)
- [ ] `Thread` rows for dead surfaces: `clubPostId`, `questionId`, `answerId`
- [ ] Verify `Thread.modelId` / `challengeId` / `model3dId` are truly 1:1 (schema declares
      `@unique`, back-relations are lists)
- [ ] CommentV2 id growth rate (sanity input for the shared-sequence approach)
- [ ] Dead-column check: `CommentV2.metadata IS NOT NULL` count and `nsfw = true` counts on both
      tables — if ~0, `nsfw`/`metadata` stay out of the new schema
- [ ] EXPLAIN the capped per-parent reply-count `GROUP BY` at prod scale (replaces stored
      `childCount`; must be index-only on `(parentId, hidden, …)`)
- [ ] Infra sign-off: `CREATE EXTENSION ltree` on prod
- [ ] `ThreadMute` row count + how many map to comment / section / orphaned threads (PR #4524 is
      dev-only today, so this may be ~0 in prod — confirm rather than assume)

Decisions & prerequisites:

- [x] Deletion semantics decided — D6: tombstone with replies, hard-delete childless (2026-08-25)
- [ ] `ComicChapter` integer surrogate id added (pattern: `AppListing.serialId`) + migration applied
- [ ] Flip order confirmed from volume data (default: bounty/article → review/challenge/misc →
      image/post → comicChapter → model last)
- [x] Mute table naming decided (2026-09-01): `CommentMute` + `CommentTopicMute`, not the
      `*Engagement` + type-enum convention — a `Follow` state is speculative and a second table
      later costs what the enum costs now

**Gate:** all measurements recorded in the plan doc; deletion decision written down.

## Phase 1 — Schema (expand)

- [ ] `CREATE EXTENSION ltree` applied to prod (signed off in Phase 0)
- [ ] DDL from the plan doc: `CommentV3` (ltree `path`, generated `rootId`/`depth`, `replyToId`,
      `deletedAt`, FK to `CommentTopic`, `parentId ON DELETE RESTRICT`, CHECKs), `CommentTopic`,
      `CommentV3Reaction`, `CommentV3Report`
- [ ] `CommentMute` (`@@id([userId, commentId])`, FK to `CommentV3` CASCADE, `@@index([commentId])`)
      and `CommentTopicMute` (`@@id([userId, entityType, entityId])`) — two tables, because a
      nullable PK column is illegal in Postgres
- [ ] `commentv3_set_path` BEFORE INSERT trigger
- [ ] Index set from the plan doc (top ×3, entity, replies ×2 with `hidden` second,
      `(rootId, depth)`, GiST `path`, `(userId, id DESC)`, `legacyV1Id` unique partial)
- [ ] Shared sequence `comment_shared_id_seq`: seed past `max(CommentV2.id, Comment.id)`, re-point
      `Comment` and `CommentV2` id defaults at it
- [ ] Triggers: `CommentTopic.commentCount` (counted set = ALL rows incl. hidden/self, matching
      today's `update_thread_comment_count`), reaction-count port of
      `update_comment_reaction_count`
- [ ] Prisma shape: `path` as `Unsupported("ltree")`, `rootId`/`depth` as `dbgenerated`;
      `db:check-generated` clean with it
- [ ] Clavata trigger `trg_moderation_commentv3` + `EntityType` enum value `CommentV3`
      (**deploy regenerated client first**, then apply enum migration — expand/contract rule)
- [ ] `entity-moderation.ts` consumes the `CommentV3` JobQueue entity type
- [ ] `packages/civitai-db-schema/src/kysely/updated-at-tables.ts` gains the new tables
- [ ] `pnpm run db:generate` + `pnpm run db:check-generated` clean
- [ ] Migration SQL written, committed, **applied manually** (never `prisma migrate deploy`)

**Gate:** new tables live and empty in prod; client deployed knowing all new types.

## Phase 2 — Dual-write (deploy to production first)

Comments AND reactions/reports — everything dual-writes before any backfill runs:

- [ ] `commentsv2.service` upsert/delete/hide/pin/lock dual-write CommentV3 in-transaction
- [ ] `comment.service` (v1) upsert/delete/hide/pin/lock dual-write (via `legacyV1Id` resolution)
- [ ] `toggleLockCommentsThread` sets `Thread.locked` + `CommentTopic.locked` together
- [ ] `reaction.service.ts` (`comment` + `commentOld`) dual-writes `CommentV3Reaction`
- [ ] Report creation dual-writes `CommentV3Report`
- [ ] `toggleThreadMute` → `CommentMute`, `toggleSectionMute` → `CommentTopicMute` (both v2 controls
      from PR #4524; the section control gains the ability to mute a comment-less entity)
- [ ] `user.service.ts` account deletion deletes from the new tables too
- [ ] `entity-moderation.ts` auto-mute hides in both old and new tables
- [ ] CDC provisioned **before** enabling: `public.CommentV3` in event-engine table subscriptions +
      `postgres.CommentV3` Kafka topic created (dedupe against old handlers during overlap)
- [ ] Deployed to production; new comments/reactions/reports visibly landing in both sides, zero
      write-path errors

**Gate:** every comment/reaction/report write path in prod dual-writes; the live edge of CommentV3
is being maintained.

## Phase 3 — Backfill & reader re-point

Runs under live dual-write, so every copy job uses skip-existing semantics
(`ON CONFLICT (id) DO NOTHING` — a dual-written row is always at least as fresh as the copy):

- [ ] v2 comment copy job: `threadId → (entityType, entityId)` via root chain; `parentId` = thread's
      `commentId`; **inserted in depth order** so the path trigger finds each parent (`rootId`/
      `depth` are generated, not computed); ids + timestamps preserved; nullable
      `hidden`/`locked` → false; `replyToId` null; idempotent + batched + resumable
- [ ] v1 comment copy job: `entityType='model'`, `legacyV1Id` set, ids from shared sequence
- [ ] Topic copy: one `CommentTopic` per entity-bearing Thread (locked carried, count recomputed)
- [ ] Reaction copy: `CommentV2Reaction` as-is, `CommentReaction` via `legacyV1Id`;
      `reactionCount` recomputed at end
- [ ] Report copy: `CommentV2Report` as-is, `CommentReport` via `legacyV1Id`
- [ ] Mute copy: `ThreadMute` splits. Thread with `commentId` → `CommentMute` on that comment's id
      (v2 ids preserved; note the off-by-one — v2 mutes the comment's CHILD thread); entity-bearing
      thread with no `commentId` → `CommentTopicMute`; orphaned → skipped and counted
- [ ] Orphaned-thread comments (and their reactions/reports) skipped, counts logged
- [ ] Parity checks: per-entity counts vs `Thread.commentCount`, reaction counts vs both source
      tables, spot checksums, `ThreadMute` count vs `CommentMute` + `CommentTopicMute` + skipped
- [ ] Continuous parity monitor (row-count diff old vs new per day) running
- [ ] Reverse-copy script (CommentV3 → old tables, id-matched) written and tested — the Phase 4
      write-flip rollback tool

Re-point cross-surface **readers** at CommentV3 while dual-write keeps it complete (dual-write is
one-directional, so any reader left on the old tables goes blind the moment a surface's writes
flip — these MUST land before the first Phase 4 write flip):

- [ ] All notification `prepareQuery`s (pure-v1 types, per-entity v2 types, the UNIONs in
      `new-thread-response` + `mention.notifications.ts`, `reaction.notifications.ts`,
      `report.notifications.ts`) — new notifications write `details.version: 3`
- [ ] 🔴 The rewrite CARRIES the mute filter to all **13** `notThreadMuted` sites: `notThreadMuted`
      becomes a `CommentTopicMute` PK probe plus a `CommentMute` join on `path @>`, and
      `thread-chain.ts` is deleted. Dropping it reads as a clean diff and silently un-mutes everyone
- [ ] `no-unmuteable-comment-processor` re-pointed at the v3 SQL **in the same commit** — including
      the deliberate `new-mention` exclusion it pins. Verify it FAILS on a removed filter, not just
      that it passes
- [ ] `getThreadMuted` / `getSectionMuted` read the same v3 predicate as the suppression (one shared
      helper, as `muteableThreadsCte` is today) so the menu label cannot diverge from behavior
- [ ] Moderator app reads: `user-account.service.ts`, `user-lookup.service.ts`,
      `user-signals.service.ts`, `reports.service.ts::commentContextUrl`, `CommentsPanel.svelte`
- [ ] Creator-studio analytics (`analytics.ts`, `analytics-detail.ts`)
- [ ] Metrics jobs (`article/bounty/post/model3d.metrics.ts`; delete or port `post.metrics-old.ts`)
- [ ] `daily-challenge-processing.ts` judge gate + `getJudgeCommentForImage`;
      `api/mod/daily-challenge/re-review.ts`
- [ ] `collection.service.ts` Thread-join count; `resourceReview` `thread.commentCount` reads →
      `CommentTopic`
- [ ] `/comments/v2/[id].tsx` permalink query

**Gate:** backfill converged; N days of zero parity drift; no cross-surface reader still queries
the old tables; reverse-copy proven on a sample.

## Phase 4 — Per-surface flips (behind Flipt)

Repeat this block per surface, in the Phase 0 order (model **last**):

- [ ] Read flip on → soak → verify (comments render, counts match, hidden/blocked exclusions hold,
      pinned order, deep-links/`targetCommentId`, reply pagination, mute menu state matches whether
      notifications actually arrive)
- [ ] Reactions read from `CommentV3Reaction`
- [ ] Write flip on → soak → old write path removed for this surface

Surface-specific extras:

- [ ] **article/post**: purge `articleStatCache` / `postStatCache` after count recompute
- [ ] **image**: re-point the `EntityMetric` (`metricType='Comment'`) writer; flip
      `daily-challenge-processing.ts` judge gate + `getJudgeCommentForImage` with it
- [ ] **comicChapter**: `ChapterComments.tsx` client shape change (drops `parentThreadId`)
- [ ] **model** (last): model discussion UI moves onto the unified provider (display depth 1, same
      presentation); client reaction entityType `commentOld` → `comment`; v1 replica-lag pinning
      (`getDbWithoutLag('commentModel')`) retired or ported
- [ ] `commentOld` reaction type removed after model flip soaks

**Gate:** every surface reading+writing CommentV3; old tables receiving no new rows.

## Phase 5 — Post-flip cleanup

(The read-side re-points that used to live here run in Phase 3 — see above. What remains requires
old write paths to be gone.)

Notifications:

- [ ] `comment.detail-fetcher.ts` resolves v3 by id / v2 by id / v1 via `legacyV1Id`
      (permanent shim) — verify against real historical notification rows
- [ ] Consolidate the per-entity notification queries into one parameterized builder — **no longer
      optional**: one builder is one place the mute filter can go missing, instead of 13

Event-engine / metrics:

- [ ] One CDC handler on CommentV3 replaces `comments.ts` + `comment-v2.ts`; old handlers retired
- [ ] `ModelMetric.commentCount` stays **distinct commenters** — verify post-cutover
- [ ] Comment-count event continuity verified (feeds `update-user-score.ts`, search indexes,
      stat caches); full search reindex only if a count source moved discontinuously
- [ ] ClickHouse tracking sends explicit entityType + comment id; readers match old
      `Comment_*`/`CommentV2_*` literals alongside `CommentV3_*`
      (`creator-studio/analytics.ts`, `analytics-detail.ts`)

Main app cleanup:

- [ ] Unified exclusion helper (hidden/blocked/blockedBy + owner exemption) replaces the v1/v2 copies
- [ ] Reaction enum/controller collapse (`'commentOld'` accepted one extra release)
- [ ] `ReportEntity` collapse (both values accepted one extra release); `ReportModal.tsx`
- [ ] `goodContent.reward.ts` `typeToTable`, `src/utils/buzz.ts` labels,
      `src/utils/string-helpers.ts` entries
- [ ] `resourceReview.service.ts` drops its eager `thread: { create: {} }` on review creation
      (topics are lazy)
- [ ] `strikes.tsx` URL map (+ fix its pre-existing dead `/comments/<id>` link)
- [ ] Mute UI ported: per-comment overflow item + section ellipsis beside the top-level composer
      (`Comment.tsx`, `commentv2.utils.ts`); copy says "thread" — restate for exact subtree semantics
- [ ] `commentv2.router` mute procedures move to the v3 router, keeping the shared
      `commentv2.mute` rate-limit budget
- [ ] Mod endpoints `bulk-delete`/`remove-as-tos` take single `commentIds` (dual-list alias for one
      release); `moderator-endpoint-catalog.generated.ts` regenerated

Moderator app cleanup (reads moved in Phase 3; this is the write/UX side):

- [ ] `report-entities.ts` single `{ 'CommentV3Report', 'CommentV3' }` entry
- [ ] `entity-url.ts` single builder; `CommentsPanel.svelte` single checkbox list
- [ ] `queue-thresholds.ts` key migration (don't zero thresholds); `src/lib/reports.ts` labels
- [ ] Tell mod team: `getCommentFlags()` now covers all comments — flag counts rise; model comments
      appear in creator-studio for the first time
- [ ] Hand-off: moderator-DB `ModerationQueueMetrics.Comment/CommentV2` columns → external job owner

Tooling / tests:

- [ ] `scripts/local-dev/gen_seed.ts` rewritten for new tables
- [ ] ~20 test files' mock shapes updated; SQL-assertion tests (`reports.sql.test.ts`,
      `reports.queries.explain.test.ts`) re-authored; `tests/preview-engagement.spec.ts` green

**Gate:** zero code paths query the old tables (grep proves it); notifications + metrics verified
continuous across the cutover.

## Phase 6 — Contract (teardown)

- [ ] 🔴 **Verify `CommentMute` + `CommentTopicMute` are populated BEFORE dropping `Thread`** —
      `ThreadMute_threadId_fkey` is `ON DELETE CASCADE`, so the teardown deletes every mute a user
      ever set, silently
- [ ] Drop order: `ThreadMute` → `CommentReaction`/`CommentV2Reaction`/`CommentReport`/
      `CommentV2Report` → `Comment`/`CommentV2` → `Thread`
- [ ] Drop triggers: `update_thread_comment_count`, `trg_moderation_comment`,
      `trg_moderation_commentv2`, `comment_reaction_count_update`
- [ ] Remove Thread entries from `schema-drift/drift-baseline.json` + update remediation plan and
      `production-plan.test.ts`
- [ ] `EntityType` values `Comment`/`CommentV2` **left in place** (read-time aliases only)
- [ ] `job-queue.ts` unused mappings deleted; schema reverse-relations cleaned;
      `db:generate` + `db:check-generated` clean
- [ ] Plan doc + this checklist marked complete; `docs-drift-review` over the final diff

**Gate:** prod schema contains no old comment tables; drift gate green; full unit suite green.
