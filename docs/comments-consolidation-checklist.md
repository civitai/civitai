# Comments Consolidation — Execution Checklist

Working checklist for [comments-consolidation.md](comments-consolidation.md) — that doc holds the
rationale and detail; this one is the order of operations. Check items off as they land; each phase
ends with a **gate** that must be true before the next phase starts.

Schema is the **merged design** (2026-08-25, Koen's counter-proposal + adjustments): ltree `path`
set by a `BEFORE INSERT` trigger with `rootId`/`depth` generated from it, `replyToId`, tombstone
deletion (`deletedAt` + `parentId ON DELETE RESTRICT`), comments FK'd to `CommentTopic`. Deletion
semantics are **decided** (D6): tombstone with replies, hard-delete childless. Per-thread
notification mute is **in scope** (D7, added 2026-09-01 after PR #4524 shipped it for CommentsV2).
The v3 reads are **Kysely**, the writes raw SQL over a `SqlRunner` (D8, amended 2026-10-30).
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
- [ ] ltree on the CI Postgres service (`lint.yml`) and local docker-compose. Dev already had it
      when the 2026-10-20 dev apply ran (the `CREATE EXTENSION IF NOT EXISTS ltree` that opens
      the schema migration was a no-op there). **Not answered:** whether the application role
      can create it (a trusted extension, so it should); the dev apply ran as a superuser.
      Confirm with a non-superuser role on a database without the extension
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
- [x] Triggers: `CommentTopic.commentCount` (`commentv3_topic_comment_count`, immediate here; the
      Phase 2 mirror migration replaces it with a `DEFERRABLE INITIALLY DEFERRED` constraint
      trigger and a `SECURITY DEFINER` function, see the plan under Phase 2; counted set = ALL
      rows incl. hidden/self, matching today's `update_thread_comment_count`, plus tombstones,
      which the old side drops; unlike it, the decrement clamps at 0), reaction-count port
      `commentv3_reaction_count`
- [x] **(review, 2026-10-20)** `CommentTopic` is `PARTITION BY LIST ("entityType")`: one partition
      per enum value, each with an `ON DELETE CASCADE` FK to its entity table (`ComicChapter (id)`,
      `app_listings (serial_id)`); the migration loops over the enum and fails on a missing
      mapping (same migration)
- [ ] On dev: `\d "Image"` lists the partition FK (the reply-tree cascade from the entity side is
      in the mirror behaviour test; the comment-insert-vs-entity-delete race was run with two
      connections on Postgres 18.6, plan Phase 2; the 2026-10-20 dev apply did not repeat either)
- [x] Schema declaration for type generation (D8: no Prisma delegate touches v3): `path` as
      `Unsupported("ltree") @default(dbgenerated())`, `rootId`/`depth` `Int @default(dbgenerated())`;
      `CommentTopic` declared once (`@@id([entityId, entityType])`), not per partition. prisma-kysely
      2.3 drops Unsupported columns outright, so `src/server/db/kyselyDb.ts` exports
      `kyselyV3Read`/`kyselyV3Write` (`withTables`) that add `path` as select-only `string` and
      narrow `rootId`/`depth` to select-only; the shared clients keep the generated `DB` that the
      `@civitai/db-queries` signatures are typed against **(review)**
- [ ] **(moved to Phase 4)** Clavata trigger migration (`EntityType` value + `trg_moderation_commentv3`,
      pulled out of Phase 1 in #6449), the `entity-moderation.ts` consumer, and the text-scan
      `CommentV3` profile/entity type: built and applied, see Phase 4, "With the first write flip"
- [ ] **(moved to Phase 4)** report-queue readers, `csam-holds.queries.ts` and the verdict/retention ledger alias: see
      Phase 4, "With the first write flip"
- [x] `packages/civitai-db-schema/src/kysely/updated-at-tables.ts` gains the new tables — under
      D8 this is the only thing that maintains `updatedAt` on them (generated)
- [x] `pnpm run db:generate` clean (2026-10-20)
- [x] `pnpm run db:check-generated` clean on the PR (#6448). `db:moderator:pull` introspects the
      separate moderator database (`MODERATOR_DATABASE_URL`), so the partition children never
      reach it
- [x] Migration SQL `20261110120000_comment_v3_schema` merged (#6448) and **applied manually** to
      prod and to dev 2026-10-20; the replica shows the 13 partitions with their cascade FKs, the shared
      sequence as the id default on all three comment tables, the three triggers and every index.
      `comment_shared_id_seq` was created under the default ACL, so the roles the old
      `Comment_id_seq`/`CommentV2_id_seq` granted beyond the owner and app writer were granted by
      hand (applied 2026-10-21; the replica shows no role left behind)

**Gate:** new tables live and empty in prod; client deployed knowing all new types.

## Phase 2 — Dual-write (deploy to production first)

Comments AND reactions/reports — everything mirrors before any backfill runs. The mirror is
**database triggers on the old tables**, not service code (review, blockers 1–3): cascades and
the raw-SQL writers never reach the services, a one-for-one delete mirror would trip
`parentId ON DELETE RESTRICT`, and an app-level copy leaves a read-then-insert window for the
backfill to race.

- [x] `AFTER INSERT/UPDATE/DELETE` mirror triggers on `Comment` (via `legacyV1Id`; a v1 row above
      `commentv3_v1_id_floor()`, the old sequences' frozen position, keeps its id as the V3 id;
      an older row is renumbered as the backfill would) and `CommentV2`: insert copies any missing
      ancestor chain first (`Thread.commentId → CommentV2.threadId`), clamping past the depth cap
      as the backfill does; update mirrors `content`/`tosViolation`/`hidden`/`pinnedAt` (and v1
      `locked`) or copies the row if it is not there yet; delete applies D6 (tombstone if the v3
      row has replies or is answered by a clamped reply via `replyToId`, else hard-delete) and
      removes a tombstone that just lost its last reply or last answerer, walking up through
      tombstoned ancestors on both edges —
      migration `20261120120000_comment_v3_mirror` (2026-10-20); a comment or ancestor that is
      mid-delete, or an entity cascade in flight, is not waited on (`SKIP LOCKED`): the write is
      left unmirrored for the backfill
- [x] `commentv3_thread_entity(thread)` SQL function — one `Thread` → `(entityType, entityId)`
      resolver shared by the mirror triggers and the backfill (also returns the root's `locked`);
      climbs `commentId → CommentV2.threadId` rather than trusting `rootThreadId`; the
      `comicChapter` branch joins `ComicChapter` on `(projectId, position)` and returns its `id`;
      the `appListing` branch returns `Thread.appListingId` (= `app_listings.serial_id`, not the
      text ULID `id`); question/answer/clubPost and dead-parent threads resolve to nothing and
      their writes are skipped
- [x] Mirror triggers on `CommentReaction`/`CommentV2Reaction` → `CommentV3Reaction`,
      `CommentReport`/`CommentV2Report` → `CommentV3Report`, `ThreadMute` → `CommentMute`/
      `CommentTopicMute`; each copies a not-yet-mirrored comment before linking to it
- [x] Mirror verified against the bypass writers: each writer's statement was read for the
      columns it sets and every one is in a trigger's `UPDATE OF` list (`commentsv2.service.ts`
      content/hidden/pinnedAt/tosViolation, `comment.service.ts` and `comment.controller.ts`
      for v1 incl. the children lock loop, `scam-cleanup.service.ts` and
      `block-hide-comments.service.ts` raw hides, `user.service.ts` ban `removeComments`;
      row triggers are indifferent to multi-row or `RETURNING` forms), and the statement shapes
      run in `src/server/services/__tests__/comment-v3-mirror.sql.behavior.test.ts` (PGlite, and
      the same scenarios on Postgres 18.6): raw `UPDATE … SET hidden`/`tosViolation`,
      `DELETE … WHERE "userId"` in one statement (`removeAllContent`), direct
      `Thread`/`CommentV2` inserts (`comics.router.ts` uses the same tables), and the DB
      cascades (model → v1 comments, v1 parent → replies, `Thread` → `CommentV2`, entity →
      `Thread` alongside entity → `CommentTopic`). Prod confirmation is the deploy item below.
      Account deletion never hard-deletes a `User` row (plan, D6)
- [ ] **(moved to Phase 4)** v3 service module on `kyselyV3Read`/`kyselyV3Write`
      (`src/server/db/kyselyDb.ts`; the plain `kyselyRead`/`kyselyWrite` have no `path` column),
      `path` operations as `sql` fragments; the write path is raw SQL over a `SqlRunner`, so callers
      share a Prisma transaction (decision 8 amended 2026-10-30; built for article 2026-10-29,
      awaiting the stage B deploy: `commentv3/write.service.ts`);
      `test:lint-rules` run on every transaction change; Newest/Oldest keyset cursor is the
      `(createdAt, id)` pair compared as a row value, for top-level pages and reply pages alike.
      Nothing in Phase 2 reads or writes `CommentV3` from the app, so the module ships with its
      first consumer
- [x] `toggleLockCommentsThread`: no app-level pair needed — the `Thread` mirror trigger upserts
      `CommentTopic.locked` on a root thread insert or `locked` update (the locked empty thread
      it creates gets a locked topic), and sets `CommentV3.locked` from a reply thread's lock; a
      v1 insert copies an existing model `Thread`'s lock
- [x] `toggleThreadMute` → `CommentMute`, `toggleSectionMute` → `CommentTopicMute`: carried by the
      `ThreadMute` mirror trigger (a reply thread's mute lands on the comment it hangs off, a
      root thread's on the entity). The section control still returns `hasThread: false` on a
      comment-less entity until its surface flips to the v3 service, which writes
      `CommentTopicMute` directly
- [x] Entity hard-delete paths seen to cascade through the partition FK into `CommentTopic` and
      `CommentV3` in the behaviour test (image with a reply tree, model with v1 comments, a
      direct `Thread` delete of a 25-deep chain); the mirror's delete never hard-deletes a row
      with replies or one a clamped reply answers, so the `Thread` cascade and the partition
      cascade cannot collide on
      `parentId RESTRICT` whichever runs first. No app path hard-deletes a `User` row, and one
      cannot succeed by hand either: the `userId` cascade removes the tombstone and
      `parentId RESTRICT` rejects that (D6 records the schema decision it would take)
      **(review)**
- [ ] **(moved to Phase 5)** CDC for `CommentV3` (replica identity, subscription, topic, handler):
      see Phase 5, "Event-engine / metrics"; it lands before the first Phase 4 write flip. Under
      dual-write a handler would double-count every mirrored row, and a subscription without one
      streams every reaction's `reactionCount` update as a full-row event nothing reads
- [x] Mirror migration **applied manually** to prod 2026-10-21 (verified on the replica: eight
      `commentv3_mirror` triggers, the deferred count trigger, the `ensure_topic` re-probe, definer
      functions with `EXECUTE` revoked; the first comments since, v1 and v2, matched their old rows
      with topics and reactions counted) (after the Phase 1 schema migration; nothing
      in it needs the client; apply as the same owner role, since it replaces a function and a
      trigger the schema migration created, that role is what every definer function runs as, and
      the mirror takes row locks on the old tables and all 13 entity tables, which needs `UPDATE`
      on them). Both migrations applied to dev 2026-10-20 (the `commentv3_ensure_topic` re-probe committed 2026-10-21 was re-applied there the same day): eight enabled mirror
      triggers, the count trigger deferred, and a rolled-back reply under a real image comment
      copied its parent on demand with the right topic and path.
      One transaction with `SET LOCAL lock_timeout = '3s'`: trigger DDL
      waits behind every in-flight writer on the old tables, so a lock timeout rolls the whole
      file back and leaves nothing behind; retry off-peak with `psql -v ON_ERROR_STOP=1 -f`.
      Watch the first bulk paths that run under it: a `deleteMany` of a spammer's comments or a
      scam-cleanup hide pays the per-row mirror inside one statement (row lock, children probe,
      a delete across the index set, a queued topic count update that runs at commit, and before
      the backfill a copy with ancestors for every row not yet mirrored); if a large one is slow,
      those callers chunk. Two such wipes on one entity committing in the same instant can
      deadlock at commit (plan, Phase 2); if `40P01` shows up on `removeAllContent` or the scam
      cleanup, add a retry there
- [x] `20261210120000_comment_v3_mirror_changed_columns` (the mirror copies only the columns an
      old-table update changed) and ClickHouse `2026-10-29-comment-v3-report-entity.sql`
      **applied manually** to prod 2026-10-30
- [x] After the apply, note the entity cascade order on prod (checked 2026-10-21: `Thread` first
      on all 13 entity tables) (informational; nothing depends on
      it): for each entity table, whether the `Thread` FK's `RI_ConstraintTrigger_a_*` sorts
      before the `CommentTopic_*` partition FK's (Postgres fires them in name order, so by OID).
      True today by OID. The mirror does not rely on it: every copy takes `KEY SHARE` on the
      topic row with `SKIP LOCKED` before writing (a locked topic leaves the write unmirrored),
      and the count trigger's delete branch probes the same way, so a topic-first cascade cannot
      deadlock a reply or a comment delete at commit (plan, Phase 2). Record the result if a
      database differs:

      ```sql
      SELECT c.confrelid::regclass AS entity, t.tgname, c.conrelid::regclass AS referencing
      FROM pg_trigger t JOIN pg_constraint c ON c.oid = t.tgconstraint
      WHERE t.tgname LIKE 'RI_ConstraintTrigger_a%'
        AND (c.conrelid = '"Thread"'::regclass OR c.conrelid::regclass::text LIKE '"CommentTopic_%')
      ORDER BY 1, 2;
      ```

      Two more invariants the mirrored delete rests on, true until Phase 6 drops the triggers: no
      mirror trigger is renamed so that it sorts before `RI_ConstraintTrigger_*` (the RI
      `SET NULL` and cascade actions must fire first; `commentv3_mirror` sorts after them), and
      `Thread_commentId_key` is neither dropped nor made partial (`FOR UPDATE` on the `SET NULL`
      update is what makes it wait for an in-flight reply). Re-check both before any index work
      on `Thread`

- [ ] Deployed to production; new comments/reactions/reports visibly landing in both sides, zero
      write-path errors; the ThreadMute and lock mirrors spot-checked (`CommentTopic.locked`
      matches `Thread.locked` on a locked entity)

**Gate:** every comment/reaction/report write in prod — service, raw SQL or cascade — lands in
CommentV3, except one that yielded (`SKIP LOCKED`) to a delete or entity cascade holding a row it
needed — its comment, an ancestor, the topic or the entity (left unmirrored, copied by the Phase 3
backfill); the live edge is being maintained.

## Phase 3 — Backfill & reader re-point

Runs under live dual-write, so every copy job uses skip-existing semantics
(`ON CONFLICT (id) DO NOTHING` for v2, `ON CONFLICT ("legacyV1Id") DO NOTHING` for v1 — v1 rows
take new ids, so `id` never conflicts **(review)**; a v1 row the mirror already copied keeps the
id the mirror gave it, its own id above `commentv3_v1_id_floor()` and a fresh sequence id
otherwise; a mirrored row is always at least as fresh as the copy). `CommentV3`
carries 11 indexes, the GiST one the costliest to maintain: consider dropping `commentv3_path_gist`
and `commentv3_root_depth` for the load and rebuilding them after it. The deferred topic-count
trigger queues one event per inserted row and runs them serially at commit, so keep batches to
tens of thousands of rows per transaction, and never `DISABLE TRIGGER` it or run under
`session_replication_role = replica` for the load: both would skip live mirror counts (and the
latter the path trigger and the RI checks). Before the load is also the
moment to make `commentv3_replies_newest`/`commentv3_replies_reactions` partial on
`"parentId" IS NOT NULL` (every reader filters `parentId = const`, and top-level rows, the
majority, add dead entries to both; Prisma cannot declare a partial index, so they would move to
the undeclared set like `top_*`):

- [x] v2 comment copy job: `threadId → (entityType, entityId)` via root chain; `parentId` = thread's
      `commentId`; ancestors copied before each row, so batch order does not matter (`rootId`/
      `depth` come from the trigger, not the backfill); rows deeper than 20 **clamped** to a
      depth-20 sibling with `replyToId` set; ids + timestamps preserved; nullable
      `hidden`/`locked` → false; idempotent + batched + resumable. Each batch reads its source
      rows `FOR KEY SHARE SKIP LOCKED` (a row a deleter holds is left for the next pass, so the
      batch never waits on a deleter the way the mirror never does; unlocked, the batch would
      commit a row for a comment that no longer exists, and a concurrent hide would be lost the
      same way). A delete that lands after the batch's lock waits, and its mirror tombstones or
      removes the committed copy — built 2026-10-21 as `comment-v3-backfill` step `v2`
      (`src/pages/api/admin/temp/comment-v3-backfill.ts`), calling the mirror's own
      `commentv3_mirror_v2` per row so a backfilled row is what the mirror would have written; each
      pass also re-syncs a mirrored comment's lock from its reply Thread (an unlock that commits while
      the comment's copy is uncommitted is dropped by the mirror); run on prod 2026-10-21
- [x] v1 comment copy job: `entityType='model'`, `legacyV1Id` set, new ids from the shared sequence
      for pre-existing rows; `createdAt` verbatim (the Newest sort reads it, not `id`); model
      topics created on demand (most have no `Thread`; a missing model is skipped and counted) —
      step `v1`, calling `commentv3_mirror_v1` per row; run on prod 2026-10-21
- [x] Topic copy: one `CommentTopic` per entity-bearing root Thread that carries a comment, a lock
      or a mute, whose entity exists (missing entity skipped and counted;
      `ON CONFLICT ("entityId", "entityType") DO NOTHING`; locked carried, and re-synced on a topic
      whose lock drifted from its root thread; the count is maintained by the deferred trigger as
      the comment copies insert, never copied from `Thread.commentCount`) — step `topics`, calling
      `commentv3_ensure_topic` per qualifying root thread; the 3.6M empty, unlocked, unmuted root
      threads get no topic (plan, Phase 3: readers already treat "no topic" as no comments); a
      dead-parent child thread (`commentId` nulled, `parentThreadId` set) is not a root and is left
      out; run on prod 2026-10-21, `ANALYZE "CommentTopic"` done afterwards, since autovacuum never
      analyzes the partitioned parent
- [x] Running it: `dryRun` defaults to true (GET; the range steps return pending counts, the
      reverse ones counted with their live predicates and needing their scope even then, while
      `mutes`, `sweep`, `reverseRootThreads` and `reverseTopicMutes` only say they have no dry
      count); a live run is a POST with `dryRun=false`; `unmirrored` and `parity`
      always run. `concurrency=1` for `v2`, `v1` and the reaction steps (two batches that share an
      ancestor chain, a topic or a comment deadlock each other and roll back; `topics` and the
      report steps are safe at 2, `mutes` is a single pass); `DATABASE_REPLICA_LONG_URL` set where the `unmirrored`/`parity` reports
      run, or they hit the primary with no statement timeout; `sweep` only after `topics` has
      converged, i.e. its dry-run `pending` has stopped falling (an orphaned topic mute and one whose
      topic is not made yet look the same); one more `v2` pass after the last copy, since its lock
      re-sync is what catches an unlock that committed mid-copy; a raw hard-delete of a `User` (or, for the report steps, of a `Report`) during the load can
      deadlock against a batch holding one of that user's comment or link rows (the batch takes the
      `User`/`Report` row last, at the INSERT's FK check; no app path does either) and shows up as a
      failed range to re-run; a batch
      that fails is listed in the response's `failedRanges` and re-run with `start`/`end`. The
      reaction links update `reactionCount` once per link, a non-HOT update of `CommentV3` each
      (the column is indexed), so expect the table's heap to bloat until vacuum. Do not disable
      the count trigger to avoid it (see the Phase 3 intro): live mirrored counts would be lost
- [x] Reaction copy: `CommentV2Reaction` as-is, `CommentReaction` via `legacyV1Id`;
      `reactionCount` maintained by the reaction-count trigger as the links insert. Runs after the
      comment copies, so it also covers reactions whose comment was unmirrored at the time (a
      `SKIP LOCKED` yield) — steps `v2Reactions`/`v1Reactions`; each batch locks the link row
      (`FOR SHARE`, since a reaction change is a plain `UPDATE`), then the old comment, then the v3
      one (key-share, `SKIP LOCKED`), so a link never waits on a deleter and an unlink waits for the
      copy to commit and then removes it; rows whose comment is not mirrored or is held come back as
      `unmirrored`; run on prod 2026-10-21
- [x] Report copy: `CommentV2Report` as-is, `CommentReport` via `legacyV1Id`; after the comment
      copies, for the same reason, with the same lock order (`FOR KEY SHARE` on the link row) —
      steps `v2Reports`/`v1Reports`; run on prod 2026-10-21
- [x] Mute copy: `ThreadMute` splits (the Phase 2 trigger already carries live changes, so
      `ON CONFLICT DO NOTHING` on the PK). Thread with `commentId` → `CommentMute` on that comment's
      id (v2 ids preserved; note the off-by-one — v2 mutes the comment's CHILD thread);
      entity-bearing thread with no `commentId` → `CommentTopicMute`; orphaned → skipped and
      counted — step `mutes`, one pass; run on prod 2026-10-21
- [x] Orphaned-thread comments (and their reactions/report links) skipped, counts logged —
      entity-less root threads can no longer occur in prod (guard only); child threads with
      `commentId IS NULL` still can until V3 lands (load-bearing: a null `parentId` from one
      would promote a reply to top level on a live entity) — step `unmirrored` reports them by
      reason (`v2_no_thread`, `v2_dead_parent`, `v2_unresolved_entity`, `v2_no_topic`,
      `v1_dead_parent`, `v1_no_topic`) with sample ids, and whatever none of those explains as
      `v2_pending_unexplained` / `v1_pending_unexplained`, the two the monitor pages on. Prod holds two such classes the FK cascades
      predate: 8,531 v2 comments (ids 1857994–1868035, 2026-02-27 to 03-01) whose `Thread` row is
      gone, with 4,409 reactions, and 2 v1 replies whose parent comment is gone; none of them can
      render today, so they stay out and the parity counts leave them aside, plus every link whose comment is mirrored but whose link is not
- [x] Parity checks: per-entity counts vs `Thread.commentCount`, reaction counts vs both source
      tables, spot checksums, `ThreadMute` count vs `CommentMute` + `CommentTopicMute` + skipped,
      locked state (`CommentTopic.locked` / `CommentV3.locked` vs `Thread.locked`),
      `hidden`/`tosViolation` old vs new (a raw hide leaves `updatedAt` alone), and an
      `updatedAt`/`deletedAt` comparison old vs new (count parity cannot see a stale edit or a
      resurrected delete), and live v3 rows whose old row is gone (v2 by id, v1 by
      `legacyV1Id`: the mirror's delete yields to an entity cascade holding the row, and a
      cascade that later rolls back leaves it live) — step `parity` reports these as a count plus
      sample ids: live v3 rows with no old row (`v2_ghosts`, `v1_ghosts`), `resurrected` deletes,
      per-Thread and per-model count mismatches against the live old rows (not
      `Thread.commentCount`; a clamped reply answers its thread through `replyToId`),
      `topic_count_mismatch` (against its own rows, because the trigger counts tombstones),
      `reaction_count_mismatch`, link extras (`v2_reactions_extra`, `v1_reactions_extra`,
      `reports_extra`, `mutes_extra`), `topic_lock_mismatch`/`comment_lock_mismatch`, full-row
      `v2_column_drift`/`v1_column_drift` (replaces spot checksums and the `updatedAt`
      comparison), `v1_parent_mismatch`, and `tombstones_childless`/`topic_mutes_orphaned`. Every
      finding must be zero after `sweep` and a following `v2` pass; those last two are the accepted residue that `sweep`
      clears. Mute totals are covered by `mutes_pending` (in `unmirrored`) plus `mutes_extra`, not
      by a count. Run on prod 2026-10-21 after the backfill: all zero in 79 s
- [x] Two sweeps the mirror can leave behind (the tombstone one safe to run any time, the topic-mute
      one only after `topics` has converged, since a mute whose topic is not made yet looks the
      same as an orphan): tombstones with neither a
      reply nor an answerer (`DELETE FROM "CommentV3" t WHERE "deletedAt" IS NOT NULL AND NOT
EXISTS (SELECT 1 FROM "CommentV3" WHERE "parentId" = t.id OR "replyToId" = t.id)`; two
      concurrent deletes can produce one), and `CommentTopicMute`
      rows whose entity is gone (no FK to the topic by design, and an entity delete cascades
      `ThreadMute` after its `Thread` row is already gone, so the mirror cannot map them) —
      step `sweep`, repeated until a tombstone chain has collapsed; a tombstone whose old row
      still exists (a raw `UPDATE` of `deletedAt`) is deleted by `sweep` if childless and then
      re-copied by the next `v2` pass; one that still has children stays and is reported as
      `resurrected`, to be fixed by hand
- [x] Backfill run on prod 2026-10-21 from a script calling the service against the primary with
      the reports on the replica, batches of 2,000, sequential: topics 1,301,189 (19 min), v2
      2,174,415 (17 min) and a converged second pass, v1 1,241,478 (11 min), v2 reactions 3,492,375
      (11 min), v1 reactions 1,703,270 (6 min), reports 59,133 + 21,637, mutes 33 + 288; every
      pending row classified (8,531 no thread, 3 dead-parent, 1,124 question/answer, 2 v1
      dead-parent); sweep 0; parity all zero; replica replay lag never above 0.2 s
- [x] Continuous parity monitor: the `comment-v3-parity` job (`src/server/jobs/comment-v3-parity.ts`,
      daily at 09:20 UTC on the long-query replica) runs the `unmirrored` and `parity` reports plus
      current row totals of the old and new comment and reaction tables, keeps the latest result in
      `KeyValue` (`comment-v3-parity:last`) and Axiom, sets the gauge
      `comment_v3_parity_finding{finding}` per finding, and sends a mod alert when anything beyond
      the skipped orphan classes and the two sweepable residues is nonzero (`parityVerdict`), or
      when the job itself fails. A stretch of days without an alert is the gate below
- [x] Reverse-copy script (CommentV3 → old tables, id-matched) written and tested — the Phase 4
      write-flip rollback tool: the `reverse*` steps of the backfill endpoint
      (`comment-v3-reverse-copy.service.ts`), every one ranged and run with the same scope on every
      call: `since` (the last converged forward pass before the flip), `until` (when the flip was
      reverted) and `entityTypes` (the flipped surface). Ids are
      shared, but a v3-only comment also needs its entity's root `Thread` and its parent's reply
      `Thread`, which the steps create; a v3-native model comment goes to the v1 `Comment` table the
      model page reads, with `legacyV1Id` set to its id first, unless it replies to a v2 row on the
      model's thread, in which case it stays v2 like its parent; edits, flags, locks (topic and
      comment), deletes, reactions, report links and mutes flow back in both directions. A v3-only
      row is copied only if created in [`since`, `until`); outside it the row is a ghost for the
      parity report. An old row with no v3 row is removed only if it predates `since` and is on a
      flipped type (a v3-side hard delete); a newer one is a comment the mirror yielded on; an old
      row edited after its v3 row is left alone, which also keeps a
      concurrent old-side edit from being overwritten; reactions and mutes come off the old side
      only when they predate `since`; a v1 tombstone that still has replies is blanked rather than deleted, since
      the old cascade would take the replies and the mirror would then delete them from v3 too (the
      parity report treats a blanked v1 row as its tombstone's twin); once its last reply goes, that
      blank row is an orphan, so `reverseDeletes` runs once more after the rollback has settled and
      before any forward pass or sweep (a forward pass would re-mirror it live). `since` is the end
      of a forward pass run right before the flip (an old comment made in the gap and then
      hard-deleted on v3 would otherwise come back), `until` a time after the last v3 write.
      Proven on PGlite against every kind of v3-only write. Run only after the write flip, with the
      forward side quiesced, old-side writes still off where possible (a lock toggled on the old
      side during the update step can be reverted) and `unmirrored` showing nothing beyond the
      skipped classes
- [ ] Reverse-copy proven on a prod sample: run the `reverse*` steps against a copy of prod with a
      few thousand v3-only writes of each kind (comment, reply, edit, lock, delete, reaction, report
      link, mute) and confirm `parity` reads zero — the Phase 3 gate's last clause

Re-point cross-surface **readers** at CommentV3 while dual-write keeps it complete (dual-write is
one-directional, so any reader left on the old tables goes blind the moment a surface's writes
flip — these MUST land before the first Phase 4 write flip):

- [x] All notification `prepareQuery`s read CommentV3 (the comment family, `new-mention`, the
      comment reaction milestone on `CommentV3Reaction`, and `report-actioned`'s
      `CommentV3Report` arm); new notifications write `details.version: 3`, and the detail fetcher
      reads CommentV3 for them (tombstones excluded like takedowns). Model comments keep the v1
      detail shape, permalink and `comment:v1:` dedupe namespace, with the parent and milestone ids
      as `legacyV1Id` so a renumbered comment does not re-announce. `new-thread-response` and
      `new-mention` are one CommentV3 query each; thread participants are the comment's siblings
- [x] 🔴 The mute filter is carried to all **14** sites as `notCommentMuted` (a `CommentTopicMute`
      probe plus a `CommentMute` join on `path @>`, and the clamped `replyToId`).
      `thread-chain.ts` is NOT deleted: the block-check write guard, the block hide sweep and the
      v2 lock check still walk the old thread chain, and go with the v2 write path in Phase 5
- [x] `no-unmuteable-comment-processor` re-pointed at the v3 SQL in the same change, keeping the
      `new-mention` exemption; it also pins that no comment-family query reads an old table.
      Verified red with the filter removed from `new-image-comment`. The three model-page
      processors stay unmuteable: the model page has no mute control yet
- [x] `getThreadMuted` / `getSectionMuted` read the suppression's own predicate
      (`notCommentMuted`, and `CommentTopicMute` for the section), so the menu label cannot diverge
      from behaviour. Their v2 lookups stay only for what the still-v2 toggle needs (`hasThread`,
      `canMute`)
- [x] Moderator app reads: `user-account.service.ts` (both comment lists and
      `commentParents`), `user-lookup.service.ts` (the two comment counts and the
      model-comment flags). Every per-user read filters `deletedAt IS NULL`. Model comments are
      listed by their old id, which the bulk actions and the model dialog still address. The panel's
      nsfw badge is gone: CommentV3 has no nsfw column (one v1 comment in prod had it set).
      `user-signals.service.ts` reads only ClickHouse. The report-queue joins
      (`report-entities.ts` and its consumers: `reports.service.ts` context URLs,
      `user-reports`, `moderation-board`, `text-relabel-snapshot`, `getReportedContent`) and
      `csam-holds.queries.ts` stay on the old link tables: they key on the report-entity types
      and ids the moderation wiring writes, and move with `ReportEntity.CommentV3` in Phase 4
- [x] Creator-studio analytics (`analytics.ts`: all-time comments on the creator's images and the
      per-image daily count). `analytics-detail.ts` has no Postgres comment read
- [x] Metrics jobs (`article/bounty/post/model3d.metrics.ts` and `post.metrics-old.ts`, used while
      `simplified-post-metrics` is off) count top-level live comments, which is what the
      root thread counted; `model.metrics.ts`'s distinct commenters read CommentV3 too. The
      disabled question and answer jobs have no entity type and are left as they are
- [x] `daily-challenge-processing.ts` judge gate (both reads), `getJudgeCommentForImage`,
      `api/mod/daily-challenge/re-review.ts`
- [x] `collection.service.ts` judged check; `challenge.service.ts`'s four comment counts and
      `resourceReview`'s two count top-level live comments on CommentV3. Not
      `CommentTopic.commentCount`: that counts replies and tombstones, so the numbers shown would jump
- [x] `/comments/[id].tsx` (canonical; `/comments/v2/[id].tsx` is an alias of it) resolves from the
      CommentV3 row (`comment-permalink.ts`); a tombstone 404s
- [x] **(review)** `events/points/hooks.ts` counts the actor's remaining comments on CommentV3
      (its thread lookup is the v2 write path's input and goes with it);
      `creator-score-self-activity.service.ts` and `bot-account-detection/cohort.ts` read
      CommentV3 (the v1 and v2 comment reads, visible and membership each, became one pair). Left for Phase 4, as writes:
      `scam-cleanup.service.ts` (hide and restore are UPDATEs), the reaction toggle reads, and
      `assertCommentEntityVisible` / `getCommentThreadBounty` / `getCommentThreadCrucibleId` /
      the storyline lookups, which guard v2 writes on the thread they are given

Not on this list, each a surface's own read that moves with it: `comics.router.ts::getChapterThread`
(Phase 4, comicChapter), the v1 reply counts in `comment.controller.ts` (Phase 4, model),
`entity-moderation.ts`'s selectors (Phase 4, first write flip) and the event-engine comment
handlers (Phase 5 CDC item, provisioned before the first write flip). Accepted, not changed: a mute
on a comment past the depth cap reaches a clamped reply that answers it directly, not a reply to
that reply (`replyToId` is one hop); a model topic's section mute silences model thread responses
but not the three model-page processors; a write the mirror yields on and a later backfill pass
copies keeps its original `createdAt`, so it is behind every notification and metrics cursor and
sends nothing; the v2 comments on model threads (no old id) notify through the thread-addressed
processors, as they did before.

**Gate:** backfill converged and re-run once more after the monitor's last drift (a write that
yielded to a `SKIP LOCKED` conflict whose delete then rolled back stays unmirrored until a pass finds
it); N days without a `comment-v3-parity` alert; no read-only cross-surface reader still queries
the old tables (the exceptions named above, the report-queue joins, `csam-holds.queries.ts`, the
reaction toggle reads, the v2 write-path guards and `thread-chain.ts`, move with the first write
flip or the v2 write path); the `CommentV3."createdAt"` and `CommentV3Reaction."createdAt"` indexes
(`20261125120000_comment_v3_created_at_indexes`, applied by hand) are on prod before the re-point
deploys; reverse-copy proven on a prod sample.

## Phase 4 — Per-surface flips (no flags: reads in one deploy, writes in a later one)

Repeat this block per surface, in the Phase 0 order (model **last**):

- [ ] Notification deep links switch `commentParentId` from `replyToId` to `parentId` with the read
      flip: under v3 reads a clamped reply hangs off its parent (article: built, awaiting stage A
      deploy; see `docs/plans/comments-v3-article-flip.md`)
- [ ] Read flip deployed → soak → verify (comments render, counts match, hidden/blocked exclusions hold,
      pinned order, deep-links/`targetCommentId`, reply pagination, mute menu state matches whether
      notifications actually arrive)
- [ ] Reactions read from `CommentV3Reaction`
- [ ] Write flip deployed → soak → old write path removed for this surface; the v3 write path applies
      the D6 tombstone collapse the mirror applies today. Once a surface writes `CommentV3`
      directly its deletes must go through the v3 service too: the mirror's delete is safe
      against replies only because every reply in flight also holds an old `Thread` row or old
      parent that the delete already waited on, and a v3-direct reply holds neither. The v3
      delete also tombstones a comment a clamped reply answers (`replyToId`) and collapses
      tombstones on both edges (`parentId`, `replyToId`). Article: built 2026-10-29
      (`commentv3/write.service.ts`), awaiting the stage B deploy; see
      `docs/plans/comments-v3-article-flip.md`

With the first write flip (the moderation items moved here from Phases 1 and 2):

- [ ] Report-queue readers and `csam-holds.queries.ts` move with `ReportEntity.CommentV3`: `report-entities.ts` gains a
      `{ 'CommentV3Report', 'CommentV3' }` entry beside the old two, read by `reports.service.ts`
      context URLs, `user-reports`, `moderation-board`, `text-relabel-snapshot` and
      `getReportedContent`; `csam-holds.queries.ts` likewise; `assertCommentEntityVisible` /
      `getCommentThreadBounty` / `getCommentThreadCrucibleId` / the storyline lookups and the reaction toggle reads move
      with the v3 write path. Built 2026-10-29 in the moderator app and the main app, awaiting the
      stage B deploy
- [x] Verdict/retention ledgers are **not** aliased across `Comment`/`CommentV2`/`CommentV3`: an
      article comment edited after the flip is scanned afresh under `CommentV3`, and its earlier
      verdict and hold stay under the old type (decided 2026-10-29). The scam-cleanup `commentsV2`
      kind also hides comments on CommentV3-write surfaces
- [ ] The v3 write path's edits stamp `CommentV3."updatedAt"` explicitly in SQL (no trigger does):
      `new-mention` re-emits for a mention added by editing only when it moves. Built 2026-10-29,
      awaiting the stage B deploy
- [ ] Text-scan `CommentV3` profile (`comment-v3.profile.ts`) + entity type in
      `mode.ts`/`types.ts`/`retention.ts`, `SCAM_ENTITY_TYPES` with a v3 cleanup, the
      `csam-hold-decision.ts` case, and `ReportEntity.CommentV3` with its `report.service.ts` maps
      (`CommentV3Report` keys on `commentId`, so `findReportToFoldInto` has a case like
      `User`'s). `CommentV3` follows `CommentV2`'s rollout until given its own. Built 2026-10-29,
      awaiting the stage B deploy
- [ ] Legal holds on CommentV3 follow the CommentV2 rules (decided 2026-10-30): deletes keep a held
      comment as a ToS violation, marked `removedByAuthor` when its author removed it
      (`20261217120000_comment_v3_removed_by_author`, to apply before the deploy); a ToS restore
      leaves those hidden; an article with a held author's CommentV3-only comment is kept (delete
      refused, a wipe takes it down as a violation). Built for article 2026-10-30, awaiting the
      stage B deploy
- [ ] Per surface, at its write flip: the parent's delete refuses, and the account wipe keeps the
      parent, while a held author has a live CommentV3-only comment under it, as
      `heldCommentV3OnArticleSql` does for articles (generalise it by `entityType` rather than
      copying it)
- [ ] Clavata path, so `CommentV3` is moderated exactly as `CommentV2` is (decided 2026-10-30):
      `EntityType` value `CommentV3` + `trg_moderation_commentv3`, firing only on direct writes
      (`20261211120000_comment_v3_moderation_trigger`, applied in prod 2026-10-30 in the same
      enabled state as `trg_moderation_commentv2`), the `entity-moderation.ts` queue and auto-mute
      cleanup, and a `CLAVATA_TARGETS` entry owned on `CommentV2`'s rollout. Built for article
      2026-10-30, awaiting the stage B deploy; after it,
      `POST /api/admin/temp/text-scan-clavata-cutover` (`{action:'disable', entityType:'CommentV3'}`)
      wherever `CommentV2` is cut over

Surface-specific extras:

- [ ] **article/post**: purge `articleStatCache` / `postStatCache` after count recompute. Article:
      nothing to add, the article metrics job already counts from CommentV3 and purges it (checked
      2026-10-29); post still to do
- [ ] **image**: re-point the `EntityMetric` (`metricType='Comment'`) writer (the judge gate and
      `getJudgeCommentForImage` read CommentV3 since Phase 3)
- [ ] **comicChapter**: `ChapterComments.tsx` client shape change (drops `parentThreadId`;
      `entityId` becomes `ComicChapter.id`, returned by `getChapterThread`); `createChapterComment`
      is removed and chapter comments write through the `commentv3` mutations (decided 2026-10-30)
- [ ] **crucible**: `getCommentThreadCrucibleId` + `new-crucible-comment` notification
- [ ] **storyline**: `getCommentThreadStorylineId` / `getCommentStorylineId` +
      `new-storyline-comment` notification
- [ ] **model** (last): model discussion UI moves onto the unified provider (display depth 1, same
      presentation); client reaction entityType `commentOld` → `comment`; v1 replica-lag pinning
      (`getDbWithoutLag('commentModel')`) retired or ported. The v1 write path also gates on
      `Model.locked` and `Model.meta.commentsLocked` (`comment.router.ts`), neither of which
      reaches `CommentTopic.locked`: the toggles also set `CommentTopic.locked`, so the one v3 lock
      check covers models, and the v1 writes are removed rather than ported (decided 2026-10-30); the v1 reply counts in `comment.controller.ts` read CommentV3; the three
      model-page processors (`new-comment`, `new-comment-response`, `new-comment-nested`) gain
      `notCommentMuted` once the page has a mute control, and `no-unmuteable-comment-processor`'s
      `MODEL_ONLY` set empties
- [ ] `commentOld` reaction type removed after model flip soaks

Order (decided 2026-10-30): article writes (stage B), then every other surface's read flip with
the remaining cross-surface readers in one PR, then the old-row sync removed, then the other
surfaces' write flips one at a time with no sync (`docs/plans/comments-v3-article-flip.md`).

- [ ] Old-row sync removed once every reader is on CommentV3: `syncOldRows` in
      `commentv3/write.service.ts` and its callers

**Gate:** every surface reading+writing CommentV3; old tables receiving no new rows.

## Phase 5 — Post-flip cleanup

- [ ] One-off purge of the old-table orphans the backfill skipped (found 2026-10-21; the FK
      cascades predate them, nothing renders them, and the teardown would drop them anyway, so
      this only tidies the old side before Phase 6): v2 comments whose `Thread` row is gone (with
      their reactions, report links and the reply threads hanging off them), the dead-parent reply
      threads and their comments, and v1 replies whose parent is gone. Verify the counts first,
      then delete in this order, all under the live mirror (none has a v3 row, so the mirror's
      delete is a no-op):

      ```sql
      -- 1. sizes (replica)
      WITH orphan AS (SELECT c.id FROM "CommentV2" c WHERE NOT EXISTS (SELECT 1 FROM "Thread" t WHERE t.id = c."threadId"))
      SELECT (SELECT count(*) FROM orphan) AS comments,
       (SELECT count(*) FROM "Thread" WHERE "commentId" IN (SELECT id FROM orphan)) AS reply_threads,
       (SELECT count(*) FROM "CommentV2" WHERE "threadId" IN (SELECT id FROM "Thread" WHERE "commentId" IN (SELECT id FROM orphan))) AS replies_under_them,
       (SELECT count(*) FROM "Thread" t WHERE t."commentId" IS NULL AND t."parentThreadId" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "CommentV2" c JOIN "CommentV3" v ON v.id = c.id WHERE c."threadId" = t.id)) AS dead_parent_threads,
       (SELECT count(*) FROM "CommentV2" c JOIN "CommentV3" v ON v.id = c.id JOIN "Thread" t ON t.id = c."threadId"
         WHERE t."commentId" IS NULL AND t."parentThreadId" IS NOT NULL) AS dead_parent_mirrored,
       (SELECT count(*) FROM "Comment" c WHERE c."parentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Comment" p WHERE p.id = c."parentId")) AS v1_dead_parent;
      -- 2. the reply threads under the orphans (cascades their comments and child threads)
      DELETE FROM "Thread" WHERE "commentId" IN (SELECT c.id FROM "CommentV2" c WHERE NOT EXISTS (SELECT 1 FROM "Thread" t WHERE t.id = c."threadId"));
      -- 3. the orphans themselves (cascades reactions and report links)
      DELETE FROM "CommentV2" c WHERE NOT EXISTS (SELECT 1 FROM "Thread" t WHERE t.id = c."threadId");
      -- 4. dead-parent reply threads holding no mirrored reply (cascades their comments); these recur
      --    while the old write path is live
      DELETE FROM "Thread" t WHERE t."commentId" IS NULL AND t."parentThreadId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "CommentV2" c JOIN "CommentV3" v ON v.id = c.id WHERE c."threadId" = t.id);
      -- 5. v1 replies whose parent is gone
      DELETE FROM "Comment" c WHERE c."parentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Comment" p WHERE p.id = c."parentId");
      ```

      Steps 2, 3 and 5 only touch rows with no v3 row. Step 4 skips any thread holding a mirrored
      reply; if `dead_parent_mirrored` is nonzero, decide those by hand, because deleting them would
      remove comments still live in v3. Re-run `unmirrored` afterwards: `v2_no_thread` and
      `v1_dead_parent` read zero, `v2_dead_parent` holds only the mirrored replies left by hand, and
      `v2_unresolved_entity` drops to the question/answer threads alone

(The read-side re-points that used to live here run in Phase 3 — see above. The purge above is
safe at any time; everything below requires old write paths to be gone.)

Notifications:

- [x] `comment.detail-fetcher.ts` reads every version from CommentV3 since Phase 3, so a takedown
      after a write flip still hides old previews: a model-page row (versionless, one of the
      three model-page types, or a `new-thread-response`/`new-mention` with no `threadType`) by
      `legacyV1Id`, anything else by id (permanent shim)
- [ ] Verify the detail fetcher against real historical notification rows of each version
- [ ] Consolidate the per-entity notification queries into one parameterized builder — **no longer
      optional**: one builder is one place the mute filter can go missing, instead of 14

Event-engine / metrics:

- [ ] CDC handler `comment-v3.ts` counts every comment on a `v3WriteSurfaces` surface, whichever
      table it was written to; `comment-v2.ts` skips those surfaces, so either service can deploy
      first (a test pins `COMMENT_V3_SURFACES` to `v3WriteSurfaces`). The old handlers retire in
      Phase 6. Code built 2026-10-29: `REPLICA IDENTITY FULL` (`scripts/sql/replica-identity.sql`),
      `public.CommentV3` in `apps/event-engine/src/config/index.ts` (the Debezium manager updates
      the connector's `table.include.list`, the filtered publication and creates the topic from
      that list), `postgres.CommentV3` in `scripts/create-kafka-topics.ts`. `REPLICA IDENTITY FULL` applied in prod 2026-10-30. Still to provision before the stage B deploy: the topic and
      the CDC role's read access (infra owner), then the event-engine release
- [ ] `ModelMetric.commentCount` stays **distinct commenters** — verify post-cutover
- [ ] Comment-count event continuity verified (feeds `update-user-score.ts`, search indexes,
      stat caches); full search reindex only if a count source moved discontinuously
- [ ] ClickHouse tracking sends explicit entityType + comment id; readers match old
      `Comment_*`/`CommentV2_*` literals alongside `CommentV3_*`
      (`creator-studio/analytics.ts`, `analytics-detail.ts`)

Main app cleanup:

- [ ] Unified exclusion helper (hidden/blocked/blockedBy + owner exemption) replaces the v1/v2 copies
- [ ] Reaction enum/controller collapse (`'commentOld'` accepted one extra release)
- [ ] `ReportEntity` collapse (both values accepted one extra release); `ReportModal.tsx`. Three
      values by then (`comment`, `commentV2`, `commentV3`); the ClickHouse `reports.entityType` enum
      keeps `commentV3 = 22` (`2026-10-29-comment-v3-report-entity.sql`)
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

- [ ] `src/server/common/thread-chain.ts` deleted with the last v2 write path:
      `block-check.service.ts` (`threadAncestorsCte`), `block-hide-comments.service.ts`
      (`seededThreadChainCte`) and `throwIfThreadChainLocked` move to `path @>` or go

Moderator app cleanup (reads moved in Phases 3 and 4; this is the write/UX side):

- [ ] `report-entities.ts` drops the old `Comment`/`CommentV2` entries, leaving the `CommentV3` one
- [ ] `entity-url.ts` single builder; `CommentsPanel.svelte` single checkbox list
- [ ] `queue-thresholds.ts` key migration (don't zero thresholds); `src/lib/reports.ts` labels
- [ ] `getCommentFlags()` extended from model comments to all comments, and the mod team told:
      flag counts rise
- [ ] Hand-off: moderator-DB `ModerationQueueMetrics.Comment/CommentV2` columns → external job owner

Tooling / tests:

- [ ] `scripts/local-dev/gen_seed.ts` rewritten for new tables
- [ ] ~20 test files' mock shapes updated; SQL-assertion tests (`reports.sql.test.ts`,
      `reports.queries.explain.test.ts`) re-authored; `tests/preview-engagement.spec.ts` green

**Gate:** zero code paths query the old tables (grep proves it); notifications + metrics verified
continuous across the cutover.

## Phase 6 — Contract (teardown)

### Transition code to remove

Everything written only because the old tables exist or because surfaces flip one at a time, and
not already a Phase 5 item (its main-app and moderator-app collapses, `thread-chain.ts`, the
per-surface UI mounts). Remove it before the table drops below. Closing condition: each removed
symbol greps empty in `src/`, `apps/` and `scripts/` (for an item that moves or loses only an arm,
the named arm is gone), and the transition-only tests are gone with them.

After the last surface's write flip has soaked:

- [ ] Surface switches: `constants.comments.v3ReadSurfaces` (and the `deepLinkParentId` CASE in
      `comment.notifications.ts` collapses to `parentId`), `v3WriteSurfaces`, `isV3WriteSurface` and
      `v3WriteSurfaceSql` (in `commentv3/write.service.ts`), the v2 arm of `CommentsV3/useCommentMutations.ts`, the report-entity
      pick in `CommentsV3/CommentItem.tsx`, and the `!isV3WriteSurface` refusal in
      `commentv3.controller.ts`
- [ ] Old-endpoint refusal: `isV3WriteTarget` and `V3_WRITE_TARGET_MESSAGE` (in
      `commentv3/write.service.ts`), `throwIfV3WriteTarget` and its call sites in
      `commentsv2.service.ts`
- [ ] Thread lock on the v3 router: `toggleLockCommentsThread` / `getCommentsThreadDetails2`'s
      CommentTopic arm moves there, and the article stops mounting
      `CommentsV2/ToggleLockComments` (mutes are the Phase 5 router item)
- [ ] Reverse copy: `comment-v3-reverse-copy.service.ts`, the `reverse*` steps of
      `api/admin/temp/comment-v3-backfill.ts`, and `comment-v3-reverse-copy.sql.behavior.test.ts`

With the old tables (before the drops below):

- [ ] Old arms beside a v3 one: `block-check.service.ts` (`ownersForCommentV2`,
      `threadAncestorsCte`, and the `v3Comment` fallback becomes the only path);
      `user.service.ts` account wipe (`commentV2Reaction.deleteMany`, the CommentV2 delete) and
      ban (its CommentV2 update, `setUserCommentsV3Tos` and `v3SurfaceCommentIds`);
      `comment.service.ts` bulk delete's `v3Ids` split and `deleteCommentsV2UnlessHeld`;
      `v3WriteCommentIds` and the v3 split in `bulkSetCommentV2TosViolation` /
      `bulkClearCommentV2TosViolation`; `scam-cleanup.service.ts` CommentV2 arms and
      `setV3SurfaceHidden`; `reaction.service.ts` `isV3WriteComment` and the CommentV2 toggle arm
      it routes around; `reaction.controller.ts`'s CommentV2 tracking read (keep the CommentV3
      one); the `goodContent.reward.ts` `CommentV3` special case; the v3 arms of
      `getThreadMuted`, `toggleThreadMute` and `toggleSectionMute`;
      `events/points/hooks.ts` `onCommentCreated`'s `threadId` arm; `hasV3SurfaceTwinSql` and its
      exclusions (ban, wipe, scam cleanup, block-hide); the `CommentTopic` delete ahead of the
      article in `article.service.ts` `deleteArticleById` and in the account wipe (the entity
      cascade covers it), and the `detachHeldThreadsSql` calls there; `heldCommentV3OnArticleSql`
      (`commentv3/moderation.service.ts`) loses its `CommentV2` twin clause and stays as the
      refusal; `bulkClearCommentV3TosViolation` loses its `CommentV2` `metadata.removedByAuthor`
      check, and `deleteCommentsV3UnlessHeld` its `CommentV2` mark
- [ ] Text-scan: `comment.profile.ts` and `comment-v2.profile.ts`, the `Comment`/`CommentV2` cases in
      `csam-hold-decision.ts` and the Clavata cutover set, `scam.adapter.ts`'s
      `CommentV3: 'commentsV2'` cleanup kind, and `mode.ts`'s fallback from `CommentV3` to the
      `CommentV2` rollout (give `CommentV3` its own first)
- [ ] Event engine, in one release: `handlers/comments.ts` and `comment-v2.ts` and their
      `handlers/index.ts` entries, with `COMMENT_V3_SURFACES` (remove it only with
      `comment-v2.ts`: `comment-v3.ts` then counts every comment, so `comment-v2.ts` would
      double-count) and
      `src/server/common/__tests__/comment-v3-surfaces.parity.test.ts`; `public.Comment`/`public.CommentV2` in `config/index.ts`,
      `scripts/create-kafka-topics.ts` and `scripts/sql/replica-identity.sql`; the Kafka topics
- [ ] Old main-app files: `comment.router.ts`, `commentv2.router.ts`, `comment.controller.ts`,
      `commentv2.controller.ts`, `comment.schema.ts`, `commentv2.schema.ts`,
      `commentsv2.service.ts`, `commentsv2.reply-threads.ts`, the old arms of `comment.service.ts`,
      `comment.selector.ts`, `commentv2.selector.ts`, and the `components/CommentsV2/` and
      `components/CommentSection/` folders
- [ ] Moderator app: `withoutOldCommentLink` / `linkFilter` in `report-entities.ts` and its
      `reportLinkFilter` call sites; the `commentV3` label in `src/lib/reports.ts` and the
      `CommentV3` label in `routes/csam/text-holds/hold-entity.ts` become 'Comment' (labels key the
      lists, so drop the `Comment`/`CommentV2` entries in the same change); the `Comment`/`CommentV2` cases in
      `routes/csam/text-holds/hold-entity.ts` and `hold-context.server.ts`, `scam-review.ts`,
      `user-lookup.service.ts` and `user-account.service.ts`
- [ ] Backfill and parity: `comment-v3-backfill.service.ts` and
      `api/admin/temp/comment-v3-backfill.ts`; `jobs/comment-v3-parity.ts`, its registration in
      `api/webhooks/run-jobs/[[...run]].ts`, the `comment-v3-parity:last` KeyValue row and the
      `comment_v3_parity_finding` gauge
- [ ] Transition-only tests: `comment-v3-backfill.sql.behavior`, `comment-v3-mirror.sql.behavior`,
      `commentv3/__tests__/scam-cleanup.sql.behavior` (drop the v2 cases and the mirror migrations,
      keep the v3-only hide and restore cases),
      `comment-v3-parity-verdict`, `jobs/__tests__/comment-v3-parity`; the refusal and routing cases
      in `commentsv2.threadMute.service.test.ts`; the v2 arms of the bulk-delete and
      remove-all-content legal-hold behaviour tests; and the mirror schema `comment-v3-fixture.ts`
      loads

### Database teardown

- [ ] 🔴 **Verify `CommentMute` + `CommentTopicMute` are populated BEFORE dropping `Thread`** —
      `ThreadMute_threadId_fkey` is `ON DELETE CASCADE`, so the teardown deletes every mute a user
      ever set, silently
- [ ] Before any table drop: drop the Phase 2 mirror triggers (all named `commentv3_mirror`) and the
      functions that take old-table row types as parameters (`commentv3_thread_entity`,
      `commentv3_mirror_v1`, `commentv3_mirror_v1_one`, `commentv3_mirror_v2`,
      `commentv3_mirror_v2_one`) — `DROP TABLE` fails while they exist
- [ ] Drop order: `ThreadMute` → `CommentReaction`/`CommentV2Reaction`/`CommentReport`/
      `CommentV2Report` → `Comment`/`CommentV2` → `Thread`
- [ ] Drop triggers `comment_count_update` (function `update_thread_comment_count`),
      `trg_moderation_comment`, `trg_moderation_commentv2`, `comment_reaction_count_update`, and
      the remaining `commentv3_*` functions the mirror migration created (`ensure_topic`,
      `clamp_parent`, `v1_id_floor`, `mirror_delete` and the eight `mirror_*_trigger` functions)
- [ ] Remove any remaining Thread entries from `schema-drift/drift-baseline.json` + update
      remediation plan and `production-plan.test.ts`
- [ ] `DROP SCHEMA archive CASCADE` (the ten purge-archive tables) once the old tables are gone
- [ ] `EntityType` values `Comment`/`CommentV2` **left in place** (read-time aliases only)
- [ ] `job-queue.ts` unused mappings deleted; schema reverse-relations cleaned;
      `db:generate` + `db:check-generated` clean
- [ ] Plan doc + this checklist marked complete; `docs-drift-review` over the final diff

**Gate:** prod schema contains no old comment tables; drift gate green; full unit suite green.
