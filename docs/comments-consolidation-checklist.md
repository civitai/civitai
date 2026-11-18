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
      root thread's on the entity). The v2 toggles are deleted (built 2026-11-05, release 2, deployed by 2026-11-10):
      `commentv3/section.service.ts` writes `CommentMute`, `CommentTopicMute` and the topic lock
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
      the count trigger to avoid it (see the Phase 3 intro): live mirrored counts would be lost.
      The endpoint and `comment-v3-backfill.service.ts` were removed in Phase 5
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
      `v2_pending_unexplained` / `v1_pending_unexplained`, the two the monitor pages on. Prod holds two such classes: 8,531 v2
      comments (ids 1857994–1868035, 2026-02-27 to 03-01) bulk-rewritten around 03-01 without their
      `Thread` rows, which no FK cascade explains (not archived: they go with the Phase 6 drops,
      decided 2026-11-03), with 4,409
      reactions, and 2 v1 replies whose parent comment is gone; none of them can
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
      when the job itself fails. A stretch of days without an alert is the gate below. Since the
      model flip every surface writes CommentV3, so the old-side presence checks (`v2_ghosts`,
      `thread_count_mismatch`, the `*_extra` links) count new rows and are recorded, not paged.
      Retired in Phase 5: the job, its registration and the gauge are removed
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
      skipped classes. Retired in Phase 5: the reverse copy is removed, and with `syncOldRows` gone
      there is no rollback path to the old tables
- [ ] Reverse-copy proven on a prod sample: run the `reverse*` steps against a copy of prod with a
      few thousand v3-only writes of each kind (comment, reply, edit, lock, delete, reaction, report
      link, mute) and confirm `parity` reads zero — the Phase 3 gate's last clause. Retired in
      Phase 5 without being run: the reverse copy is removed, so there is nothing left to prove

Re-point cross-surface **readers** at CommentV3 while dual-write keeps it complete (dual-write is
one-directional, so any reader left on the old tables goes blind the moment a surface's writes
flip — these MUST land before the first Phase 4 write flip):

- [x] All notification `prepareQuery`s read CommentV3 (the comment family, `new-mention`, the
      comment reaction milestone on `CommentV3Reaction`, and `report-actioned`'s
      `CommentV3Report` arm); new notifications write `details.version: 3`, and the detail fetcher
      reads CommentV3 for them (tombstones excluded like takedowns). Model-page comments keep the
      v1 permalink and `comment:v1:` dedupe namespace, with the parent and milestone ids as
      `modelPageId` (`COALESCE(legacyV1Id, id)`) so a renumbered comment does not re-announce;
      since the model flip they write `version: 4` (`docs/plans/comments-v3-model-flip.md`). `new-thread-response` and
      `new-mention` are one CommentV3 query each; thread participants are the comment's siblings
