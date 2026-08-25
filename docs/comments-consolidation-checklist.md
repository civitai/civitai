# Comments Consolidation — Execution Checklist

Working checklist for [comments-consolidation.md](comments-consolidation.md) — that doc holds the
rationale and detail; this one is the order of operations. Check items off as they land; each phase
ends with a **gate** that must be true before the next phase starts.

**Open decision (blocks Phase 1 schema finalization):** deletion semantics — soft-delete tombstone
when `childCount > 0` vs hard cascade. See "Deletion semantics" in the plan doc.

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

Decisions & prerequisites:

- [ ] Deletion semantics decided (recommendation: tombstone when `childCount > 0`)
- [ ] `ComicChapter` integer surrogate id added (pattern: `AppListing.serialId`) + migration applied
- [ ] Flip order confirmed from volume data (default: bounty/article → review/challenge/misc →
      image/post → comicChapter → model last)

**Gate:** all measurements recorded in the plan doc; deletion decision written down.

## Phase 1 — Schema (expand)

- [ ] `CommentV3`, `CommentTopic`, `CommentV3Reaction`, `CommentV3Report` in `schema.full.prisma`
      (+ `deletedAt` if tombstone decision)
- [ ] Indexes from the plan doc (top-level ×2 sorts — NOT filtered on hidden, pinned partial,
      `(parentId, id)`, `(rootId, depth, id)`, `(userId, id)`; add `"deletedAt" IS NULL` to the
      top-level partials if tombstoning)
- [ ] `CHECK (depth <= 20)`
- [ ] Shared sequence: seed past `max(CommentV2.id, Comment.id)`, re-point `Comment` and
      `CommentV2` id defaults at it
- [ ] Triggers: `childCount` maintenance, `CommentTopic.commentCount` (counted set = ALL rows incl.
      hidden/self, matching today's `update_thread_comment_count`), reaction-count port of
      `update_comment_reaction_count`
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
      `commentId`; `depth`/`rootId` from one offline recursive pass; ids + timestamps
      preserved; nullable `hidden`/`locked` → false; idempotent + batched + resumable
- [ ] v1 comment copy job: `entityType='model'`, `legacyV1Id` set, ids from shared sequence
- [ ] Topic copy: one `CommentTopic` per entity-bearing Thread (locked carried, count recomputed)
- [ ] Reaction copy: `CommentV2Reaction` as-is, `CommentReaction` via `legacyV1Id`;
      `reactionCount` recomputed at end
- [ ] Report copy: `CommentV2Report` as-is, `CommentReport` via `legacyV1Id`
- [ ] Orphaned-thread comments (and their reactions/reports) skipped, counts logged
- [ ] Parity checks: per-entity counts vs `Thread.commentCount`, reaction counts vs both source
      tables, spot checksums
- [ ] Continuous parity monitor (row-count diff old vs new per day) running
- [ ] Reverse-copy script (CommentV3 → old tables, id-matched) written and tested — the Phase 4
      write-flip rollback tool

Re-point cross-surface **readers** at CommentV3 while dual-write keeps it complete (dual-write is
one-directional, so any reader left on the old tables goes blind the moment a surface's writes
flip — these MUST land before the first Phase 4 write flip):

- [ ] All notification `prepareQuery`s (pure-v1 types, per-entity v2 types, the UNIONs in
      `new-thread-response` + `mention.notifications.ts`, `reaction.notifications.ts`,
      `report.notifications.ts`) — new notifications write `details.version: 3`
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
      pinned order, deep-links/`targetCommentId`, reply pagination)
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
- [ ] Consolidate the per-entity notification queries into one parameterized builder (optional
      cleanup, now that all read CommentV3)

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

- [ ] Drop order: `CommentReaction`/`CommentV2Reaction`/`CommentReport`/`CommentV2Report` →
      `Comment`/`CommentV2` → `Thread`
- [ ] Drop triggers: `update_thread_comment_count`, `trg_moderation_comment`,
      `trg_moderation_commentv2`, `comment_reaction_count_update`
- [ ] Remove Thread entries from `schema-drift/drift-baseline.json` + update remediation plan and
      `production-plan.test.ts`
- [ ] `EntityType` values `Comment`/`CommentV2` **left in place** (read-time aliases only)
- [ ] `job-queue.ts` unused mappings deleted; schema reverse-relations cleaned;
      `db:generate` + `db:check-generated` clean
- [ ] Plan doc + this checklist marked complete; `docs-drift-review` over the final diff

**Gate:** prod schema contains no old comment tables; drift gate green; full unit suite green.
