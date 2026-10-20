# Comments Consolidation — Execution Checklist

Working checklist for [comments-consolidation.md](comments-consolidation.md) — that doc holds the
rationale and detail; this one is the order of operations. Check items off as they land; each phase
ends with a **gate** that must be true before the next phase starts.

Schema is the **merged design** (2026-08-25, Koen's counter-proposal + adjustments): ltree `path`
set by a `BEFORE INSERT` trigger with `rootId`/`depth` generated from it, `replyToId`, tombstone
deletion (`deletedAt` + `parentId ON DELETE RESTRICT`), comments FK'd to `CommentTopic`. Deletion
semantics are **decided** (D6): tombstone with replies, hard-delete childless. Per-thread
notification mute is **in scope** (D7, added 2026-09-01 after PR #4524 shipped it for CommentsV2).
The v3 code is **Kysely, not the Prisma client** (D8, 2026-10-19).
The 2026-10-16 viability review (plan doc, top) changed Phase 2 to a trigger mirror and added the
items marked **(review)** below; everything amended since Koen's 2026-08-25 design is listed under
_Changes since 2026-08-25_ in the plan doc.

## Phase 0 — Measure & decide

Prod measurements (read-only replica, taken 2026-10-16 — figures in the plan doc):

- [x] Row counts: `Comment`, `CommentV2`, `Thread`, `CommentReaction`, `CommentV2Reaction`,
      `CommentReport`, `CommentV2Report`
- [x] v1 depth distribution — 3 rows; v1 backfill needs no depth handling
- [x] Orphaned `Thread` count (all entity FKs null) and orphan comments under them — 288K / 233K,
      plus 41K nested threads / 43K comments under them; cause was `ON DELETE SET NULL` on every
      entity FK (~6K comments/month) — stopped by the FK cascade (2026-10-16), stock purged
      (2026-10-19)
- [x] `Thread` rows pointing at deleted images — 0
- [x] Per-entityType comment volume (drives flip order and index sizing)
- [x] `Thread` rows for dead surfaces: `clubPostId` 53, `questionId`/`answerId` 456
- [ ] Verify `Thread.modelId` / `challengeId` / `model3dId` are truly 1:1 (schema declares
      `@unique`, back-relations are lists) — `imageId` verified; the other three not yet
- [ ] CommentV2 id growth rate (sanity input for the shared-sequence approach)
- [x] Dead-column check — `metadata` only holds `{"oldId"}` import markers, `nsfw` true on 12 rows;
      both stay out
- [ ] EXPLAIN the capped per-parent reply-count `GROUP BY` at prod scale (replaces stored
      `childCount`; must be index-only on `(parentId, hidden, …)`) — needs the table to exist
- [x] Infra sign-off: `CREATE EXTENSION ltree` on prod — installed 2026-10-19 (1.3, schema
      `public`, verified on the replica)
- [x] `ThreadMute` row count — 225 in prod (the orphaned ones went with the purge); the comment /
      section split is a Phase 3 parity input
- [x] **(review)** v2 depth distribution — 692 comments deeper than 20, max 247
- [x] **(review)** child threads with null `parentThreadId`/`rootThreadId` — 2

Decisions & prerequisites:

- [x] Deletion semantics decided — D6: tombstone with replies, hard-delete childless (2026-08-25)
- [x] `ComicChapter` integer surrogate id — already exists (`ComicChapter.id`, migration
      `20260304123827`; verified in prod 2026-10-19: every chapter thread resolves to one `id`).
      No migration; comic chapters key on `id` (plan: keying note above _Phase 1_)
- [ ] Flip order confirmed from volume data (default: bounty/article → review/challenge/misc →
      image/post → comicChapter/crucible → model last)
- [x] Mute table naming decided (2026-09-01): `CommentMute` + `CommentTopicMute`, not the
      `*Engagement` + type-enum convention — a `Follow` state is speculative and a second table
      later costs what the enum costs now
- [x] **(review)** Orphaned-thread comments: not migrated, and V3 deletes a topic when its entity
      is hard-deleted (2026-10-16); inventory of referencing rows in the plan doc
- [x] **(review, 2026-10-20)** `CommentTopic` partitioned by `entityType` with one
      `ON DELETE CASCADE` entity FK per partition (Koen's 2026-10-19 proposal) replaces the
      per-entity `AFTER DELETE` triggers; app listings key on `serial_id`, comic chapters on `id`;
      build and verification in Phase 1 below
- [x] **(review)** `parentId ON DELETE RESTRICT` survives a topic cascade deleting a whole reply
      tree in one statement — verified on Postgres 18.6
- [x] **(review)** Cascade cost for the largest article thread (5.4K comments): 144 ms with the
      `replyToId` index, 59 s without — index added to the DDL
- [x] **(review)** Prod purge of the orphans — approved 2026-10-16; migration
      `20261101130000_purge_orphaned_comment_threads` (PR #6313) applied in prod 2026-10-19: the
      replica shows zero orphan roots and zero dead-parent threads; ten `archive` tables hold
      334,004 threads / 281,426 comments / 5,868 reports (kept until Phase 6); procedure in the
      plan under _Orphan purge_
- [x] **(review)** Second orphan class measured: 2,867 reply threads whose parent comment was
      hard-deleted (`Thread.commentId` SET NULL), 3,843 comments — purged 2026-10-19; recurs until
      V3 (`Thread.commentId` stays `SET NULL`), so the backfill skip still matters
- [x] **(review)** Stop the leak now: flip the 16 `Thread` entity relations (17 columns) to
      `ON DELETE CASCADE` (`commentId` stays `SET NULL`; `challengeId` had no FK in prod, so it
      was added after deleting its dangling threads) — PR #6155 merged and migration
      `20261101120000_thread_entity_fk_cascade` applied in prod 2026-10-16; all 18
      `ON DELETE CASCADE` keys on `Thread` (16 entity + `parentThreadId`/`rootThreadId`) validated
- [x] **(review)** Recapture the prod catalog and run `drift:baseline` — done 2026-10-19
      (PR #6323, from main): the 15 Thread `referential-action` entries and
      `missing-foreign-key|Thread|challengeId` dropped out, and the `inFlightThreadCascade`
      carve-out in `production-snapshot.test.ts` went with them
- [x] **(review)** Depth clamp applied retroactively to the 692 over-cap comments: approved
      (2026-10-16)

**Gate:** all measurements recorded in the plan doc; the orphan, depth-clamp, purge and FK-flip
decisions recorded (done 2026-10-16). Still unticked above: the three unmeasured items,
and flip order.

## Phase 1 — Schema (expand)

- [x] `CREATE EXTENSION ltree` applied to prod (2026-10-19, in Phase 0)
- [ ] ltree on dev cnpg, the CI Postgres service (`lint.yml`) and local docker-compose: the
      migration opens with `CREATE EXTENSION IF NOT EXISTS ltree` (a trusted extension, so the
      application role can create it); confirm on the dev apply that the dev role may
- [x] DDL from the plan doc: `CommentV3` (ltree `path`, generated `rootId`/`depth`, `replyToId`,
      `deletedAt`, FK to `CommentTopic`, `parentId ON DELETE RESTRICT`, CHECKs), `CommentTopic`
      (partitioned, see the 2026-10-20 item below), `CommentV3Reaction`, `CommentV3Report`;
      `CommentEntityType` includes `crucible` — migration `20261110120000_comment_v3_schema`
      (2026-10-20) **(review)**
- [x] `CommentMute` (`@@id([userId, commentId])`, FK to `CommentV3` CASCADE, `@@index([commentId])`)
      and `CommentTopicMute` (`@@id([userId, entityType, entityId])`) — two tables, because a
      nullable PK column is illegal in Postgres (same migration)
- [x] `commentv3_set_path` BEFORE INSERT trigger fills `path`; `rootId`/`depth` are
      `GENERATED ALWAYS … STORED NOT NULL` from it, as in Koen's draft (a 2026-10-16 move into the
      trigger was reverted 2026-10-19 — plan blocker 6) **(review)**
- [x] Index set from the plan doc (top ×3 — **Newest leads on `createdAt`, `id` is the tiebreak,
      because v1 rows take new ids (review, 2026-10-19)** — entity, replies ×2 with `hidden` second
      and the newest one on `(createdAt, id)`, `(rootId, depth)`, GiST `path`, `(userId, id DESC)`,
      `legacyV1Id` unique partial,
      **`replyToId` partial — without it every hard-delete scans the table (review, benchmarked)**)
- [x] Shared sequence `comment_shared_id_seq`: seed past `max(CommentV2.id, Comment.id)`, re-point
      `Comment` and `CommentV2` id defaults at it (same migration; the seed runs at apply time)
- [x] Triggers: `CommentTopic.commentCount` (`commentv3_topic_comment_count`; counted set = ALL
      rows incl. hidden/self, matching today's `update_thread_comment_count`; unlike it, the
      decrement clamps at 0), reaction-count port `commentv3_reaction_count`
- [x] **(review, 2026-10-20)** `CommentTopic` is `PARTITION BY LIST ("entityType")`: one partition
      per enum value, each with an `ON DELETE CASCADE` FK to its entity table (`ComicChapter (id)`,
      `app_listings (serial_id)`); the migration loops over the enum and fails on a missing
      mapping (same migration)
- [ ] On the dev apply: re-run the reply-tree cascade from the entity side under
      `parentId RESTRICT`; mirror a comment insert racing an entity delete (the old-side write
      must not fail, and entity delete → `Thread` → mirror delete must not collide with the
      partition cascade in the same statement); confirm `\d "Image"` lists the partition FK
- [x] Schema declaration for type generation (D8: no Prisma delegate touches v3): `path` as
      `Unsupported("ltree") @default(dbgenerated())`, `rootId`/`depth` `Int @default(dbgenerated())`;
      `CommentTopic` declared once (`@@id([entityId, entityType])`), not per partition. prisma-kysely
      2.3 drops Unsupported columns outright, so `src/server/db/kyselyDb.ts` exports
      `kyselyV3Read`/`kyselyV3Write` (`withTables`) that add `path` as select-only `string` and
      narrow `rootId`/`depth` to select-only; the shared clients keep the generated `DB` that the
      `@civitai/db-queries` signatures are typed against **(review)**
- [ ] **(moved to Phase 2)** Clavata trigger `trg_moderation_commentv3` + `EntityType` enum value
      `CommentV3`: its own migration, shipped with the Phase 2 consumer below so `main` never holds
      a migration prod does not have (the Phase 1 copy was pulled back out, 2026-10-20). The
      Phase 1 client already knows the enum value, so the deploy-before-apply order holds. Apply
      only if comments have not yet cut over to text-scan (`text-scan/clavata-cutover.ts`), and
      after the Phase 3 backfill or with the trigger disabled while it runs; record the cutover
      answer here
- [ ] **(moved to Phase 2)** `entity-moderation.ts` consumes the `CommentV3` JobQueue entity type:
      its flagged path files a `Report` through `ReportEntity`, so it needs the v3 report plumbing
      and a Kysely-backed selector (no Prisma delegate, D8). The scam auto-mute cleanup for v3
      comments and the CommentV3 cases in `csam-hold-decision.ts` and `scam.adapter.ts` wait for
      the Phase 2 service too
- [ ] **(moved to Phase 2)** text-scan: `CommentV3` profile + entity type in `text-scan/mode.ts`,
      `types.ts`, `retention.ts`, a `clavata-cutover.ts` target, `SCAM_ENTITY_TYPES` with a v3
      cleanup, and the `csam-hold-decision.ts` removal case. Ships with the v3 service: an entity
      type with a profile but no adapter records a scam verdict as acted on and acts on nothing
      (2026-10-20 review) **(review)**
- [ ] verdict/retention ledgers alias old `Comment` ids via `legacyV1Id` (Phase 3, with the v1 copy)
- [x] `packages/civitai-db-schema/src/kysely/updated-at-tables.ts` gains the new tables — under
      D8 this is the only thing that maintains `updatedAt` on them (generated)
- [x] `pnpm run db:generate` clean (2026-10-20)
- [x] `pnpm run db:check-generated` clean on the PR (#6448). `db:moderator:pull` introspects the
      separate moderator database (`MODERATOR_DATABASE_URL`), so the partition children never
      reach it
- [x] Migration SQL `20261110120000_comment_v3_schema` merged (#6448) and **applied manually** to
      prod 2026-10-20; the replica shows the 13 partitions with their cascade FKs, the shared
      sequence as the id default on all three comment tables, the three triggers and every index.
      `comment_shared_id_seq` was created under the default ACL, so the roles the old
      `Comment_id_seq`/`CommentV2_id_seq` granted beyond the owner and app writer need granting by
      hand (SQL given 2026-10-20)

**Gate:** new tables live and empty in prod; client deployed knowing all new types.

## Phase 2 — Dual-write (deploy to production first)

Comments AND reactions/reports — everything mirrors before any backfill runs. The mirror is
**database triggers on the old tables**, not service code (review, blockers 1–3): cascades and
the raw-SQL writers never reach the services, a one-for-one delete mirror would trip
`parentId ON DELETE RESTRICT`, and an app-level copy leaves a read-then-insert window for the
backfill to race.

- [ ] `AFTER INSERT/UPDATE/DELETE` mirror triggers on `Comment` (via `legacyV1Id`; a new v1 row
      keeps its id as the V3 id, `legacyV1Id` = that id) and `CommentV2`:
      insert copies any missing ancestor chain first (`Thread.commentId → CommentV2.threadId`);
      delete applies D6 (tombstone if the v3 row has children, else hard-delete)
- [ ] `commentv3_thread_entity(thread)` SQL function — one `Thread` → `(entityType, entityId)`
      resolver shared by the mirror triggers and the backfill; the `comicChapter` branch joins
      `ComicChapter` on `(projectId, position)` and returns its `id`; the `appListing` branch
      returns `Thread.appListingId` (= `app_listings.serial_id`, not the text ULID `id`)
- [ ] Mirror triggers on `CommentReaction`/`CommentV2Reaction` → `CommentV3Reaction`,
      `CommentReport`/`CommentV2Report` → `CommentV3Report`, `ThreadMute` → `CommentMute`/
      `CommentTopicMute`
- [ ] Mirror verified against every bypass writer: `comics.router.ts` (`createChapterComment`
      writes `Thread`/`CommentV2` directly), `scam-cleanup.service.ts` raw hides, ban
      `removeComments`, `block-hide-comments.service.ts`, `restore-from-tos.ts`, the DB cascades
      (model → v1 comments, v1 parent → replies, `Thread` → `CommentV2`, account deletion)
- [ ] v3 service module on `kyselyV3Read`/`kyselyV3Write` (`src/server/db/kyselyDb.ts`; the plain
      `kyselyRead`/`kyselyWrite` have no `path` column), `path`
      operations as `sql` fragments, transactions through the Kysely client (D8); `test:lint-rules`
      run on every transaction change; Newest/Oldest keyset cursor is the `(createdAt, id)` pair
      compared as a row value, for top-level pages and reply pages alike
- [ ] `toggleLockCommentsThread` sets `Thread.locked` + `CommentTopic.locked` together
- [ ] `toggleThreadMute` → `CommentMute`, `toggleSectionMute` → `CommentTopicMute` (both v2 controls
      from PR #4524; the section control gains the ability to mute a comment-less entity)
- [ ] Entity hard-delete paths (image, post, article, bounty, model, account deletion) seen to
      cascade through the partition FK into `CommentTopic` and `CommentV3` on dev; the account
      path tombstones the user's parented comments before the row delete, or `parentId RESTRICT`
      rejects it (D6) **(review)**
- [ ] CDC provisioned **before** enabling: `public.CommentV3` in event-engine table subscriptions +
      `postgres.CommentV3` Kafka topic created (dedupe against old handlers during overlap)
- [ ] Deployed to production; new comments/reactions/reports visibly landing in both sides, zero
      write-path errors

**Gate:** every comment/reaction/report write in prod — service, raw SQL or cascade — lands in
CommentV3; the live edge is being maintained.

## Phase 3 — Backfill & reader re-point

Runs under live dual-write, so every copy job uses skip-existing semantics
(`ON CONFLICT (id) DO NOTHING` for v2, `ON CONFLICT ("legacyV1Id") DO NOTHING` for v1 — v1 rows
take new ids, so `id` never conflicts **(review)**; a v1 row the mirror already copied keeps the
id the mirror gave it; a mirrored row is always at least as fresh as the copy). `CommentV3`
carries 11 indexes, the GiST one the costliest to maintain: consider dropping `commentv3_path_gist`
and `commentv3_root_depth` for the load and rebuilding them after it:

- [ ] v2 comment copy job: `threadId → (entityType, entityId)` via root chain; `parentId` = thread's
      `commentId`; **inserted in depth order** so the path trigger finds each parent (`rootId`/
      `depth` come from the trigger, not the backfill); rows deeper than 20 **clamped** to a
      depth-20 sibling with `replyToId` set **(review)**; ids + timestamps preserved; nullable
      `hidden`/`locked` → false; idempotent + batched + resumable
- [ ] v1 comment copy job: `entityType='model'`, `legacyV1Id` set, new ids from the shared sequence
      for pre-existing rows; `createdAt` verbatim (the Newest sort reads it, not `id`); model
      topics upserted first (most have no `Thread`; a missing model is skipped and counted)
- [ ] Topic copy: one `CommentTopic` per entity-bearing Thread whose entity exists (missing
      entity skipped and counted; `ON CONFLICT ("entityId", "entityType") DO NOTHING`; locked
      carried, count recomputed from `CommentV2` rows, not copied from `Thread.commentCount`);
      `ANALYZE "CommentTopic"` afterwards, since autovacuum never analyzes the partitioned parent
- [ ] Reaction copy: `CommentV2Reaction` as-is, `CommentReaction` via `legacyV1Id`;
      `reactionCount` recomputed at end
- [ ] Report copy: `CommentV2Report` as-is, `CommentReport` via `legacyV1Id`
- [ ] Mute copy: `ThreadMute` splits. Thread with `commentId` → `CommentMute` on that comment's id
      (v2 ids preserved; note the off-by-one — v2 mutes the comment's CHILD thread); entity-bearing
      thread with no `commentId` → `CommentTopicMute`; orphaned → skipped and counted
- [ ] Orphaned-thread comments (and their reactions/report links) skipped, counts logged —
      entity-less root threads can no longer occur in prod (guard only); child threads with
      `commentId IS NULL` still can until V3 lands (load-bearing: a null `parentId` from one
      would promote a reply to top level on a live entity)
- [ ] Parity checks: per-entity counts vs `Thread.commentCount`, reaction counts vs both source
      tables, spot checksums, `ThreadMute` count vs `CommentMute` + `CommentTopicMute` + skipped,
      and an `updatedAt`/`deletedAt` comparison old vs new (count parity cannot see a stale edit
      or a resurrected delete) **(review)**
- [ ] Continuous parity monitor (row-count diff old vs new per day) running
- [ ] Reverse-copy script (CommentV3 → old tables, id-matched) written and tested — the Phase 4
      write-flip rollback tool

Re-point cross-surface **readers** at CommentV3 while dual-write keeps it complete (dual-write is
one-directional, so any reader left on the old tables goes blind the moment a surface's writes
flip — these MUST land before the first Phase 4 write flip):

- [ ] All notification `prepareQuery`s (pure-v1 types, per-entity v2 types, the UNIONs in
      `new-thread-response` + `mention.notifications.ts`, `reaction.notifications.ts`,
      `report.notifications.ts`) — new notifications write `details.version: 3`
- [ ] 🔴 The rewrite CARRIES the mute filter to all **14** `notThreadMuted` sites: `notThreadMuted`
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
- [ ] `collection.service.ts` Thread-join count; `challenge.service.ts` four raw
      `Thread.commentCount` reads; `resourceReview` `thread.commentCount` reads → `CommentTopic`
- [ ] `/comments/v2/[id].tsx` permalink query
- [ ] **(review)** `events/points/hooks.ts` (`onCommentCreated`/`onCommentsRemoved`),
      `assertCommentEntityVisible` + `getCommentThreadBounty`/`getCommentThreadCrucibleId`,
      `creator-score-self-activity.service.ts`, `bot-account-detection/cohort.ts`,
      `scam-cleanup.service.ts` restore (ledger holds old ids → `legacyV1Id` alias)

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
- [ ] **comicChapter**: `ChapterComments.tsx` client shape change (drops `parentThreadId`;
      `entityId` becomes `ComicChapter.id`, returned by `getChapterThread`); `createChapterComment`
      moves onto the unified service
- [ ] **crucible**: `getCommentThreadCrucibleId` + `new-crucible-comment` notification
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
      optional**: one builder is one place the mute filter can go missing, instead of 14

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
- [ ] Mod endpoints `bulk-delete`/`remove-as-tos`/`restore-from-tos` take single `commentIds`
      (dual-list alias for one release); `moderator-endpoint-catalog.generated.ts` regenerated

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
- [ ] Drop triggers: `comment_count_update` (function `update_thread_comment_count`),
      `trg_moderation_comment`, `trg_moderation_commentv2`, `comment_reaction_count_update`, the
      Phase 2 mirror triggers and their functions, and `commentv3_thread_entity`
- [ ] Remove any remaining Thread entries from `schema-drift/drift-baseline.json` + update
      remediation plan and `production-plan.test.ts`
- [ ] `DROP SCHEMA archive CASCADE` (the ten purge-archive tables) once the old tables are gone
- [ ] `EntityType` values `Comment`/`CommentV2` **left in place** (read-time aliases only)
- [ ] `job-queue.ts` unused mappings deleted; schema reverse-relations cleaned;
      `db:generate` + `db:check-generated` clean
- [ ] Plan doc + this checklist marked complete; `docs-drift-review` over the final diff

**Gate:** prod schema contains no old comment tables; drift gate green; full unit suite green.