- [x] 🔴 The mute filter is carried to every comment-family processor but `new-mention` (exempt by
      decision) and `new-comic-comment` (written by `createNotification`, out of the guard's reach)
      as `notCommentMuted` (a `CommentTopicMute`
      probe plus a `CommentMute` join on `path @>`, and the clamped `replyToId`).
      `thread-chain.ts` is NOT deleted: the block-check write guard and the block hide sweep still
      walk the old thread chain (the v2 lock check went with the v2 write path, built 2026-11-05, release 2, deployed by 2026-11-10),
      and they go in Phase 5
- [x] `no-unmuteable-comment-processor` re-pointed at the v3 SQL in the same change, keeping the
      `new-mention` exemption; it also pins that no comment-family query reads an old table.
      Verified red with the filter removed from `new-image-comment`. The three model-page
      processors were exempt (`MODEL_ONLY`) until the model flip (built 2026-11-06); they filter
      `notCommentMuted` now
- [x] `getThreadMuted` / `getSectionMuted` read the suppression's own predicate
      (`notCommentMuted`, and `CommentTopicMute` for the section), so the menu label cannot diverge
      from behaviour. The v2 lookups went with the v2 toggles (built 2026-11-05, release 2, deployed by 2026-11-10);
      `commentv3/section.service.ts` is the only implementation
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
      question and answer jobs had no entity type and were removed with the feature
- [x] `daily-challenge-processing.ts` judge gate (both reads), `getJudgeCommentForImage`
- [x] `collection.service.ts` judged check; `challenge.service.ts`'s four comment counts and
      `resourceReview`'s two count top-level live comments on CommentV3. Not
      `CommentTopic.commentCount`: that counts replies and tombstones, so the numbers shown would jump
- [x] `/comments/[id].tsx` (canonical; `/comments/v2/[id].tsx` is an alias of it) resolves from the
      CommentV3 row (`comment-permalink.ts`); a tombstone 404s
- [x] **(review)** `events/points/hooks.ts` counts the actor's remaining comments on CommentV3
      (its thread lookup went with the v2 write path: built 2026-11-05, release 2, deployed by 2026-11-10);
      `creator-score-self-activity.service.ts` and `bot-account-detection/cohort.ts` read
      CommentV3 (the v1 and v2 comment reads, visible and membership each, became one pair). Left for Phase 4, as writes:
      `scam-cleanup.service.ts` (hide and restore are UPDATEs), the reaction toggle reads, and
      `assertCommentEntityVisible` / `getCommentThreadBounty` / `getCommentThreadCrucibleId` /
      the storyline lookups, which guard v2 writes on the thread they are given

Not on this list, each a surface's own read that moves with it:
`entity-moderation.ts`'s selectors (Phase 4, first write flip) and the event-engine comment
handlers (Phase 5 CDC item, provisioned before the first write flip). Accepted, not changed: a mute
on a comment past the depth cap reaches a clamped reply that answers it directly, not a reply to
that reply (`replyToId` is one hop); a write the mirror yields on and a later backfill pass
copies keeps its original `createdAt`, so it is behind every notification and metrics cursor and
sends nothing.

**Gate:** backfill converged and re-run once more after the monitor's last drift (a write that
yielded to a `SKIP LOCKED` conflict whose delete then rolled back stays unmirrored until a pass finds
it); N days without a `comment-v3-parity` alert; no read-only cross-surface reader still queries
the old tables (the exceptions named above, the report-queue joins, `csam-holds.queries.ts`, the
reaction toggle reads and `thread-chain.ts` (block guard and hide sweep), move with the first write
flip or the v2 write path); the `CommentV3."createdAt"` and `CommentV3Reaction."createdAt"` indexes
(`20261125120000_comment_v3_created_at_indexes`, applied by hand) are on prod before the re-point
deploys; reverse-copy proven on a prod sample.

## Phase 4 — Per-surface flips (no flags: reads in one deploy, writes in a later one)

Repeat this block per surface, in the Phase 0 order (model **last**):

- [ ] Notification deep links switch `commentParentId` from `replyToId` to `parentId` with the read
      flip: under v3 reads a clamped reply hangs off its parent (article: live; every other surface
      but model: built 2026-11-02, awaiting deploy; model: built 2026-11-06; see
      `docs/plans/comments-v3-article-flip.md`, "Read flip as built")
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
      kind also hides comments on CommentV3-write surfaces (renamed `comments` in Phase 5)
- [ ] The v3 write path's edits stamp `CommentV3."updatedAt"` explicitly in SQL (no trigger does):
      `new-mention` re-emits for a mention added by editing only when it moves. Built 2026-10-29,
      awaiting the stage B deploy
- [ ] Text-scan `CommentV3` profile (`comment-v3.profile.ts`) + entity type in
      `mode.ts`/`types.ts`/`retention.ts`, `SCAM_ENTITY_TYPES` with a v3 cleanup, the
      `csam-hold-decision.ts` case, and `ReportEntity.CommentV3` with its `report.service.ts` maps
      (`CommentV3Report` keys on `commentId`, so `findReportToFoldInto` has a case like
      `User`'s). `CommentV3` has its own rollout (since 2026-11-10; it followed `CommentV2`'s until then). Built 2026-10-29,
      awaiting the stage B deploy
- [x] No legal holds on comments (decided 2026-11-04, Briant, on the CSAM reviewer's word): every
      comment delete is a plain delete and an entity's delete takes its comments with it, on every
      table. A reported user's comments are kept as evidence in the CSAM report archive instead
      (`userContentSections` in `csam.service-new.ts`). `CommentV3.removedByAuthor` is dropped by the
      Phase 6 migration; `Comment`'s copy goes with that table
- [ ] Clavata path, so `CommentV3` is moderated exactly as `CommentV2` is (decided 2026-10-30):
      `EntityType` value `CommentV3` + `trg_moderation_commentv3`, firing only on direct writes
      (`20261211120000_comment_v3_moderation_trigger`, applied in prod 2026-10-30 in the same
      enabled state as `trg_moderation_commentv2`), the `entity-moderation.ts` queue and auto-mute
      cleanup, and a `CLAVATA_TARGETS` entry owned on `CommentV3`'s own rollout (`CommentV2`'s until 2026-11-10). Built for article
      2026-10-30, awaiting the stage B deploy; after it,
      `POST /api/admin/temp/text-scan-clavata-cutover` (`{action:'disable', entityType:'CommentV3'}`)
      wherever `CommentV2` is cut over

Surface-specific extras:

- [ ] **article/post**: purge `articleStatCache` / `postStatCache` after count recompute. Article:
      nothing to add, the article metrics job already counts from CommentV3 and purges it (checked
      2026-10-29); post still to do
- [x] **image**: the `EntityMetric` (`metricType='Comment'`) writer is re-pointed: the image entry in
      `commentv3/surfaces.ts` writes it on a v3 create, as v2 did (built 2026-11-04, release 1, deployed
      by 2026-11-10). The judge gate and `getJudgeCommentForImage` read CommentV3 since Phase 3
- [x] **comicChapter**: reads built 2026-11-03 (`CommentSection` on the comics page keyed by
      `ComicChapter.id`; `getChapterThread` removed). `createChapterComment` is removed and chapter
      comments write through the `commentv3` mutations, with block-hide resolving the chapter's
      owner through its project (decided 2026-10-30; built 2026-11-05, release 2, deployed by 2026-11-10)
- [ ] **crucible**: `getCommentThreadCrucibleId` + `new-crucible-comment` notification
- [ ] **storyline**: `getCommentThreadStorylineId` / `getCommentStorylineId` +
      `new-storyline-comment` notification
- [x] **model** (last): reads and writes in one release (built 2026-11-06, deployed by 2026-11-10;
      `docs/plans/comments-v3-model-flip.md`). The masonry cards and thread dialog read
      `commentv3` and every write goes through it; the v1 `comment` router is deleted. The model
      surface gates reads on the model's visibility and writes on `Model.locked`,
      `Model.meta.commentsLocked` (which v1 left to the page, which only hides the discussion) and a
      published version (with exactly one, the writer needs access to it, for early access). A pre-flip comment's v1 row stayed in step
      (`syncOldRows`, removed in Phase 5). The three model-page processors filter `notCommentMuted` and address a
      comment by `modelPageId`; `MODEL_ONLY` is gone. Replies, thread responses and mentions
      filter `notOnHiddenModel`: on an unpublished or POI model they reach at most the owner. The event engine counts model comments from
      CommentV3; deploy it before or with the main app (until it runs, a v3-only model comment is
      missed by the owner's `UserMetric.commentCount` for good). The section leaves hidden comments
      out (`leavesOutHiddenComments`; the first page returns `counts: { visible, hidden }`) and
      `HiddenCommentsModal` shows them (`hidden: true`)
- [x] `commentOld` reaction type removed (with the model flip rather than after its soak, built
      2026-11-07; a v1 comment id has no reaction path left)

Order (decided 2026-10-30, revised 2026-11-03): article writes (stage B), then every other
surface's read flip with the remaining cross-surface readers in one PR, then every other surface's
write flip at once in two releases (`docs/plans/comments-v3-write-flip.md`), model comments last.
The old-row sync stayed until Phase 5, which removed it.

**Gate:** every surface reading+writing CommentV3.

## Phase 5 — Post-flip cleanup

- [x] One-off purge of the old-table orphans the backfill skipped (found 2026-10-21; the FK
      cascades predate them, nothing renders them, and the teardown would drop them anyway, so
      this only tidies the old side before Phase 6): v2 comments whose `Thread` row is gone (with
      their reactions, report links and the reply threads hanging off them), the dead-parent reply
      threads and their comments, and v1 replies whose parent is gone. Run it after the Phase 5
      deploy: migration `20270101120000_comment_v3_old_table_triggers_off` drops the mirror, so
      these deletes touch only the old tables. Verify the counts first, then delete in this order:

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
      -- 4. dead-parent reply threads holding no mirrored reply (cascades their comments); nothing
      --    writes the old tables any more, so these no longer recur
      DELETE FROM "Thread" t WHERE t."commentId" IS NULL AND t."parentThreadId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "CommentV2" c JOIN "CommentV3" v ON v.id = c.id WHERE c."threadId" = t.id);
      -- 5. v1 replies whose parent is gone
      DELETE FROM "Comment" c WHERE c."parentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Comment" p WHERE p.id = c."parentId");
      ```

      Steps 2, 3 and 5 only touch rows with no v3 row. Step 4 skips any thread holding a mirrored
      reply; with the mirror dropped, deleting one would remove only the old copies, not the v3
      rows, so those can be decided by hand or left for the Phase 6 drops. The `unmirrored` report
      went with the backfill endpoint, so re-run step 1 afterwards: `comments`, `reply_threads`,
      `dead_parent_threads` and `v1_dead_parent` read zero. Done on prod 2026-11-10: all four read
      zero; `dead_parent_mirrored` is left for the Phase 6 drops

(The read-side re-points that used to live here run in Phase 3 — see above. The purge above is
safe at any time; everything below requires old write paths to be gone.)

Notifications:

- [x] `comment.detail-fetcher.ts` reads every version from CommentV3 since Phase 3, so a takedown
      after a write flip still hides old previews: a model-page row (versionless, one of the
      three model-page types, or a `new-thread-response`/`new-mention` with no `threadType`) by
      `legacyV1Id`, anything else by id (permanent shim)
- [ ] Verify the detail fetcher against real historical notification rows of each version
- [x] Consolidate the per-entity notification queries into one parameterized builder — **no longer
      optional**: one builder is one place the mute filter can go missing, instead of 14. Moved to
      Phase 5.5 (below)

Event-engine / metrics:

- [x] CDC handler `comment-v3.ts` counts the comments of every surface in its `SURFACES` map
      (crucible and storyline deliberately not counted, as before); `comment-v2.ts`,
      `COMMENT_V3_SURFACES` and its parity test are removed (Phase 5, built 2026-11-09, deployed
      by 2026-11-10; deploy the event engine with the main app). Code built 2026-10-29: `REPLICA IDENTITY FULL` (`scripts/sql/replica-identity.sql`),
      `public.CommentV3` in `apps/event-engine/src/config/index.ts` (the connector's
      `table.include.list`; tables are added to the publication by hand),
      `postgres.CommentV3` in `scripts/create-kafka-topics.ts`. CDC live in prod 2026-11-02:
      generated columns published, `REPLICA IDENTITY FULL`, table in the publication. Apply any
      change only through the script: without the published generated columns, Postgres 18
      refuses every write to the table
- [x] `ModelMetric.commentCount` stays **distinct commenters** — verified on prod 2026-11-10, after
      the batch-range fix (#8409) and its recount: every row matches a live distinct-commenter count
- [ ] Comment-count event continuity verified (feeds `update-user-score.ts`, search indexes,
      stat caches); full search reindex only if a count source moved discontinuously
- [ ] ClickHouse tracking sends explicit entityType + comment id; readers match old
      `Comment_*`/`CommentV2_*` literals alongside `CommentV3_*`
      (`creator-studio/analytics.ts`, `analytics-detail.ts`)

Main app cleanup:

- [x] Unified exclusion helper (hidden/blocked/blockedBy + owner exemption) replaces the v1/v2
      copies. Moved to Phase 5.5 (below)
- [x] Reaction enum/controller collapse: `'commentOld'` removed with the model flip (built 2026-11-07)
- [x] `ReportEntity` collapse; `ReportModal.tsx`: `comment` and `commentV2` are removed and new
      reports on them are refused (Phase 5, built 2026-11-09, deployed by 2026-11-10; old report rows keep their
      type). The ClickHouse `reports.entityType` enum keeps `commentV3 = 22`
      (`2026-10-29-comment-v3-report-entity.sql`)
- [x] `goodContent.reward.ts` `typeToTable`, `src/utils/buzz.ts` labels,
      `src/utils/string-helpers.ts` entries: they name the `CommentV2` Buzz entity type, which stays
      (Group B, below)
- [x] `resourceReview.service.ts` drops its eager `thread: { create: {} }` on review creation, and
      a review's comment count reads CommentV3 (Phase 5, built 2026-11-09, deployed by 2026-11-10)
- [ ] `strikes.tsx` URL map (+ fix its pre-existing dead `/comments/<id>` link)
- [x] Mute UI ported: per-comment overflow item (`CommentsV3/CommentItem.tsx`) and section mute
      (`CommentsV3/useSectionMute.tsx`), on `commentv3` (built 2026-11-05, release 2, deployed by 2026-11-10)
- [ ] Mute copy says "thread": restate for exact subtree semantics
- [x] `commentv2.router` mute procedures move to the v3 router, keeping one shared rate-limit
      budget (`commentv3:mute`, was `commentv2.mute`; done early: built 2026-11-05, release 2, deployed by 2026-11-10)
- [x] Mod endpoints `bulk-delete`/`remove-as-tos`/`restore-from-tos` take `commentIds` (one list of
      CommentV3 ids) and return `{ deleted }` / `{ comments }` (Phase 5, built 2026-11-09, deployed
      by 2026-11-10; deploy the moderator app with the main app)

- [x] `src/server/common/thread-chain.ts` deleted: `throwIfThreadChainLocked` went with the v2
      write path (built 2026-11-05, release 2); `block-check.service.ts` and
      `block-hide-comments.service.ts` read CommentV3 alone (Phase 5, built 2026-11-09, deployed by 2026-11-10)

Moderator app cleanup (reads moved in Phases 3 and 4; this is the write/UX side):

- [x] `report-entities.ts` drops the old `Comment`/`CommentV2` entries, leaving the `CommentV3` one;
      the comment queue is `/reports/comment` (Phase 5, built 2026-11-09, deployed by 2026-11-10)
- [x] `entity-url.ts` single builder (`commentUrl`); `CommentsPanel.svelte` single list
- [x] `queue-thresholds.ts` key migration (`report:commentV3` reads the `comments` thresholds);
      `src/lib/reports.ts` labels
- [ ] User Lookup's comment count and ToS/hidden flags cover every surface (built 2026-11-09, deployed
      by 2026-11-10); left: tell the mod team the counts rise
- [ ] Hand-off: moderator-DB `ModerationQueueMetrics.Comment/CommentV2` columns → external job owner

Tooling / tests:

- [x] `scripts/local-dev/gen_seed.ts` rewritten for new tables (Phase 5, built 2026-11-09)
- [ ] ~20 test files' mock shapes updated; SQL-assertion tests (`reports.sql.test.ts`,
      `reports.queries.explain.test.ts`) re-authored; `tests/preview-engagement.spec.ts` green. Done
      (built 2026-11-05 and 2026-11-09, deployed by 2026-11-10): the mock shapes and the SQL-assertion tests,
      and the Playwright specs (`tests/example.spec.ts`, `tests/preview-engagement.spec.ts`) call
      `commentv3.create`/`delete`. Left: run the Playwright specs green

**Gate:** zero code paths query the old tables (grep proves it); notifications + metrics verified
continuous across the cutover.

The old-table readers left through Phase 5 (the personal-data export, reaction erasure, the CSAM
comment archive `archiveUserComments` and hold context text `csam-context-text.ts`, and the
`comment-v3-mirror.sql.behavior` test and the old-row case in `commentv3/__tests__/write.sql.behavior`)
are removed in Phase 6 (`docs/plans/comments-v3-phase6.md`).
`comment-v3-fixture.ts` stays.

## Phase 5.5 — Shared builders (its own PR, decided 2026-11-09)

Refactors with no behaviour change, each with its own regression check:

- [x] One parameterized builder for the per-entity comment notification queries, verified by a
      before/after shadow comparison on a prod snapshot. `entityOwnerCommentQuery` in
      `comment.notifications.ts` builds the 14 types addressed to the commented entity's owner
      (top-level comments, and the model and 3D-model replies); the reply and thread types keep
      their own queries. On the prod replica (2026-11-10, a 30-day window) each type returned the
      same rows before and after. One deliberate difference: `new-review-response` now also
      requires the review author's id > 0, as every other owner type does
- [x] One exclusion helper (hidden, blocked, blocked-by, owner exemption) shared by the readers:
      `getCommentExcludedUserIds` (`comment-exclusions.service.ts`), which the section, replies
      and thread reads all take through `viewerFor` in `commentv3.controller.ts`; the v1/v2
      copies went with Phase 5

## Deferred after Phase 5 (Group B)

Names still carrying `CommentV2` after the Phase 5 PR. None blocks Phase 6: each lives outside the
old Postgres tables.

- [ ] `text-scan/mode.ts`'s fallback from `CommentV3` to the stored `CommentV2` rollout, the one
      name that changed behaviour. `CommentV3` has its own rollout on prod since 2026-11-10 (the
      same 100/100 it read through the fallback), and the Phase 5.5 PR removes the fallback
      (`rolloutFor`, the `CommentV2` read in `readTextScanRollouts`, the `hDel` in
      `setTextScanRollout`). Left: delete the stale `Comment` and `CommentV2` fields of
      `system:text-scan:modes` once it deploys. Closing condition: `CommentV2` greps empty in `text-scan/mode.ts` and `prompt.ts`, and the hash has
      a `CommentV3` field and no `Comment` or `CommentV2` field

Kept as permanent external labels (decided 2026-11-10): each names stored history in another
system, so a rename would split that history across two names and every reader would have to
accept both.

- [x] ClickHouse `CommentV2_*` events: `reactions.type` keeps its `CommentV2` values, and the
      materialized view reading it is untouched
- [x] Event points' `CommentV2:` source keys (`events/points/hooks.ts`)
- [x] Buzz entity type `'CommentV2'`: `goodContent.reward.ts` (with its `CommentV3` special case),
      the `src/utils/buzz.ts` and `src/utils/string-helpers.ts` labels

## Phase 6 — Contract (teardown)

### Transition code to remove

Everything written only because the old tables exist or because surfaces flip one at a time, and
not already a Phase 5 item (its main-app and moderator-app collapses, `thread-chain.ts`, the
per-surface UI mounts). Remove it before the table drops below. Closing condition: each removed
symbol greps empty in `src/`, `apps/` and `scripts/` (for an item that moves or loses only an arm,
the named arm is gone), and the transition-only tests are gone with them.

After the last surface's write flip has soaked (most items below were removed with Phase 5, built
2026-11-09 and deployed 2026-11-10, `docs/plans/comments-v3-phase5.md`, or, for `mode.ts`'s rollout
fallback, Phase 5.5; what is left is named in each item's "Left:", and the `goodContent.reward.ts`
special case stays with the `CommentV2` Buzz entity type, Group B):

- [x] Old-row sync: `syncOldRows` in `commentv3/write.service.ts` and its callers. With it and the
      reverse copy gone there is no rollback path to the old tables
- [x] Surface switches: `constants.comments.v3ReadSurfaces` (and the `deepLinkParentId` CASE in
      `comment.notifications.ts` collapses to `parentId`), `v3WriteSurfaces`, `isV3WriteSurface` and
      `v3WriteSurfaceSql` (in `commentv3/write.service.ts`), and the `!isV3WriteSurface` refusal in
      `commentv3.controller.ts` (writes on 3D model reviews, never a v3 write surface, are refused).
      The v2 arm of `useCommentMutations.ts` and the report-entity pick in `CommentItem.tsx` went
      in release 2
- [x] Old-endpoint refusal: `isV3WriteTarget`, `V3_WRITE_TARGET_MESSAGE`, `throwIfV3WriteTarget`
      and its call sites (done early: built 2026-11-05, release 2, deployed by 2026-11-10, with the `commentv2` writes they guarded)
- [x] Thread lock on the v3 router: `toggleSectionLock` (moderator-only in its handler) and
      `getSectionLock` on `commentv3`, `CommentsV3/ToggleLockComments` moved onto them, and
      `toggleLockCommentsThread` / `getCommentsThreadDetails2` deleted (done early: built 2026-11-05, release 2, deployed by 2026-11-10)
- [x] Reverse copy: `comment-v3-reverse-copy.service.ts`, the `reverse*` steps of
      `api/admin/temp/comment-v3-backfill.ts`, and `comment-v3-reverse-copy.sql.behavior.test.ts`

With the old tables (before the drops below):

- [x] Old arms beside a v3 one: removed in Phase 5 — `block-check.service.ts` (`ownersForCommentV2`,
      `threadAncestorsCte`; CommentV3 is the only path); the `user.service.ts` account wipe and ban
      CommentV2 arms and `v3SurfaceCommentIds`; `bulkDeleteCommentsV2` and `deleteCommentsV2` (now
      `bulkDeleteComments`); `v3WriteCommentIds` and `bulkSet`/`bulkClearCommentV2TosViolation`
      (the endpoints call the CommentV3 ones); the `scam-cleanup.service.ts` CommentV2 arms and
      `setV3SurfaceHidden`; `reaction.service.ts` `isV3WriteComment` and the CommentV2 toggle arm;
      `reaction.controller.ts`'s CommentV2 tracking read; `hasV3SurfaceTwinSql` and its
      exclusions; the `CommentTopic` delete ahead of an article (the entity cascade covers it); the
      reverse copy's `removedByAuthor` carry. The `goodContent.reward.ts` `CommentV3` special
      case stays with the `CommentV2` Buzz entity type (Group B); `CommentV3.removedByAuthor` is
      dropped by the Phase 6 migration (`Comment`'s copy goes with that table)
- [x] Text-scan: removed in Phase 5 — `comment.profile.ts` and `comment-v2.profile.ts` with the
      `Comment`/`CommentV2` entity types, their cases in `csam-hold-decision.ts` and the Clavata
      cutover set, and the scam adapter's `commentsV2` cleanup kind (now `comments`; a stored
      `commentsV2` record still restores; the hand-run SQL rewrote the stored ones on 2026-11-10). `mode.ts`'s
      fallback from `CommentV3` to the `CommentV2` rollout went in Phase 5.5 (Group B tracks deleting
      the stale Redis fields)
- [ ] Event engine: removed in Phase 5, in one release — `comment-v2.ts` and its
      `handlers/index.ts` entry, `COMMENT_V3_SURFACES` and
      `src/server/common/__tests__/comment-v3-surfaces.parity.test.ts`; `public.Comment`/`public.CommentV2`
      in `config/index.ts`, `scripts/create-kafka-topics.ts` and `scripts/sql/replica-identity.sql`.
      Left: deleting the Kafka topics themselves (ask an infra owner)
- [x] Old main-app files: `commentsv2.service.ts` deleted in Phase 5 (the owner lookup moved to
      `comment-owner.service.ts`, the judge read to `challenge-judge-review.service.ts`), with
      `getImageThread` in `@civitai/db-queries/hot-reads` and its parity case; `comment.schema.ts`
      folded into `commentv3.schema.ts` in Phase 6. Earlier: `comment.service.ts`,
      `comment.router.ts`, `comment.controller.ts`, `comment.selector.ts` and
      `components/CommentSection/` went with the model flip; `commentv2.router.ts`,
      `commentv2.controller.ts`, `commentv2.schema.ts`, `commentsv2.reply-threads.ts`,
      `commentv2.selector.ts` and `components/CommentsV2/` with release 2
- [x] Moderator app: `withoutOldCommentLink` / `linkFilter` in `report-entities.ts` and its
      `reportLinkFilter` call sites; the `commentV3` label in `src/lib/reports.ts` and the
      `CommentV3` label in `routes/csam/text-holds/hold-entity.ts` are 'Comment', with the
      `Comment`/`CommentV2` entries dropped; the `Comment`/`CommentV2` cases in `hold-entity.ts`,
      `hold-context.server.ts`, `scam-review.ts`, `user-lookup.service.ts` and
      `user-account.service.ts` (Phase 5). Stored CSAM holds and relabel items of the old types
      are rewritten by the plan's hand-run SQL
- [x] Backfill and parity: `comment-v3-backfill.service.ts` and
      `api/admin/temp/comment-v3-backfill.ts`; `jobs/comment-v3-parity.ts`, its registration in
      `api/webhooks/run-jobs/[[...run]].ts`, and the `comment_v3_parity_finding` gauge (Phase 5).
      The `comment-v3-parity:last` KeyValue row is deleted by the Phase 6 migration
- [x] Transition-only tests: removed in Phase 5 — `comment-v3-backfill.sql.behavior`,
      `comment-v3-reverse-copy.sql.behavior`, `comment-v3-parity-verdict`,
      `jobs/__tests__/comment-v3-parity`, the v2 cases of
      `commentv3/__tests__/scam-cleanup.sql.behavior`, and the v2 arms of
      `bulk-delete-comments.behavior.test.ts` and `remove-all-content-legal-hold.behavior.test.ts`;
      `commentsv2.threadMute.service.test.ts` is gone. `comment-v3-mirror.sql.behavior` went in Phase 6.
      `comment-v3-fixture.ts` stays: the SQL tests replay the real migration history from it, and
      the moderation, scam-cleanup and write tests replay it through the Phase 6 teardown

### Database teardown

Migration `20270102120000_comment_v3_teardown` (Phase 6 PR), applied by hand after that PR deploys:
the previous build still reads the old tables (reaction erasure, the personal-data export, the CSAM
comment archive and context text) and selects `CommentV3.removedByAuthor`.

- [x] 🔴 **Verify `CommentMute` + `CommentTopicMute` are populated BEFORE dropping `Thread`** —
      `ThreadMute_threadId_fkey` is `ON DELETE CASCADE`. Verified on prod 2026-11-10: every
      comment-level and section-level `ThreadMute` has its `CommentMute` or `CommentTopicMute` row; one mute sits on a thread
      with no entity, which nothing can map
- [x] Phase 5 migration `20270101120000_comment_v3_old_table_triggers_off` (the mirror triggers and
      `trg_moderation_comment`/`_commentv2`), applied 2026-11-10 before the Phase 5 deploy
- [x] Before the teardown on prod: the held users' comments in the orphan purge's `archive` schema,
      their only copy, written to the CSAM bucket by a local one-off run (2026-11-11, read back)
- [ ] The teardown migration, applied on each writable environment after the Phase 6 deploy, in one
      transaction:
      - keeps none of the comments never copied to CommentV3, on Q&A and club posts (Briant,
        2026-11-10 and 2026-11-11)
      - drops the functions taking old-table row types, then the eight tables in one statement (no
        CASCADE, so a view, foreign key or row-typed function depending on them fails the migration;
        none is defined in this repo), then the old count
        functions and the mirror's remaining `commentv3_*` functions
      - drops the orphan purge's `archive` schema, the `comment-v3-parity:last` KeyValue row and
        `CommentV3.removedByAuthor`
      - keeps `comment_shared_id_seq` (CommentV3 draws its ids from it) and the live CommentV3
        triggers and functions
- [x] Schema: the eight models and their 25 reverse relations removed from `schema.full.prisma`;
      `db:generate` regenerated. `drift-baseline.json` had no old-table entries; the remediation
      `production-plan.test.ts` and the drift tests' old-table entries are updated
- [x] Code: the CSAM context reader (`csam-context-text.ts`) and the held-user comment archive
      (`archiveUserComments`) read CommentV3 only (the unmigrated rows, on Q&A and club posts, are
      dropped); reaction erasure, the personal-data export registry
      and the reaction selector no longer name the old tables
- [x] `EntityType` values `Comment`/`CommentV2` **left in place** (read-time aliases only)
- [x] `job-queue.ts`: no old-type mapping is left (they went in Phase 5)
- [ ] Plan doc + this checklist marked complete after the migration runs; `docs-drift-review` over
      the final diff

**Gate:** prod schema contains no old comment tables; drift gate green; full unit suite green.
