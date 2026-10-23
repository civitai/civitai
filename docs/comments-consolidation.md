# Comments Consolidation Plan

Consolidate the legacy `Comment` table (model discussions) and the `CommentV2` + `Thread` pair
(everything else) into one comment table that is cheap to page, easy to drill into, and
depth-limited by design.

Execution tracking lives in the companion checklist:
[comments-consolidation-checklist.md](comments-consolidation-checklist.md).

Status: **proposal; decisions settled 2026-08-24, amended through 2026-10-20** (Briant). What
changed after the 2026-08-25 merged design is listed under _Changes since 2026-08-25_ below.

1. Questions & Answers comments are **not migrated** — dropped with the surface.
2. The model page **keeps its current UI** for now — the migration swaps the storage under it,
   not the presentation (display depth 1, flat root+replies).
3. Hard stored-depth cap of **20** with clamp-to-sibling: approved.
4. Reactions/reports unification is **in scope** (revised 2026-08-24 — originally deferred, but the
   old join tables FK-reference the old comment tables, so deferring it would block Phase 6
   teardown indefinitely).
5. The table is named **`CommentV3` permanently** — no post-teardown rename.
6. Deletion semantics (settled 2026-08-25, via Koen's counter-proposal): **tombstone when a
   comment has replies, hard-delete when childless**, enforced by `deletedAt` +
   `parentId ON DELETE RESTRICT`. Extended 2026-10-20: also tombstone a comment a clamped reply
   answers via `replyToId`, and collapse tombstones on both edges (_Deletion semantics_).
7. Per-thread notification mute is **in scope** (added 2026-09-01, Briant). PR #4524 shipped it for
   CommentsV2 after this plan was written; consolidation must carry it rather than rediscover it.
   Two tables, `CommentMute` + `CommentTopicMute` — settled 2026-09-01, to be re-reviewed with the
   rest of the schema before Phase 1 starts. See [Thread mute](#thread-mute-phase-5-detail).
8. The v3 code is **Kysely, not the Prisma client** (added 2026-10-19, Briant): the v3 service
   and the backfill jobs run on the main
   app's Kysely clients (`src/server/db/kyselyDb.ts`, already used by five services) —
   `kyselyV3Read`/`kyselyV3Write` wherever `path`, `rootId` or `depth` is touched, since they add
   the `path` type and make the generated columns select-only — with `path` operations as `sql`
   fragments in the query builder. The tables are still declared
   in `schema.full.prisma`, because the Kysely `DB` types are generated from it; nothing calls the
   Prisma delegate for them. Old-table code keeps whatever client it has until Phase 6.

The target schema below is the **merged design** (2026-08-25): Koen's counter-proposal — ltree
path as the single source of tree truth, with `rootId`/`depth` generated from it — adopted with
three adjustments: `clubPost` dropped from the enum (dead surface), `CommentTopic.commentCount`
kept (hot list-page reads), and the ltree operational constraints documented.

## Changes since 2026-08-25 (for review)

Amendments to the merged design that Koen has not yet reviewed, newest first. Each names the
section that holds the detail.

- **2026-10-21 — the Phase 3 backfill is built** as steps of one admin endpoint that reuse the
  mirror's row functions, with an `unmirrored` report (skipped rows by reason), a `parity`
  report (the old-versus-new checks in the checklist, as counts with sample ids) and the two
  residue sweeps. Run on prod 2026-10-21, converged with parity all zero. The parity monitor job
  and the reverse-copy script (not yet proven on a prod sample) followed the same day; the reader
  re-point is still open (_Phase 3_).
- **2026-10-20 — the Phase 2 mirror is built (`20261120120000_comment_v3_mirror`), and the
  moderation work moves to Phase 4.** The lock pair (`toggleLockCommentsThread`) and the mutes
  (`toggleThreadMute`/`toggleSectionMute`) are mirrored by triggers on `Thread` and `ThreadMute`,
  with no app-level write in Phase 2. The v3 service, the Clavata trigger migration, the
  `entity-moderation.ts` consumer, the text-scan profile/entity type and `ReportEntity.CommentV3`
  move to the first Phase 4 write flip: under dual-write every `CommentV3` row mirrors a row the
  old triggers already scanned. The rules the mirror adds (kept v1 ids, tombstone collapse,
  `SECURITY DEFINER` with `EXECUTE` revoked from `PUBLIC` and the sequence grant it still needs,
  the deferred topic count, and `SKIP LOCKED` on every row a deleter or an entity cascade can
  hold, which leaves a write unmirrored for the backfill instead of waiting) are listed under
  _Phase 2_. CDC for `CommentV3` lands with its handler before the first write flip
  (_Phase 2_, last paragraph).
- **2026-10-20 — D6 tombstones a comment a clamped reply answers (`replyToId`), and collapses
  tombstones on both edges.** A hard delete would fire the `replyToId SET NULL`, whose lock on
  the reply can deadlock an entity cascade against an edit of it. The mirror's delete is a
  two-step lock (`NO KEY UPDATE SKIP LOCKED` probe, then plain `FOR UPDATE`); the v3 service must
  match (_Deletion semantics_, _Phase 2_).
- **2026-10-20 — `CommentTopic` is list-partitioned on `entityType`, one partition per enum
  value, each with an `ON DELETE CASCADE` FK to its entity table** (Koen's proposal, 2026-10-19).
  This replaces the per-entity `AFTER DELETE` triggers: the link is a visible constraint, a topic
  for a missing entity is rejected, and an enum value with no partition fails on its first insert.
  Found on the way: app listings key on `app_listings.serial_id`, since the store `id` is a text
  ULID (_Entity deletion_, DDL under _Target data model_).
- **2026-10-19 — Newest/Oldest sort on `(createdAt, id)`, not `id`.** The v1 backfill under
  dual-write makes id order diverge from creation order; the two "newest" indexes lead on
  `createdAt` and the keyset cursor is the pair (_ID strategy_, _Indexes_). Also: a v1 row
  written during dual-write keeps its id in V3.
- **2026-10-19 — no `ComicChapter` surrogate-id migration.** `ComicChapter.id` has existed since
  2026-03-04; comic chapters key on it, and one `commentv3_thread_entity` function resolves
  `Thread` rows for both the mirror and the backfill (keying note above _Phase 1_).
- **2026-10-19 — `CREATE EXTENSION ltree` is installed on prod** (1.3, schema `public`; verified
  on the replica). The Phase 0 infra sign-off is done; dev already had it (seen at the
  2026-10-20 dev apply); CI and local still need it before the migration runs there.
- **2026-10-19 — the v3 service and backfill use Kysely, not the Prisma
  client** (decision 8). The Prisma-only constraints on `path` (blocker 5) fall away; the DDL,
  triggers and ltree sign-off are unchanged.
- **2026-10-19 — `rootId`/`depth` stay `GENERATED ALWAYS` columns, as in Koen's draft.** The
  2026-10-16 review had moved them into the `commentv3_set_path` trigger; reverted, with an
  explicit `NOT NULL` on both (blocker 6; schema-review notes under _Target data model_).
- **2026-10-16 — an entity hard-delete removes its `CommentTopic`**, and comments, reactions,
  report links and mutes cascade from it (_Entity deletion — decided_). First drafted as a
  per-entity `AFTER DELETE` trigger; the partition FKs above replaced that on 2026-10-20.
- **2026-10-16 — partial index `commentv3_reply_to` on `replyToId`**, found by the cascade
  benchmark: without it the `SET NULL` FK scans the table once per deleted row (_Indexes_).
- **2026-10-16 — the depth-cap clamp applies retroactively** to the 692 migrated comments deeper
  than 20 (_Depth limiting_).
- **2026-10-16 — orphaned-thread comments are not migrated.** The `Thread` entity FKs are
  `ON DELETE CASCADE` in prod since 2026-10-16 and the existing orphans were purged and archived
  on 2026-10-19 (_Orphaned-thread comments — decided_ and the two sections after it).
- **2026-10-16 — dual-write is `AFTER INSERT/UPDATE/DELETE` triggers on the old tables**, not an
  app-level mirror, so database cascades and bypass writers are covered (blocker 2); the v1
  copy's `ON CONFLICT` targets `legacyV1Id` (blocker 4).
- **2026-10-16 — `crucible` joins `CommentEntityType`** (blocker 7).
- **2026-09-01 — per-thread notification mute is in scope** as `CommentMute` +
  `CommentTopicMute` (decision 7; _Thread mute_).

## Viability review (2026-10-16)

Phase 0 ran on the prod replica and the plan was checked against the code and the Prisma/Postgres
behaviour it relies on. The direction holds and the data is small. The plan is **not executable as
written**: the blockers below have to be folded into Phases 1–3 first. The two decisions it raised
(orphans, depth clamp) were settled the same day, and the FK flip (applied 2026-10-16) and the
purge (applied 2026-10-19) were approved.

### Phase 0 results

Figures as measured on 2026-10-16, before the FK flip and the purge; the two orphan rows are
zero since 2026-10-19.

| Measure                                                   | Result                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rows                                                      | `Comment` 1.27M, `CommentV2` 2.36M, `Thread` 5.70M (3.72M hold no comments; 3.65M of those are the eager review threads), `CommentReaction` 1.67M, `CommentV2Reaction` 3.54M, `CommentReport` 21K, `CommentV2Report` 65K. Comment tables plus their reactions and reports total ~2.6GB; `Thread` alone is 3GB. |
| Max ids                                                   | `Comment` 1,367,252; `CommentV2` 2,538,176                                                                                                                                                                                                                                                                     |
| v1 depth                                                  | 3 `Comment` rows whose parent also has a parent — v1 needs no depth handling                                                                                                                                                                                                                                   |
| v2 depth                                                  | reply chains reach 247 levels; 692 comments sit deeper than 20 (in 666 non-empty threads) — the backfill must clamp them or `commentv3_depth_cap` aborts the copy                                                                                                                                              |
| Orphaned threads                                          | 288,718 root threads with no entity, holding 233,525 `CommentV2` rows (~10% of v2) plus 42,577 in nested threads under them — see _Orphaned-thread comments — decided_                                                                                                                                         |
| Child threads with null `parentThreadId` / `rootThreadId` | 2 of 502,658 — ordering the backfill by `parentThreadId` is fine                                                                                                                                                                                                                                               |
| Replies to deleted comments                               | 2,867 child threads under live entities whose `commentId` was nulled by a v2 hard-delete, holding 3,843 comments — a second orphan class; the backfill must skip them, not promote them to top level (see _Orphaned-thread comments — decided_)                                                                |
| Threads per entity                                        | review 3.65M, image 1.06M, post 164K, bounty + bountyEntry 31K, article 18K, comic 462, model 456, question/answer 456, challenge 352, model3d (+ review) 149, clubPost 53, crucible 11, appListing 1. No thread carries two entity FKs; no `imageId` dangles.                                                 |
| Dead columns                                              | `CommentV2.metadata` is non-null on 20,141 rows and every value is `{"oldId": n}`, an import marker nothing reads — drop. `nsfw` is true on 11 v2 rows and 1 v1 row — drop.                                                                                                                                    |
| `ThreadMute`                                              | 225 rows in prod — the feature is live, not dev-only                                                                                                                                                                                                                                                           |
| ltree                                                     | installed on prod 2026-10-19 (1.3, schema `public`)                                                                                                                                                                                                                                                            |
| Reply-count EXPLAIN                                       | not possible until the table exists; at this volume the risk is low                                                                                                                                                                                                                                            |

Found in passing: comic chapter threads double-counted — `comics.router.ts` incremented
`Thread.commentCount` by hand on top of the `comment_count_update` trigger, so every comic thread
was over by up to 11. The increment is removed (#6121) and the stored counts were recounted in
prod on 2026-10-16; the Phase 3 topic recount covers any residue regardless.

### Blockers

1. **Dual-write before backfill breaks replies.** A reply whose parent has not been copied yet has
   no parent row in `CommentV3`, so the `parentId` FK fails inside the user's transaction and the
   comment is lost. Phase 2 must copy the missing ancestor chain on demand (walk
   `Thread.commentId → CommentV2.threadId` to the root and insert parents first), or the backfill
   must run before dual-write with a catch-up pass afterwards.
2. **Deletes cannot be mirrored one-for-one.** A mirrored v2 delete of a comment with replies hits
   `parentId ON DELETE RESTRICT`, and the user's delete throws with it — so the tombstone rule
   belongs in Phase 2, not Phase 4. Database cascades never reach the services either: a model
   delete cascades its v1 comments, a v1 parent cascades its replies, a `Thread` delete cascades its
   `CommentV2` rows, and account deletion removes posts/models/articles that cascade in turn. An
   app-level mirror leaves `CommentV3` holding rows the old tables no longer have. Mirror with
   `AFTER INSERT/UPDATE/DELETE` triggers on `Comment`/`CommentV2` instead — that also covers the
   writers that bypass the services (`comics.router.ts` writes `Thread`/`CommentV2` directly,
   `scam-cleanup.service.ts` hides with raw SQL, ban `removeComments` in `user.service.ts` sets
   `tosViolation` on both tables).
3. **The backfill races live writes.** `ON CONFLICT (id) DO NOTHING` stops double inserts, not an
   edit or delete that lands between the copy's read and its insert: the mirrored UPDATE/DELETE
   finds no row, then the copy inserts stale content or resurrects a deleted comment. Count parity
   never sees it. Trigger mirroring closes the window; without it, add an `updatedAt` comparison
   pass after convergence and a delete log.
4. **v1 `ON CONFLICT` targets the wrong column.** v1 rows take new ids, so `ON CONFLICT (id)`
   never fires and a mirrored v1 row is copied twice. Target `"legacyV1Id"` (its unique partial
   index exists for this).
5. **`path` and the Prisma delegate — moot under decision 8.** A required `Unsupported` column
   with no default removes `create`, `createMany` and `upsert` from the Prisma delegate (verified
   on 6.13). The v3 code is Kysely, so no delegate write exists; the schema still declares
   `@default(dbgenerated())` because it costs nothing and protects a later Prisma caller.
   Postgres checks NOT NULL after BEFORE triggers run, so the DDL stands.
6. **Generated columns — kept, after a one-day detour.** The 2026-10-16 review moved
   `rootId`/`depth` into `commentv3_set_path`, citing `20240118214315_muted_at` (a
   `GENERATED ALWAYS … STORED` column that `20240119204734_muted_at_trigger` replaced the next day)
   and the fact that Prisma and Kysely type a generated column as writable. Reverted 2026-10-19:
   the `muted` precedent does not apply — it was reverted because the app writes `muted` directly,
   and `rootId`/`depth` have no legitimate writer — and under decision 8 the
   `kyselyV3Read`/`kyselyV3Write` handles type both columns select-only, which closes the type gap. A generated column is the only
   form Postgres itself refuses to let any writer desync from `path`, and it follows `path` under
   an UPDATE, which the INSERT-only trigger would not. Declare both `NOT NULL` explicitly (Postgres
   does not infer it for a generated column, and the drift tool compares nullability). `nlevel`,
   `subltree` and the ltree I/O functions are IMMUTABLE, as the expression requires (checked in
   prod's `pg_proc` on 2026-10-19, once the extension was installed, and the expression evaluated
   on the replica); the exact DDL ran on dev and prod on 2026-10-20
   (`20261110120000_comment_v3_schema`).
7. **Crucible is a comment surface** (`Thread.crucibleId`, #5780, after this plan was written):
   add `'crucible'` to `CommentEntityType`, the backfill, the topic copy and the flip order.
8. **`CommentTopic` as first drafted had no FK to its entity** (a single FK cannot reference 13
   tables), so it would have accumulated orphans as `Thread` did. `Thread` leaked that way: every
   entity FK was `ON DELETE SET NULL` and nothing deleted `Thread` rows, which is where its 288K
   orphans came from, until the FKs became `ON DELETE CASCADE` in prod on 2026-10-16 (migration
   `20261101120000_thread_entity_fk_cascade`, #6155) and the orphans were purged on 2026-10-19.
   Resolved for `CommentTopic` by partitioning it on `entityType`, one entity FK per partition
   (_Entity deletion_).

### Orphaned-thread comments — decided

- **Orphaned-thread comments.** They existed because every entity FK on `Thread` was
  `ON DELETE SET NULL` and nothing deleted `Thread` rows: deleting an image, review, post or
  article blanked the thread's entity column and left the thread, its comments, and its nested
  reply threads behind, with no record of what they were attached to. About 6K comments a month
  joined them (2026-10-16: 288,718 root threads holding 233,525 comments, plus 40,778 nested
  threads with another 42,577 comments). Nothing rendered them (no entity page), but they were not
  residue: reports, strikes, the scam-case ledger and notification rows referenced them by id, and
  the per-user readers (`events/points/hooks.ts` comment count,
  `creator-score-self-activity.service.ts`, `block-hide-comments.service.ts`, the moderator
  detail fetchers) counted them. The FK cascade stopped the stream (2026-10-16) and the purge
  removed the stock (2026-10-19); both sections follow.

  **Decided 2026-10-16: orphans should not persist.** In V3 an entity hard-delete
  deletes its `CommentTopic` and everything under it cascades (see _Entity deletion_ below), so
  the backfill **skips** orphaned-thread comments rather than inventing a sentinel topic (the
  first class can no longer occur in prod, so that skip is a guard; the second class below still
  can). What the purge dropped, measured 2026-10-16 over all 276,102 orphan comments (35,547
  authors):

  | Referenced by                          | Rows                                                                   |
  | -------------------------------------- | ---------------------------------------------------------------------- |
  | `CommentV2Reaction`                    | 184,145                                                                |
  | `CommentV2Report` → `Report`           | 5,709: 5,439 Unactioned, 107 Pending, 163 Actioned                     |
  | open reports by reason                 | Automated 5,411, AdminAttention 106, TOSViolation 25, Spam 4           |
  | `hidden` / `tosViolation` flags        | 461 / 57                                                               |
  | `EntityModeration` (text-scan records) | 3, none blocked                                                        |
  | `JobQueue` ModerationRequest           | 3                                                                      |
  | `ThreadMute`                           | 1                                                                      |
  | scam-case ledger (`UserRestriction`)   | hidden ids in `triggers` JSON; restore is `WHERE id = ANY(ids)`, no-op |

  For scale, the whole `CommentV2Report` queue holds 64,568 open reports, so the 5,546 open ones
  on orphans are 9% of a queue that is not being worked, and 98% of them are `Automated`. The
  135 open human reports (AdminAttention + TOSViolation + Spam) are the only rows a moderator
  might still want, and what they would act on is the author, not the comment.

  **A second orphan class, found 2026-10-16: replies to deleted comments.** `Thread.commentId`
  is `ON DELETE SET NULL`, so when a v2 comment is hard-deleted its reply thread stays under the
  live entity with no parent comment: 2,867 such threads holding 3,843 comments. Nothing can
  expand them either. The backfill must treat them as orphans too — mapped naively,
  `parentId = thread.commentId = NULL` would promote every one of those replies to a top-level
  comment on a live entity. The 2,867 existing ones were purged on 2026-10-19, but the class
  recurs until V3 lands, because `Thread.commentId` stays `SET NULL`; the Phase 3 skip is
  load-bearing for it.

  **Purging today's orphans in prod: approved 2026-10-16** — procedure under _Orphan purge_
  below; migration `20261101130000_purge_orphaned_comment_threads` (data only) applied by
  hand in prod 2026-10-19, after the FK flip.

Decided 2026-10-16: **the depth-cap clamp for migrated rows** — approved. The 692 over-cap
comments are re-parented to a depth-20 sibling with `replyToId` set, the write path's clamp
applied retroactively.

### Orphan purge — procedure (approved 2026-10-16, applied 2026-10-19)

Applied in prod 2026-10-19. Step 6 read from the replica: zero set rows left, zero orphan roots,
zero archived comments still live, zero reports kept by the guard. The `archive` schema holds
334,004 threads (291,280 tops), 281,426 comments, 197,732 reactions, 5,868 reports (73 automated),
6 mutes, 3 `EntityModeration` and 3 `JobQueue` rows. The procedure below stays for the record
and for restore.

One-off, by hand on the primary, as migration `20261101130000_purge_orphaned_comment_threads`
(data only; the Prisma schema does not change). Run with autocommit, one step at a time: the
batched delete is a `DO` block that `COMMIT`s per batch. Everything is reversible until the
archive is dropped in Phase 6.

**What goes, and how** (prod FKs and triggers verified 2026-10-16):

| Table                              | Rows    | Mechanism                                                                        |
| ---------------------------------- | ------- | -------------------------------------------------------------------------------- |
| `Thread` orphan roots              | 288,718 | the statement                                                                    |
| `Thread` nested under them         | 40,778  | `rootThreadId`/`parentThreadId` cascade                                          |
| `Thread` dead-parent class         | 2,867   | the statement (plus any threads nested under those, cascade)                     |
| `CommentV2`                        | ~280K   | `threadId` cascade                                                               |
| `CommentV2Reaction`                | ~184K   | `commentId` cascade                                                              |
| `CommentV2Report` links            | ~5.7K   | `commentV2Id` cascade                                                            |
| `ThreadMute`                       | 1       | `threadId` cascade (6 over the full set, nested and dead-parent included)        |
| `Report`                           | ~5.7K   | **explicit** — no FK reaches it; cascades to `ReportAutomated`                   |
| `EntityModeration`                 | 3       | **explicit** — polymorphic `(entityType, entityId)`                              |
| `JobQueue`                         | 3       | **explicit** — same                                                              |
| `Thread` dangling on `challengeId` | 4       | the FK-cascade migration's own DELETE (before it adds the FK); cascades as above |

None of the ~5.7K reports is also linked to an image, user or v1 comment, so deleting them
removes nothing else. Reports linked to the four challenge-thread comments were not archived.
Untouched and unaffected: `UserRestriction.triggers` (scam ledger, restore is an id-list
no-op), the notifications database (payload ids 404 like any deleted comment),
ClickHouse, Meilisearch (comments are not indexed), Buzz and event points (no clawback path),
v1 `Comment` (its `modelId` FK already cascades; 0 dangling).

**Steps**

1. **Build the set once**, into a work table in a dedicated `archive` schema: orphan roots (all
   entity columns null, `parentThreadId` null) plus every thread whose `rootThreadId` is one;
   dead-parent threads (`parentThreadId` set, `commentId` null, root alive) plus their
   descendants by a recursive walk of `parentThreadId`. Mark the "tops" (rows whose parent is not
   itself in the set) — those are what the delete targets; the rest cascade. Record the counts.
2. **Archive** with `CREATE TABLE archive.<name> AS SELECT …` for `Thread`, `CommentV2`,
   `CommentV2Reaction`, `CommentV2Report`, `Report`, `ReportAutomated`, `ThreadMute`,
   `EntityModeration`, `JobQueue`; index each on its id. A separate schema, not `public`: the
   drift gate only reports missing FKs/columns, so it would not notice, but `db:moderator:pull`
   introspects, and a stray public table would land in a tracked schema file.
3. **Verify the archive** row-for-row against the step-1 counts before any delete.
4. **Delete the explicit rows**: `Report` (via the archived report ids — cascades its link rows
   and `ReportAutomated`), then `EntityModeration` and `JobQueue` for the archived comment ids.
5. **Delete the tops in batches** of ~2,000 thread ids per transaction, ordered by id, with a
   short pause between batches and the replica lag watched. Two triggers fire per cascaded row
   (`comment_count_update`, `comment_reaction_count_update`) and update parents that are being
   deleted in the same statement — wasted work, not wrong results, and the reason to batch
   rather than run one statement. Expect minutes, not hours (the V3 benchmark above cascaded
   21K comments + 63K reactions in 0.5 s).
6. **Verify**: the orphan-root query returns zero rows (the FK flip had already stopped the
   stream); `CommentV2` and reaction
   counts dropped by the step-1 numbers; `Report` has no row whose only link was to a purged
   comment.
7. Autovacuum reclaims the space; a manual `VACUUM ANALYZE` on `Thread`, `CommentV2` and
   `CommentV2Reaction` shortens the wait.
8. **Keep `archive` until Phase 6**, then `DROP SCHEMA archive CASCADE` with the old tables.

**Rollback (restore from archive), if ever needed.** Insert in FK order: `Thread` (roots before
children), `CommentV2`, reactions, `Report`, `ReportAutomated`, links, mutes. Three traps:
`comment_count_update` re-increments `Thread.commentCount` on insert, so insert threads with
`commentCount = 0`; `comment_reaction_count_update` does the same to `CommentV2.reactionCount`,
so insert comments with `reactionCount = 0`; and `trg_moderation_commentv2` fires on every
`CommentV2` insert, so either disable it for the session or delete the ~280K `JobQueue` rows it
enqueues afterwards.

The purge took ~280K rows out of the backfill and parity checks and 5.7K dead reports out of a
queue. It did not stop the leak; the FK cascade below did.

### Thread entity FKs → ON DELETE CASCADE (applied in prod 2026-10-16)

The leak was 16 entity relations on `Thread` (17 columns; the comic one is composite): 15 were
`ON DELETE SET NULL` and `challengeId` had no FK at all. Migration
`20261101120000_thread_entity_fk_cascade` (#6155) made all 16 `ON DELETE CASCADE` and validated
them, so the current schema has the semantics V3 was decided to have: an entity hard-delete takes
its thread, and `CommentV2` → reactions → report links → mutes already cascade from there. It was
applied by hand in prod on 2026-10-16, separately from the purge migration (data only).

- **Every lookup the cascade needs is indexed in prod** (checked 2026-10-16): each single-column
  entity link on `Thread` is `@unique`, `parentThreadId` and `rootThreadId` have btree indexes
  (the `parentThreadId` one existed in prod but not in the Prisma schema; the same migration now
  declares it), `CommentV2.threadId`, `CommentV2Reaction.commentId`,
  `CommentV2Report.commentV2Id` and `ThreadMute.threadId` all have one. No `replyToId`-style
  scan.
- **Migration shape**, per FK (except `challengeId`, below): `DROP CONSTRAINT` +
  `ADD CONSTRAINT … ON DELETE CASCADE NOT VALID` in one short `ALTER TABLE` under a
  `lock_timeout`, then `VALIDATE CONSTRAINT` separately (takes only `SHARE UPDATE EXCLUSIVE`, so
  writes continue during the 5.7M-row scan). Prisma: `onDelete: Cascade` on the 16 relations in
  `schema.full.prisma`; the default `relationMode` is `foreignKeys`, so nothing in the client
  emulates the action.
- **`Thread.challengeId` is an ADD, not a flip.** The FK never existed in prod, so the migration
  first deletes `Thread` rows whose challenge no longer exists (4 rows at the time of writing;
  they take their comments with them), then adds `Thread_challengeId_fkey … ON DELETE CASCADE
NOT VALID` and validates it. The drift baseline's 15 `referential-action` findings and its
  `missing-foreign-key|Thread|challengeId` entry dropped out with the post-migration catalog
  recapture (PR #6323, merged 2026-10-19), together with the `production-snapshot.test.ts`
  carve-out.
- **What changes for users**: deleting an image, post, review, article, bounty, model, … now
  deletes its comments, their reactions and their report links. `Report` rows for those comments
  stay, targetless — the same as any hard-deleted comment today. Account deletion cascades one
  level further than before. Costs are the V3 benchmark's: sub-second for the largest article.
- **`Thread.commentId` stays `SET NULL`.** Flipping it would make a v2 comment delete destroy
  other users' replies (the v1 behaviour D6 rejected). The dead-parent class (purged 2026-10-19)
  therefore keeps recurring slowly until V3 tombstones replace hard-deletes; the backfill must
  skip it.

### Drift since 2026-09-01

New writers and readers the phases below now include: the text-scan / scam-scan pipeline
(`queueScamScan` on every comment write, `text-scan/profiles/comment*.profile.ts`, entity lists in
`text-scan/mode.ts`, `types.ts`, `retention.ts`; its verdict and retention ledgers persist
`Comment`/`CommentV2` ids), `block-hide-comments.service.ts` (#5082), the event points hooks
(`events/points/hooks.ts` — `onCommentCreated`/`onCommentsRemoved` read `Thread.rootThread`),
`api/mod/comment/restore-from-tos.ts` (dual-list shape), `assertCommentEntityVisible` in
`commentv2.controller.ts` (bounty/bountyEntry/crucible visibility on comment reads),
`creator-score-self-activity.service.ts`, `bot-account-detection/cohort.ts`, and four raw
`Thread.commentCount` reads in `challenge.service.ts`. "Hide in place" (#5076) removed
`hiddenCount` and the hidden-count `groupBy`. `commentsv2.service.ts` now derives reply ancestry
server-side (#5622), ignoring the client's `parentThreadId`.

## Why the current system is expensive

**Two parallel systems.** `Comment` is hard-bound to `modelId` with a self-referencing `parentId`;
`CommentV2` hangs off a `Thread` row, and _nesting_ is modeled by giving each parent comment its own
child `Thread`. Every cross-cutting concern pays twice: notifications (`new-thread-response` and
mentions are literal SQL `UNION`s of both tables), moderation endpoints take `{ commentIds, commentV2Ids }`,
reactions/reports each have two join tables, the event-engine has two CDC handlers, and the
moderator app renders "Model comments" and "Other comments" as separate panels.

**Thread makes everything indirect.** `Thread` has 16 entity kinds across 17 nullable FK columns,
resolved with a dynamic `findUnique({ [`${entityType}Id`]: entityId })` cast through `as unknown
as` (7 sites). A nested comment's own thread carries _no_ entity FK, so answering "what is this
comment on?" requires `comment → thread → rootThread → COALESCE across the entity columns`. That
fallback chain is re-implemented in at least 9 places (notifications ×4, permalinks, moderator app
×2, event-engine, creator-studio) and keeps growing: the event points hooks,
`getCommentThreadBounty`/`getCommentThreadCrucibleId`, `block-hide-comments.service.ts` and
`thread-chain.ts` added four more after the 2026-08 sweep.

**"Load more replies" costs a recursive CTE.** Because reply pages live in child threads,
`getReplyThreads` walks `Thread.parentThreadId` recursively, then fetches comments for the selected
thread ids, then regroups them in JS (`commentsv2.reply-threads.ts`). It works, but every level of
the tree is a join through a second table, and reply counts require trigger-maintained
`Thread.commentCount` plus a per-request `groupBy`.

## Target data model

One row per comment. Every row knows its entity, its parent, its root, and its depth — no
resolution chain, no second table on the read path. The DDL is authoritative (ltree is
`Unsupported(...)` in Prisma — see the notes below):

```sql
CREATE EXTENSION IF NOT EXISTS ltree;  -- installed on prod 2026-10-19; elsewhere the migration creates it (trusted extension)

CREATE TYPE "CommentEntityType" AS ENUM (
  'model', 'image', 'post', 'article', 'review', 'bounty', 'bountyEntry',
  'comicChapter', 'challenge', 'model3d', 'model3dReview', 'appListing', 'crucible'
);

-- Standalone so Comment / CommentV2 id defaults can be re-pointed at it for dual-write.
-- Seeded past max(Comment.id, CommentV2.id) at migration time.
CREATE SEQUENCE comment_shared_id_seq AS integer;

-- Required parent of every comment; holds the entity lock (which can exist before any comment)
-- and the entity-level count. List-partitioned by entityType, one partition per enum value, each
-- with an ON DELETE CASCADE FK to its entity table (loop below). No DEFAULT partition, on
-- purpose. Rules and the PK order: "Entity deletion".
CREATE TABLE "CommentTopic" (
  "entityType"   "CommentEntityType" NOT NULL,
  "entityId"     integer             NOT NULL,
  "locked"       boolean             NOT NULL DEFAULT false,
  "commentCount" integer             NOT NULL DEFAULT 0,  -- trigger-maintained (deferred constraint trigger, installed by the Phase 2 mirror migration); hot list reads stay O(1)
  PRIMARY KEY ("entityId", "entityType")
) PARTITION BY LIST ("entityType");

-- One partition per enum value, each with an ON DELETE CASCADE FK to its entity table. The loop
-- runs over the enum so a value with no mapping fails here, not on the first comment.
-- ComicChapter by its unique SERIAL id (composite PK); app listings by serial_id — see
-- "Entity deletion", keying.
DO $$
DECLARE
  t            text;
  entity_table text;
  entity_col   text;
BEGIN
  FOREACH t IN ARRAY enum_range(NULL::"CommentEntityType")::text[] LOOP
    SELECT v.tbl, v.col INTO entity_table, entity_col FROM (VALUES
      ('model',         'Model',          'id'),
      ('image',         'Image',          'id'),
      ('post',          'Post',           'id'),
      ('article',       'Article',        'id'),
      ('review',        'ResourceReview', 'id'),
      ('bounty',        'Bounty',         'id'),
      ('bountyEntry',   'BountyEntry',    'id'),
      ('comicChapter',  'ComicChapter',   'id'),
      ('challenge',     'Challenge',      'id'),
      ('model3d',       'Model3D',        'id'),
      ('model3dReview', 'Model3DReview',  'id'),
      ('appListing',    'app_listings',   'serial_id'),
      ('crucible',      'Crucible',       'id')
    ) AS v(type, tbl, col) WHERE v.type = t;
    IF entity_table IS NULL THEN
      RAISE EXCEPTION 'CommentEntityType value % has no entity table mapped', t;
    END IF;
    EXECUTE format('CREATE TABLE %I PARTITION OF "CommentTopic" FOR VALUES IN (%L)',
                   'CommentTopic_' || t, t);
    EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY ("entityId") REFERENCES %I (%I) ON DELETE CASCADE',
                   'CommentTopic_' || t, entity_table, entity_col);
  END LOOP;
END $$;

CREATE TABLE "CommentV3" (
  "id"            integer             NOT NULL DEFAULT nextval('comment_shared_id_seq'),
  "entityType"    "CommentEntityType" NOT NULL,
  "entityId"      integer             NOT NULL,

  "parentId"      integer,                 -- NULL = top-level
  "replyToId"     integer,                 -- display-only "@user" when the depth clamp re-parented the reply

  -- '<rootId>.<...>.<parentId>.<id>'; filled by the BEFORE INSERT trigger. rootId and depth are
  -- GENERATED from it; NOT NULL is explicit because Postgres does not infer it (blocker 6)
  "path"          ltree               NOT NULL,
  "rootId"        integer             GENERATED ALWAYS AS ((subltree(path, 0, 1)::text)::integer) STORED NOT NULL,
  "depth"         integer             GENERATED ALWAYS AS (nlevel(path) - 1) STORED NOT NULL,  -- 0 = top-level

  "userId"        integer             NOT NULL,
  "content"       text                NOT NULL,
  "createdAt"     timestamptz         NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz         NOT NULL DEFAULT now(),
  "deletedAt"     timestamptz,                -- tombstone: had replies, so the row stays and content is cleared

  "tosViolation"  boolean             NOT NULL DEFAULT false,
  "hidden"        boolean             NOT NULL DEFAULT false,
  "locked"        boolean             NOT NULL DEFAULT false,  -- refuses new replies anywhere under this row
  "pinnedAt"      timestamptz,

  "reactionCount" integer             NOT NULL DEFAULT 0,  -- sort key, so stored; maintained by reaction trigger
  "legacyV1Id"    integer,                                 -- old Comment.id

  PRIMARY KEY ("id"),
  FOREIGN KEY ("entityId", "entityType") REFERENCES "CommentTopic" ("entityId", "entityType") ON DELETE CASCADE,
  FOREIGN KEY ("parentId")  REFERENCES "CommentV3" ("id") ON DELETE RESTRICT,  -- a childless-delete that loses a race fails, never orphans
  FOREIGN KEY ("replyToId") REFERENCES "CommentV3" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("userId")    REFERENCES "User" ("id")      ON DELETE CASCADE,

  CONSTRAINT commentv3_depth_cap             CHECK (nlevel(path) <= 21),
  CONSTRAINT commentv3_reply_to_needs_parent CHECK ("replyToId" IS NULL OR "parentId" IS NOT NULL),
  CONSTRAINT commentv3_reaction_count_nonneg CHECK ("reactionCount" >= 0)
);

-- The one tree trigger: path = parent.path || own id. rootId and depth are GENERATED from
-- path, so no writer — Kysely service, backfill, dual-write, moderator app — can corrupt the
-- tree. Lock checks, entity checks and the topic upsert live in the service.
CREATE FUNCTION commentv3_set_path() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."parentId" IS NULL THEN
    NEW.path := NEW.id::text::ltree;
  ELSE
    SELECT p.path || NEW.id::text INTO NEW.path FROM "CommentV3" p WHERE p.id = NEW."parentId";
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER commentv3_set_path
  BEFORE INSERT ON "CommentV3" FOR EACH ROW EXECUTE FUNCTION commentv3_set_path();
```

Schema-review notes (2026-08-25, merged with Koen's counter-proposal):

- **`path` is back — as the single source of tree truth, which changes the earlier calculus.**
  A first draft carried `path Int[]` + GIN; a review pass dropped it because `rootId`/`depth`
  covered the hot paths and every writer would have had to maintain the array. Koen's version
  inverts the risk: `path` (ltree) is set by one `BEFORE INSERT` trigger, and `rootId`/`depth`
  are **GENERATED from it** — so no writer population (Kysely service, backfill, dual-write,
  moderator app) can compute them wrong, and an UPDATE of `path` cannot leave them stale. Tree
  integrity moves from N application code paths into the database. (The 2026-10-16 review
  briefly moved `rootId`/`depth` into the trigger; reverted 2026-10-19 — blocker 6.) The GiST
  index buys subtree reads, ancestry checks, and the subtree-scoped lock below.
- **No `childCount` — reply counts are queried.** With `(parentId, hidden, ...)` indexes, a
  capped per-parent reply count for a page of comments is one index-only `GROUP BY`. That
  re-introduces the per-page count query the plan once celebrated killing, at index-only cost —
  Phase 0 EXPLAINs it at prod scale before this is final. `CommentTopic.commentCount` **stays
  stored** (our one divergence from Koen's draft): entity-level counts are read per-row on hot
  list pages (resource-review cards), where count-on-read would mean N subqueries per page.
- **`replyToId`** preserves who a clamped reply was answering (display-only, `SET NULL` on
  delete, CHECK'd to require a parent) — replaces the earlier "keep an @mention in the content".
- **Deletion is structural.** `deletedAt` tombstones a comment that has replies or that a
  clamped reply answers (`replyToId`); `parentId ON DELETE RESTRICT` makes a hard-delete that
  races a new reply _fail_ on the `parentId` edge instead of orphaning. Tombstones stay in indexes and pages — they render as "[deleted]"
  placeholders, which is the point.
- **`CommentTopic` is a required parent** (FK with CASCADE): the service upserts the topic on
  first comment (replacing lazy Thread creation 1:1) with `ON CONFLICT ("entityId", "entityType")`,
  the full PK; an FK violation on that insert means the entity is gone and maps to not-found.
  Entity cleanup is the entity's own delete, cascading through the partition FK.
- **`locked` is subtree-scoped**: it refuses new replies anywhere under the row — one ancestor
  check via `path` (`@>` on the GiST index) at write time. Stronger and simpler than v1's
  one-level propagation; note it in the moderation section.
- **ltree operational constraints**: `CREATE EXTENSION ltree` is installed on prod (2026-10-19,
  1.3 in `public`) and has to exist on every other database the migration runs against (dev has it; the
  CI Postgres service, local docker-compose). The schema declares the column as
  `Unsupported("ltree") @default(dbgenerated())` for type generation only (decision 8: no Prisma
  delegate touches the table); prisma-kysely omits the column, so the v3 Kysely handles add it as
  a select-only string (_Phase 1_), and path operations (`@>`, `<@`, `nlevel`, `subltree`) are
  `sql` fragments in the query builder. The generated `rootId`/`depth` integers are ordinary typed
  columns (select-only on the same handles) and are what the hot queries use — a performance
  split, not a client workaround. The schema-drift tool skips
  `Unsupported` fields silently (its type regex rejects them), so `path`'s nullability is not
  drift-checked. Debezium emits the column as a string.
- **`clubPost` is NOT in the enum** (it was in Koen's draft) — clubs are dead code and their
  threads aren't migrated.
- **`tosViolation`/`hidden`/`locked` stay booleans, not a bitwise `flags` int** (considered
  2026-08-25, Koen). The repo's bitwise wins come from set-membership queries
  (`nsfwLevel & browsingLevel`), and nothing ever queries these three as a set. Booleans keep the
  `(parentId, hidden, …)` indexes plain-column (bit-tests need expression indexes the planner
  only matches on exact expression repeats, with guessed selectivity), keep Prisma/Kysely filters
  expressible, and `ADD COLUMN boolean DEFAULT false` is a metadata-only ALTER anyway. Revisit
  only if moderation states multiply _and_ gain set-style queries.
- **No `nsfw`, no `metadata` — confirmed 2026-10-16.** `CommentV2.metadata` appears in no
  selector and has no writer; its only values are `{"oldId": n}` import markers. Comment `nsfw` is
  accepted on upsert input but read nowhere in the v2 UI, v1's NSFW comment filter is commented
  out, and prod has 12 true rows between both tables. Both stay dropped; the upsert input's `nsfw`
  field is removed with the service rewrite.
- **`CommentTopic` has no surrogate id** — nothing references it; `("entityId", "entityType")` is
  the natural PK (`entityId` leads for the FK cascade lookup, see _Entity deletion_) and saves a
  sequence plus a second unique index.
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
  createdAt DateTime        @default(now()) @db.Timestamptz(6)
  updatedAt DateTime        @default(now()) @updatedAt @db.Timestamptz(6)

  @@unique([commentId, userId, reaction])
  @@index([userId])
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

Notification mutes get two tables, replacing `ThreadMute` (shipped for CommentsV2 in PR #4524,
commit `017e35fa03`) — see [Thread mute](#thread-mute-phase-5-detail):

```prisma
model CommentMute {          // one conversation: this comment and its whole subtree
  userId    Int
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  commentId Int
  comment   CommentV3 @relation(fields: [commentId], references: [id], onDelete: Cascade)
  mutedAt   DateTime  @default(now()) @db.Timestamptz(6)

  @@id([userId, commentId])
  @@index([commentId])
}

model CommentTopicMute {     // the whole section on one entity
  userId     Int
  user       User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  entityType CommentEntityType
  entityId   Int
  mutedAt    DateTime          @default(now()) @db.Timestamptz(6)

  @@id([userId, entityType, entityId])
  @@index([entityType, entityId])
}
```

**Two tables, not one.** A single table keyed `(userId, entityType, entityId, commentId)` with a
nullable `commentId` was the first draft and does not compile: Postgres forbids a nullable column in
a PRIMARY KEY. The fallback — a unique index — treats NULLs as distinct, so one user could insert
unlimited duplicate section mutes. PG 17 has `UNIQUE NULLS NOT DISTINCT`, but Prisma cannot express
it, so the single table costs a hand-written index to save one lookup. Split, both keys are natural,
and a comment-level row stops carrying `entityType`/`entityId` it can already read off the comment.

The extra lookup is cheaper than the one it sits beside: every notification processor knows its own
`entityType` and already has `entityId` in the query, so the section arm is a single-row PK probe on
constants. Evaluate it first and a section-muted recipient never reaches the subtree test.

Keep `userId` leading in both, as `ThreadMute` does and for the reason its migration records: the
check joins from "rows this user muted", so a user with no mutes yields an empty side.

Rejected: **folding the comment-level mute into `CommentV3Reaction`**, which is structurally exact
(`(commentId, userId, <enum>)`) and the only table in this design that is. `ReviewReactions` is
shared by ten reaction tables, so a `Mute` value lands in the type union and reaction pickers of
image/article/model/post/question/answer as well; `reactionCount` is trigger-maintained off row
count and is a **sort key** (`commentv3_top_reactions`), so a mute row would inflate the visible
count and reorder the page unless the trigger learns to filter; and reactions are public where mutes
are private, so every reaction read path would have to remember to exclude them — the exact
"remember to filter" duplication this consolidation exists to delete. The reaction unique is also
`(commentId, userId, reaction)`, deliberately multi-row per user, where a mute wants at most one.

Reaction rows get fresh ids (nothing durable references a reaction row id); `commentId` maps 1:1
for v2 and via `legacyV1Id` for v1. Report rows re-point the same way — the `Report` row itself
(status, reason, rewards history) is untouched, only the join moves.

`CommentTopic` is the one Thread responsibility that can't live on a comment row: an entity-level
lock must exist before any comment does (today's `toggleLockCommentsThread` creates a locked empty
thread), and `challenge.service.ts` + `getCommentCount` read an entity-level count. The service
upserts it on first comment (replacing lazy Thread creation 1:1), and every comment FK-references
it — so an entity's own hard-delete cascades through the topic to its comments. That's _more_
integrity than today from comment to topic. From topic to entity, the partition FKs
(_Entity deletion_) close the gap that let `Thread` accumulate orphans (blocker 8).

### Entity deletion — decided 2026-10-16, FK form 2026-10-20

**An entity hard-delete deletes its topic; the topic cascades to comments, reactions, report
links and mutes.** Soft deletes (a model with status Deleted, an unpublished article) leave the
topic alone — the entity still exists.

- Done by the database, not by service code: most entity deletes never pass through a service (a
  post delete cascades its images; account deletion cascades nearly everything), which is the
  same bypass argument that moved Phase 2 to triggers. Koen's 2026-10-19 counter-proposal,
  adopted 2026-10-20: `CommentTopic` is `PARTITION BY LIST ("entityType")`, one partition per
  enum value, and each partition has an ordinary `ON DELETE CASCADE` FK to its entity table (DDL
  under _Target data model_). The app still sees one table. Over the trigger it buys:
  - the link is a constraint on the entity table itself;
  - a topic for an entity that does not exist is rejected, which the trigger never checked;
  - a new entity type that gets its enum value but not its partition fails on the first insert
    (Postgres: "no partition of relation … found for row"), so forgetting it is loud.
- Rules that come with it: always filter on `entityType` (the partition key; without it
  Postgres searches all 13 partitions) and `entityId` (the index inside the partition) — the
  rewrites of `resourceReview`, `collection.service.ts` and `challenge.service.ts` under
  _Phase 5_ must supply both; a new entity type is enum value + partition + FK in the same
  migration; no DEFAULT partition, because it would swallow a forgotten type; the migration is
  raw SQL, since Prisma has no partition syntax, and `schema.full.prisma` declares one
  `CommentTopic` model with `@@id([entityId, entityType])` matching the DDL and **no
  `@relation` to any entity table** — the FKs live on the partitions, so a declared relation
  would make the schema-drift gate report 13 missing constraints (`db:generate` and
  `db:check-generated` passed with the partitions in prod; `db:moderator:pull` introspects the
  separate moderator database, so they never reach it); never `UPDATE` a topic's `entityType` (a cross-partition update is a delete plus
  insert, which the `CommentV3` FK rejects while comments exist); retiring a type is delete its
  rows then `DROP TABLE` the partition, not `DETACH`, since `CommentV3` references the parent.
- Keying: `ComicChapter` by its unique SERIAL `id` (its PK is composite); app listings by
  `app_listings.serial_id`, because the store `id` is a text ULID — the trigger draft compared
  `OLD.id` and would have failed on the first listing delete. `Thread.appListingId` already holds
  `serial_id`, so the mirror and backfill resolver read it unchanged.
- **Verified 2026-10-16 on Postgres 18.6** (prod is 18.3): a topic cascade deletes a whole reply
  tree in one statement under `parentId ON DELETE RESTRICT`, in any id order — RESTRICT and
  NO ACTION both see the children go within the same statement. A single-row delete of a parent
  whose reply exists still fails, which is the D6 race guard. Koen reported testing the partition
  form (insert, upsert, lookup, lock, cascade delete) on 18.6 on 2026-10-19 (results not
  recorded here); the mirror behaviour test runs the reply-tree case from the entity side, one
  cascade level deeper (the dev apply did not repeat it).
- `Report` rows whose comment is gone stay, with no target. D6 already accepts this for childless
  hard-deletes, so the moderator queue has to tolerate it either way.
- The event-points hook only recounts a user's comments when the comment service deletes them; a
  cascade bypasses it and awarded points stand. The 2026-10-16 FK cascade already does the same:
  an entity hard-delete removes its comments without the hook, and the points stand — not a
  regression.
- Volume: the ~6K comments a month that used to orphan are the measure — a few hundred
  entity-with-comments deletes a day. Nothing to batch.
- **Cost of a big cascade — benchmarked 2026-10-16** (Postgres 18.6, the DDL and index set of
  that date, before the topic was partitioned, and not re-run from the entity side since;
  326K-row table, reaction- and topic-count triggers live, 3 reactions per comment).
  Articles are the only entity with threads over 200 comments (26 of them; the largest is 5,361
  comments, p90 of those 26 is 3,408), and articles are hard-deleted (`article.service.ts`
  `tx.article.delete`, plus `deleteMany` on account deletion).

  | Cascade                            | Without `commentv3_reply_to` | With it |
  | ---------------------------------- | ---------------------------- | ------- |
  | 5,400 comments + 16,200 reactions  | 59 s                         | 144 ms  |
  | 21,000 comments + 63,000 reactions | 216 s                        | 524 ms  |
  | one childless comment hard-delete  | 12 ms (full scan)            | 2 ms    |

  The slow column is the `replyToId ON DELETE SET NULL` FK scanning the whole table once per
  deleted row — quadratic, and it would have hit every single-comment hard-delete too, at 3.6M
  rows. With the index the cascade is linear in the deleted set and sits inside the article
  delete transaction without trouble. Not worth an async cleanup job.

### Indexes

```sql
-- Top-level pages, three sort modes (Oldest scans the newest index backward). Deliberately NOT
-- filtered on hidden: hidden rows are rare, a residual filter is cheap, and the same index then
-- serves the moderator hidden-comments view (which would otherwise have no index at all).
-- Tombstoned rows stay in — they render as "[deleted]" placeholders.
-- Newest/Oldest lead with createdAt, not id: once v1 rows take new ids from the shared sequence,
-- id order is no longer creation order (ID strategy below). id is the keyset tiebreak.
CREATE INDEX commentv3_top_newest    ON "CommentV3" ("entityType", "entityId", "createdAt" DESC, "id" DESC)     WHERE "parentId" IS NULL;
CREATE INDEX commentv3_top_reactions ON "CommentV3" ("entityType", "entityId", "reactionCount" DESC, "id" DESC) WHERE "parentId" IS NULL;
CREATE INDEX commentv3_top_pinned    ON "CommentV3" ("entityType", "entityId", "pinnedAt" DESC)                 WHERE "pinnedAt" IS NOT NULL;
-- Entity-wide reads at any depth (hidden counts, moderation)
CREATE INDEX commentv3_entity ON "CommentV3" ("entityType", "entityId");
-- Reply pages and capped reply counts under one parent (hidden second so count branches don't cross)
CREATE INDEX commentv3_replies_newest    ON "CommentV3" ("parentId", "hidden", "createdAt", "id");
CREATE INDEX commentv3_replies_reactions ON "CommentV3" ("parentId", "hidden", "reactionCount" DESC, "id" DESC);
-- Phase 3 may recreate the two replies indexes WHERE "parentId" IS NOT NULL before the load (checklist, Phase 3).
-- Auto-expand a page of roots
CREATE INDEX commentv3_root_depth ON "CommentV3" ("rootId", "depth");
-- Subtree reads: re-root, ancestry / lock checks, on-demand totals
CREATE INDEX commentv3_path_gist ON "CommentV3" USING gist ("path");
-- Account deletion, per-user counts, moderation, judge gate
CREATE INDEX commentv3_user ON "CommentV3" ("userId", "id" DESC);
CREATE UNIQUE INDEX commentv3_legacy_v1 ON "CommentV3" ("legacyV1Id") WHERE "legacyV1Id" IS NOT NULL;
-- The replyToId FK's SET NULL action runs "UPDATE … WHERE replyToId = $1" for EVERY hard-deleted
-- row; without this index that is a full table scan per delete (measured: 60 s to cascade one
-- 5,400-comment article, 144 ms with it)
CREATE INDEX commentv3_reply_to ON "CommentV3" ("replyToId") WHERE "replyToId" IS NOT NULL;
```

## The interactions, as queries

Every interaction is one index-backed query on one table:

| Interaction                                              | Query                                                                                                                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First page of an entity's comments                       | `WHERE entityType/entityId AND parentId IS NULL ORDER BY <sort> LIMIT n` (keyset cursor, same 3 sort modes as today; Newest/Oldest on the `(createdAt, id)` pair compared as a row value)                  |
| Does this comment have replies? / "Show N replies"       | one capped `GROUP BY parentId` over the page's ids on the `(parentId, hidden, …)` index — index-only, replaces the childless-comment bookkeeping in `reply-threads.ts` (Phase 0 EXPLAINs it at prod scale) |
| Load more replies under a comment                        | `WHERE parentId = ? AND (createdAt, id) > cursor ORDER BY createdAt, id LIMIT k` (MostReactions replies get their own index)                                                                               |
| Auto-expand replies d levels deep for a page of roots    | `WHERE rootId = ANY(pageIds) AND depth <= d AND NOT hidden` — **no recursive CTE**; the existing budget selector (`selectReplyThreadsWithinBudget`) ports over                                             |
| Drill into / re-root on a deep comment                   | subtree via `path <@ comment.path` on the GiST index, or `parentId = commentId` page-by-page                                                                                                               |
| Is any ancestor locked? (write-time check)               | `WHERE path @> new.path AND locked` — one GiST lookup                                                                                                                                                      |
| Is this recipient muted at or above this comment?        | `CommentTopicMute` PK probe on `(userId, entityType, entityId)`, else `CommentMute` joined on `path @> c.path` — **the same GiST lookup as the lock check**, replacing v2's recursive ancestor walk        |
| Deep-link / notification / moderation "what is this on?" | the row itself carries `entityType`, `entityId`, `rootId` — **single-row read**, replaces the 15-column COALESCE chain in 9 call sites                                                                     |
| Entity comment count / locked                            | one `CommentTopic` row                                                                                                                                                                                     |

## Depth limiting

Today `constants.comments.getMaxDepth` (10 for article/bounty/challenge, 5 elsewhere; image and
bountyEntry auto-expand only 3 levels, under a page-wide `autoExpandBudget`) is a **UI ceiling**:
at the ceiling the client re-roots the view on that comment (`setRootThread`) and depth in the DB
grows unbounded — prod chains reach 247 levels. v1 model comments are a hardcoded two levels
(root + flat replies; replies "to a reply" are just @mentions on the same parent).

The new model makes both real:

- **Display depth** stays per-surface in `constants.comments`, driving auto-expand and the re-root
  behavior exactly as now. Model comments become `entityType: 'model'` with display depth 1,
  reproducing today's flat UX — the model page keeps its current presentation (decision 2).
- **Stored depth gets a hard cap** (20, as `CHECK (nlevel(path) <= 21)`): the write path clamps a
  reply that would exceed it to be a _sibling_ (parent = ancestor at cap−1, one `subltree` on the
  parent's path), recording who was actually answered in `replyToId` for the "@user" display.
  Clients never send tree fields — the `BEFORE INSERT` trigger derives `path` from `parentId`,
  and `rootId`/`depth` are generated from `path`. The backfill applies the same clamp to the 692 migrated comments that
  sit deeper than 20 (approved 2026-10-16).

## Deletion semantics — decided (D6)

**Tombstone when a comment has replies; hard-delete when childless.** For context: legacy v1
cascades a delete through the whole subtree (destroying other users' replies), while v2 `SetNull`s
the child thread and quietly orphans them. Neither survives into the new model. Instead:

- A deleted comment with replies gets `deletedAt` set; content is blanked and the author hidden at
  read time; the row keeps rendering as a "[deleted]" placeholder so its replies stay in place.
- A childless comment hard-deletes. `parentId ON DELETE RESTRICT` makes this race-proof on the
  `parentId` edge: a hard-delete that loses a race against a new reply **fails** (and the service
  retries as a tombstone) rather than orphaning the reply. `replyToId` is `SET NULL`, so a
  hard-delete racing a clamped reply would silently drop the answered link instead of failing:
  the v3 delete must take the mirror's two-step row lock (a `NO KEY UPDATE SKIP LOCKED` probe, then
  a plain `FOR UPDATE`) before checking `parentId` and `replyToId` dependents, not rely on the
  failure.
- A comment that a clamped reply answers (`replyToId`) is tombstoned like one with replies, and a
  tombstone whose last reply or last answerer is deleted is deleted with it, walking up through
  tombstoned ancestors on both edges; otherwise childless "[deleted]" rows accumulate. The Phase 2
  mirror does this; the v3 service must too.
- A tombstone keeps its `userId`, timestamps, position and any `CommentMute` rows; only
  `content` is blanked. The old side drops the row entirely, so a self-delete leaves a link to a
  live account the old side did not keep. Decide before Phase 4 whether to null the author at
  tombstone time or point it at a sentinel user (the options in the account-deletion bullet
  below).
- Account deletion tombstones the user's parented comments and hard-deletes the rest — confirm
  against privacy/GDPR expectations that a tombstone as stored (blank content, `userId` kept)
  satisfies erasure;
  retention of _other users'_ replies is unchanged from v2 either way. A raw `DELETE FROM "User"`
  cannot work while any of the user's comments has a reply: `userId` is `ON DELETE CASCADE`, so
  the cascade tries to remove the tombstone too and `parentId ON DELETE RESTRICT` rejects it,
  tombstoned or not (verified 2026-10-20, both orders). It fails closed, and nothing in the app
  hard-deletes a `User` row: erasure is `deleteUser` (soft delete, PII nulled) plus
  `removeAllContent`, whose comment deletes the mirror turns into tombstones with blank content
  and hard-deletes. If a hard User delete is ever wanted, tombstones need an owner that survives
  it (a sentinel user, or `userId` nullable with `SET NULL`) — a schema decision, not a recipe.

## Moderation, blocking, and comment-gating — preserve-behavior checklist

These are service-layer behaviors, so the table swap doesn't break them by construction — but each
must be explicitly re-verified on the new service, because they're what a naive port drops.

**Moderator actions** (all live in the services being rewritten):

- **Hide** (`toggleHideComment`, both systems): `hidden` column carries over. Since #5076 a hidden
  v2 comment renders in place as a placeholder with its replies visible, so there is no hidden-count
  query to port; the v1 "See N hidden" modal retires with the model flip.
- **Block-hide** (`block-hide-comments.service.ts`, #5082): blocking a user can bulk-hide their
  comments on the blocker's content — a v2-only hidden writer today, which becomes one
  `UPDATE … WHERE userId AND entityType/entityId` on the new table.
- **Pin** (`togglePinComment`): v1 restricts pinning to root comments (raw SQL enforces
  `parentId IS NULL`); v2 pins within any thread page. The new model pins within a comment's
  sibling page (`pinnedAt` ordered first, as today), which subsumes both — the v1 restriction
  becomes moot rather than ported.
- **Lock**: three semantics exist today; the new model reproduces one, strengthens one, and
  _improves_ one:
  (a) entity-level lock (`toggleLockCommentsThread`, can pre-exist comments) → `CommentTopic.locked`;
  (b) v1's per-comment lock, which propagates to **direct children only** (`updateMany where
parentId = id`) → per-comment `locked` is now **subtree-scoped**: the write path checks
  `WHERE path @> new.path AND locked` (one GiST lookup), refusing replies anywhere under a locked
  row — a strict superset of v1's reach;
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

- **Write-time**: creating a comment checks `throwIfBlockedByEntityOwner`; _editing_ re-resolves
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
- The scam auto-mute also bulk-hides the muted user's comments — its dual-table branches are in
  the Phase 5 cron-jobs section.
- `throwOnBlockedCommentContent` (content blocklist) runs on create **and** edit in all three
  write paths (`commentsv2.service.ts`, `comment.controller.ts`, `comics.router.ts`); carries over
  with the service.
- Every write also calls `queueScamScan` (text-scan pipeline, 2026-10); the new write path must
  keep that call, and `text-scan` needs a `CommentV3` profile and entity type.
- Comment **reads** are entity-gated too: `assertCommentEntityVisible` in
  `commentv2.controller.ts` checks bounty/bountyEntry/crucible visibility before returning a
  thread. The row's `entityType`/`entityId` makes that one lookup; keep it.
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
  notification rows never go away) but tiny. A v1 row allocated by the shared sequence (id above
  `commentv3_v1_id_floor()`, the old sequences' frozen position) holds an id that is unique
  across all three tables, so the mirror keeps it as the V3 id with `legacyV1Id` set to the same
  value; an older row is renumbered from the shared sequence by whichever of the mirror (on its
  first touch) or the backfill reaches it first.
- **Ids are identities, not timestamps** (added 2026-10-19). Today v2 sorts Newest by `id DESC`.
  That stops being creation order the moment the v1 backfill runs under dual-write: a comment
  posted on a model during the backfill takes a sequence id _below_ the ids handed to older
  comments copied after it, and would sort as older than them for good. So V3 sorts Newest and
  Oldest on `(createdAt, id)` — `id` only as the tiebreak — with the two "newest" indexes leading
  on `createdAt` (_Indexes_) and the keyset cursor a row-value pair. MostReactions keeps
  `(reactionCount DESC, id DESC)`; there `id` is an arbitrary tiebreak and nothing reads it as
  time. The backfill copies `createdAt` verbatim, so backfill order does not matter either.
- ClickHouse tracking starts sending `entityType` + new comment id explicitly on every event;
  `model.metrics.ts`'s dependence on `entityId = modelId` for `type='Model'` is preserved during
  transition and re-pointed in Phase 5.

## Migration plan

The tRPC contract (`commentv2` router shapes) and the client (`CommentsProvider`, `Comment.tsx`)
stay as-is — the swap happens inside the service layer, so UI churn is near zero for v2 surfaces.

**Phase 0 — measure & decide.** Measured 2026-10-16 — results in the viability review above.
What was asked for: row counts for `Comment`/`CommentV2`/`Thread`; v1 depth distribution (rows with
`parentId` whose parent also has `parentId` — believed unreachable in UI); Thread orphan count
(all entity FKs null — note `Thread.challengeId` had **no FK constraint in prod**, an accepted
drift until the FK-cascade migration (applied 2026-10-16), which deleted the dangling threads and
added the FK; `Thread.imageId` had none either until a validated FK landed before
the 2026-10-16 catalog recapture); per-entityType comment volume; `Thread` rows for
dead surfaces (`clubPostId`, `questionId`/`answerId`). Two schema facts to confirm:
`Thread.modelId`/`challengeId`/`model3dId` are declared `@unique` but their back-relations are
lists (`Model.threads Thread[]` etc.) — verify they are truly 1:1 in prod before assuming one
`CommentTopic` row per entity.
**Comic chapters key on `ComicChapter.id`, not `(projectId, position)`.** Earlier drafts listed
an integer surrogate id as a prerequisite migration; it already exists — `ComicChapter.id` is a
`SERIAL` with a unique constraint since migration `20260304123827_comic_chapter_early_access`,
`ComicChapterRead` already keys on it, and prod confirmed on 2026-10-19 that every chapter thread
resolves through the composite key to exactly one `id`. No migration. Positions are not stable
(`reorderChapters`, `deleteChapter` and `insertChapter` re-pack them through a temp offset, and
`Thread`'s composite FK only keeps up because it is `ON UPDATE CASCADE`), so `id` is the only
usable `entityId`. One SQL function, `commentv3_thread_entity(thread)`, resolves a `Thread` row
to `(entityType, entityId)` for both the Phase 2 mirror triggers and the Phase 3 backfill; comic
chapter is its one branch that joins (`ComicChapter` on `(projectId, position)`) instead of
reading a column, and the join is consistent inside a re-pack transaction because the cascade
updates `Thread` in the same statement. Comic chapters and app listings key on `ComicChapter.id`
and `app_listings.serial_id` (_Entity deletion_, keying).

**Phase 1 — schema.** `CREATE EXTENSION ltree` (on prod since 2026-10-19; already on dev; CI and local as
needed), then the DDL above: new tables
(`CommentV3`, `CommentTopic` with its 13 partitions and their entity FKs, `CommentV3Reaction`,
`CommentV3Report`, `CommentMute`, `CommentTopicMute`), indexes, `CHECK` constraints, the
`commentv3_set_path` tree trigger, plus the count triggers
(`CommentTopic.commentCount`, created immediate here and made deferred by the Phase 2 mirror
migration, and a port of `update_comment_reaction_count` — the trigger on
`CommentV2Reaction` from migration `20251020155046` — onto `CommentV3Reaction`). The tables are
declared in `schema.full.prisma` so the Kysely `DB` types are generated (decision 8): `path` as
`Unsupported("ltree") @default(dbgenerated())`, `rootId`/`depth` as `Int @default(dbgenerated())`
(all four generators passed on it 2026-10-20). prisma-kysely drops `Unsupported` columns
outright rather than typing them `unknown`, so `src/server/db/kyselyDb.ts` exports
`kyselyV3Read`/`kyselyV3Write`, the shared clients with `withTables` adding `path` as a select-only
`string` and narrowing `rootId`/`depth` to select-only; the shared clients keep the generated `DB`
that the `@civitai/db-queries` signatures are typed against. Two more DB-level items found in the
sweep:

- **Clavata auto-moderation triggers**: `trg_moderation_comment`/`trg_moderation_commentv2`
  (migration `20250521094141`) enqueue `('ModerationRequest', entityType, id)` into `JobQueue` on
  insert/content-update. Both are still live in prod, but the text-scan cutover
  (`text-scan/clavata-cutover.ts`) is draining them per entity. If comments have cut over before
  Phase 1, CommentV3 needs no trigger — `queueScamScan` on the write path plus a text-scan profile
  cover it. If not, CommentV3 needs the equivalent trigger, which needs a `CommentV3` value in the
  `EntityType` pg enum — an additive enum change, so the expand/contract deploy-first rule applies
  — and `entity-moderation.ts` must consume the new value. Phase 1 (2026-10-20) wrote that trigger
  and then pulled it back out (#6449): under dual-write every `CommentV3` row is the mirror of a
  `Comment`/`CommentV2` row the old triggers already queued, so a `CommentV3` trigger would scan
  every comment twice, and the consumer's flagged path files a `Report` through v3 report
  plumbing that only exists with the service. Trigger, consumer, text-scan profile and entity
  type ship with the first Phase 4 write flip (a profile without an adapter logs a verdict as
  acted on and acts on nothing), after the backfill or with the trigger disabled while it runs.
  Either way the text-scan verdict and
  retention ledgers persist `Comment`/`CommentV2` ids, so v1 ids need the `legacyV1Id` alias there
  too.
- **`packages/civitai-db-schema/src/kysely/updated-at-tables.ts`** is generated from the
  `@updatedAt` columns in `schema.full.prisma` (`pnpm run db:generate`): a table whose `updatedAt`
  lacks `@updatedAt` silently never updates. Under decision 8 every v3 writer is a Kysely writer,
  so this is the only thing that maintains `updatedAt`.
  Deploy the regenerated client _before_ applying the enum-bearing migration (expand/contract
  rule in CLAUDE.md). Migrations applied manually as always.

**Phase 2 — dual-write, deployed to production first.** Mirror at the database, not in the
services: `AFTER INSERT/UPDATE/DELETE` triggers on `Comment` and `CommentV2` (and on the reaction,
report, `Thread` (the lock) and `ThreadMute` tables) write the new tables in the same transaction
as the old write.
This is what the viability review's blockers 2 and 3 require — database cascades (model →
comments, v1 parent → replies, `Thread` → `CommentV2`, account deletion's post/model/article
cascades) and the writers that bypass the services (`comics.router.ts`, `scam-cleanup.service.ts`
raw SQL, ban `removeComments`) never reach application code, and an app-level mirror would leave
`CommentV3` holding rows the old side no longer has. The trigger applies the deletion rule itself:
tombstone when the `CommentV3` row has replies or is answered by a clamped reply, hard-delete
otherwise — mirroring a v2 delete
one-for-one would hit `parentId ON DELETE RESTRICT` and fail the user's delete. A reply whose
parent has not been backfilled yet is the other trap (blocker 1): the insert trigger copies any
missing ancestors first (the loop bullet below). Before the comment it ensures the `CommentTopic`
(`commentv3_ensure_topic`: `FOR KEY SHARE SKIP LOCKED` on the topic row, else on the entity row,
then an `ON CONFLICT DO NOTHING` insert on the full PK followed by a second
`FOR KEY SHARE SKIP LOCKED` probe of the row, since an insert that no-opped means a concurrent
creator won and the caller's comment insert needs the row held before an entity cascade can take
it); if the topic row is held by a deleter or cascade, if that second probe finds it held, or if
the entity row is already gone or held by an entity hard-delete — a comment insert racing that
delete — nothing is inserted, the
mirror skips the V3 write and the old-side write proceeds. The reverse race, entity delete → `Thread` cascade → mirror
delete, must not collide with the partition cascade in the same statement (covered by
`comment-v3-mirror.sql.behavior.test.ts`; the mirror's delete never hard-deletes a row with
replies or one a clamped reply answers, so the two cascades cannot collide on `parentId RESTRICT`). Both the mirror and the backfill resolve a `Thread` row to its
`(entityType, entityId)` through the same `commentv3_thread_entity` function, so the two cannot
disagree; comic chapter is the one entity that needs a join there (see the keying note above
Phase 1). Built 2026-10-20 as migration `20261120120000_comment_v3_mirror`, with these
particulars:

- The lock and the mutes mirror the same way, so `toggleLockCommentsThread`,
  `toggleThreadMute` and `toggleSectionMute` need no app-level pair until their surfaces flip: a
  root `Thread` insert or `locked` update upserts the topic's `locked` (so the locked empty
  thread the lock toggle creates has a locked topic, and the first `Thread` for a model whose
  v1 mirror already made the topic still locks it), a v1 insert into a model that already has a
  `Thread` copies that lock into the topic it creates, a reply thread's `locked` sets the
  comment's `locked`, and a `ThreadMute` row becomes a `CommentMute` on the comment its thread
  hangs off or a `CommentTopicMute` on the entity.
- A v1 row keeps its id when it is above `commentv3_v1_id_floor()`, the position the old
  `Comment_id_seq`/`CommentV2_id_seq` froze at when Phase 1 re-pointed the defaults, captured
  when the mirror migration ran; an older row is renumbered, as the backfill would.
- Tombstone collapse (D6) also applies to a v1 subtree cascade and a user content wipe.
- A reply deeper than the cap, live or copied as a missing ancestor, is clamped exactly as the
  backfill clamps: parent = the ancestor at depth 19, `replyToId` = the comment answered.
- A reaction, report link or mute on a comment not yet in `CommentV3` copies the comment first.
- The trigger functions are `SECURITY DEFINER`: prod has roles with write access to the old
  tables and only read access to the new ones, and their writes must not fail inside the
  mirror. Their `EXECUTE` is revoked from `PUBLIC`: firing needs no grant, but creating a trigger
  does, so no other table owner can attach a definer function to a table of their own and write
  `CommentV3` through it. An update that finds no v3 row copies the comment and then applies its
  values again, because a copy already in flight elsewhere makes the second copy a no-op and
  would otherwise drop a hide, a ToS flag or a lock that raced it. (The shared-sequence default
  on `Comment`/`CommentV2` is evaluated as the inserting role, so those roles still need `USAGE`
  on `comment_shared_id_seq`, granted by hand after Phase 1.)
- The mirrored delete locks the row in two steps instead of catching `parentId RESTRICT`: a
  `NO KEY UPDATE SKIP LOCKED` probe yields to a `FOR UPDATE` holder (a deleter or an entity
  cascade removing the row, which is left to that holder) and to another delete's probe of the
  same tombstone (two sibling deletes collapsing one parent; a `KEY SHARE` probe would deadlock
  on the upgrade, and the yielding side leaves the childless tombstone the Phase 3 sweep
  removes), then a plain `FOR UPDATE` waits for `KEY SHARE` holders, i.e. replies in flight,
  including a clamped reply holding the depth-19 ancestor. Once held no reply can be in flight. A comment a clamped reply answers is tombstoned like one with
  replies: hard-deleting it would fire the `replyToId SET NULL`, whose lock on that reply can
  deadlock an entity cascade (which deletes thread by thread) against an edit of it.
- `CommentTopic.commentCount` is now maintained by a **deferred** constraint trigger (the mirror
  migration replaces the Phase 1 immediate one; the function is `SECURITY DEFINER` because a
  deferred trigger runs as the session role at commit). Every comment on an entity touches that
  one row, and holding it mid-transaction deadlocks a multi-row delete against a concurrent
  reply: the delete holds the topic row from its first row and wants the old parent of its next
  row, on which the reply already holds `KEY SHARE` while it waits for the topic row. Deferred,
  both take the topic row last, at commit. The delete branch probes the topic row with
  `KEY SHARE SKIP LOCKED` first: an entity delete whose topic cascade fires before its `Thread`
  cascade holds the topic `FOR UPDATE` while it waits on a row the comment delete holds, and the
  decrement would otherwise deadlock at commit. The topic is going with the entity, so the skipped
  decrement costs nothing unless that entity delete later rolls back (count drift, caught by the
  Phase 3 parity pass). That rests on the entity cascade being the only thing that ever holds a
  `CommentTopic` row `FOR UPDATE`: an explicit `SELECT ... FOR UPDATE` on a topic row (a Phase 3
  sweep, an app lock) would make every concurrent comment delete skip its decrement. The insert
  branch needs no probe: the reply already holds `KEY SHARE` on the topic row from
  `commentv3_ensure_topic`, which its own `NO KEY UPDATE` does not wait behind.
- Missing ancestors are collected in a loop and copied top-down, not recursively: an unmirrored
  chain can be hundreds deep, and that many nested plpgsql frames would exhaust
  `max_stack_depth` inside the user's write. The chain's ids are collected first and the old
  rows then locked `FOR KEY SHARE SKIP LOCKED` in one statement; the comment a lock, mute,
  reaction or report trigger copies (or attaches to) is locked the same way, and a skipped row
  leaves the reaction, report, mute or lock unmirrored. The same applies to every `CommentV3`
  row the mirror's own FK checks or writes would otherwise wait on: the clamp's parent and the
  depth-19 ancestor a clamped reply attaches to (a bulk delete can hold it `FOR UPDATE` while
  waiting on a `Thread` row the reply holds), the topic row and, when the topic has to be
  created, the entity row (an entity delete holds both while its `Thread` cascade waits on the
  reply), the comment a reaction, report or mute links to and the comment a reaction un-links
  from (its count update touches the comment row; report and mute deletes lock only their own
  join row), and the rows a mirrored edit, lock toggle or delete touches (an entity cascade can be removing them while it
  waits on the old row the edit or delete holds). An edit or lock toggle probes with
  `KEY SHARE SKIP LOCKED`, which yields only to a deleter or cascade, and then runs a plain
  `UPDATE` that waits for any other holder (a reaction count update, another toggle, a
  `replyToId SET NULL`); skipping those would drop the edit on v3. So a mirroring transaction
  never waits on a row a deleter or an entity cascade can hold, and none of this needs a
  subtransaction. The mirrored delete's `FOR UPDATE` can wait on a reply's `KEY SHARE`, but
  never on one whose other holdings the delete needs: a v2 reply holds `KEY SHARE` on its reply
  `Thread` row (or on the old parent, when it created that `Thread`); that row's
  `commentId SET NULL` action takes `FOR UPDATE` because `commentId` is unique, fires before the
  mirror, and waits for the reply; a v1 reply holds it on the old parent; a clamped reply holds
  it on the depth-19 ancestor and on a `Thread` row the deleter wants only inside an entity
  cascade, which already holds the ancestor `FOR UPDATE` and so makes the reply's own
  `SKIP LOCKED` probes yield. That rests on RI action triggers firing before `commentv3_mirror`
  (name order) and on `Thread.commentId` keeping a full unique index (checklist, Phase 2). The
  only holder that
  conflicts with `KEY SHARE` is a deleter, so who yields depends on who locked first. If the
  copy locked first, the deleter waits, then its mirror delete tombstones the row because the
  copy gave it a reply; the copy never resurrects a deleted comment on the v3 side. If the
  deleter locked first, the copy does not wait, since the deleter may already be waiting on a
  `Thread` row the mirroring transaction holds (its reply thread's FK) and waiting would
  deadlock; the write is left unmirrored, which the backfill covers and the old side treats the
  same way (a reply into a dead-parent thread). The trigger blocks install in the app's write
  order (`Thread`, then `CommentV2`, then the rest), after the count-trigger swap on `CommentV3`,
  which nothing writes before the mirror exists; that matches a comment insert's lock order but
  not a comment delete's (its `SET NULL` cascade touches `Thread` second), so an install racing
  a delete can still abort one side, in which case the file re-runs and nothing persists.
- One deadlock is accepted: two transactions that each touched two topics in opposite order
  and commit in the same instant can deadlock at `COMMIT` in the deferred count trigger, since
  row triggers cannot order their locks. It needs two concurrent multi-topic writes (two user
  wipes with interleaved rows), and one side aborts with `40P01`. No caller retries yet: add one
  on `removeAllContent` and the scam cleanup if it shows up (checklist, Phase 2). Everything
  else was run with two to four connections on Postgres 18.6 (scratchpad harness, not
  committed): two replies to one parent, replies and reactions racing deletes of their parent,
  grandparent or entity, overlapping user wipes, tombstone collapse racing a reply, two first
  copies of one unmirrored chain, lock toggles and mutes racing deletes, and four writers on one
  topic; after each, every old row had its mirror (except a write that deliberately yielded to
  a `SKIP LOCKED` conflict), no deleted row survived except as a tombstone with live replies or
  live answerers, no tombstone had neither except in the two cases named below (a delete
  yielding to another delete's probe of the same tombstone, and the `replyToId` edge), and every
  topic count matched its rows. The
  no-childless-tombstone property for the `parentId` edge in v2 rests on the old
  `comment_count_update` trigger serialising sibling deletes on the parent's `Thread` row; it
  stays until Phase 6. The `replyToId` edge has no such serialisation, so a last reply and a
  last answerer deleted concurrently can leave a childless tombstone, which the Phase 3 sweep
  removes.
- Both comment triggers also fire on `updatedAt`, so an edit to a column the mirror does not
  carry still keeps the parity pass's `updatedAt` comparison true. A v1 update that changes
  `parentId` or `modelId` is refused: the path trigger is INSERT-only, so a move has no mirror.
- The migration refuses to install where a v1 id above the floor is also a v2 id, which would
  otherwise fail that row's first touch on `CommentV3_pkey`.
- `src/server/services/__tests__/comment-v3-mirror.sql.behavior.test.ts` runs the schema and
  mirror migrations on PGlite (session zone UTC+5, so an implicit timestamp cast shows) against a
  fixture of the old tables. It covers the rules above except the `SKIP LOCKED` yields, the re-apply
  after a copy, and anything that needs a second session (the delete-during-copy race, the
  multi-row-delete-versus-reply deadlock shape, a comment insert racing an entity delete);
  those were run with two to four connections (previous bullet). It also covers the cascades,
  the bypass writers' statement shapes, all eight triggers under a role that cannot write the
  new tables, the `EXECUTE` revoke and the pinned search path on every definer function, the
  file's statement order and atomicity, a dead-parent thread, and the floor taken from the
  higher old sequence. The single-session scenarios also passed on Postgres 18.6.

Everything in the v3 service from Phase 4 on is Kysely transactions on `kyselyV3Write`
(decision 8). Note the `no-io-in-transaction` guard — same-DB SQL inside a transaction is fine —
and run `test:lint-rules` whenever a transaction is touched.

Dual-write ships **before** the backfill runs: with the live edge already maintained, one
converged backfill pass makes the table complete and it _stays_ complete — no moving-target
window to chase. CDC for the new table lands with its handler, just before the first Phase 4 write
flip (the Phase 5 event-engine bullet): the `Comment`/`CommentV2` handlers already count every
mirrored row, so a `CommentV3` handler under dual-write would double-count, and a subscription
without one would only stream a second full-row event for every reaction (the `reactionCount`
update) into a topic nothing reads. `REPLICA IDENTITY FULL`, the subscription (`public.CommentV3`
in `apps/event-engine/src/config/index.ts`), the `postgres.CommentV3` topic
(`scripts/create-kafka-topics.ts`) and the handler land together.

**Phase 3 — backfill.** Runs under live dual-write, so every copy job uses skip-existing semantics
(`ON CONFLICT (id) DO NOTHING` for v2 rows, `ON CONFLICT ("legacyV1Id") DO NOTHING` for v1 rows
— v1 rows take new ids, so a conflict on `id` would never fire and a mirrored v1 row would be
copied twice; a mirrored row is always at least as fresh as the copy). With the trigger mirror in
place there is no read-then-insert window for a live edit or delete to fall into; if the mirror is
ever app-level instead, add an `updatedAt` comparison pass and a delete log to the parity checks.
The jobs are steps of one admin endpoint (`src/pages/api/admin/temp/comment-v3-backfill.ts`,
service `comment-v3-backfill.service.ts`), each range-based over the source table's id and
re-runnable; the comment copies call the mirror's own `commentv3_mirror_v2`/`commentv3_mirror_v1`
per source row, so a backfilled row is exactly what the mirror would have written (entity
resolution, clamp, id floor, timestamps) and ancestors are copied before each row, which makes
batch order irrelevant. Idempotent, batched copy jobs:

- v2 comments: `threadId → (entityType, entityId)` via the thread's root chain; `parentId` = the
  thread's `commentId`. Ancestors are copied before each row (the step calls the mirror's own
  `commentv3_mirror_v2`), so the `commentv3_set_path` trigger always finds the parent's path and
  batch order does not matter; the 2 child threads in prod with a null `parentThreadId` resolve
  through `commentId` like any other. **Clamp rows deeper than 20** to a sibling at depth 20 with
  `replyToId` set, as the write path does — 692 comments in prod, and without the clamp
  `commentv3_depth_cap` aborts the batch. Ids and
  `createdAt`/`updatedAt` preserved; nullable `hidden`/`locked` coalesce to false; `replyToId`
  stays null for every other migrated row. Each batch reads its source rows
  `FOR KEY SHARE SKIP LOCKED`, so it never waits on a deleter and never commits a copy of a
  comment that is gone.
- v1 comments: direct copy with `entityType='model'`, `legacyV1Id` set, new ids from the shared
  sequence for pre-existing rows (rows the mirror already copied keep the id it gave them — the
  `legacyV1Id` conflict no-ops). `createdAt` is copied verbatim and is what the Newest sort reads,
  so the order the backfill hands out ids in does not matter (_ID strategy_). Most models with
  v1 comments have no `Thread`, so the model topic is created on demand by the row function
  (`ON CONFLICT DO NOTHING`); a model that no longer exists is skipped and counted.
- Topics: one `CommentTopic` per entity-bearing root Thread that carries information — a
  comment, a lock or a mute — whose entity row exists (a Thread whose entity is gone is skipped
  and counted, like orphaned threads — the partition FK would otherwise abort the batch),
  inserted with `ON CONFLICT DO NOTHING` on the full PK, copying `locked` and re-syncing it
  where a topic's lock drifted from its thread. The other 3.6M root threads in prod would only
  add empty topics, which every reader must already treat as "no comments" (most entities have
  no Thread at all), so they are left out (decided 2026-10-21 while building the step; veto by
  widening the predicate). `commentCount` is maintained by the deferred trigger as the comment
  copies land, never copied from `Thread.commentCount`. **The counted set must match today's trigger exactly — all rows,
  including hidden and self-authored** — because `challenge.service.ts` and `getCommentCount` read
  it raw.
- Reactions: `CommentV2Reaction` copies with the same `commentId`; `CommentReaction` maps through
  `legacyV1Id`. `reactionCount` is maintained by the reaction-count trigger as the links insert;
  `parity` checks it against the copied rows.
- Reports: `CommentV2Report` copies as-is; `CommentReport` maps through `legacyV1Id`. The `Report`
  rows themselves don't move.
- Orphaned-thread comments and their reactions/report links are **skipped** and the counts
  logged. Both classes known then were purged 2026-10-19; the dev rehearsal found two more that
  the FK cascades predate (v2 comments whose `Thread` row is gone, v1 replies whose parent is
  gone), which the `unmirrored` report names and the parity counts leave aside. Entity-less root threads can no longer
  occur, so that skip is a guard; the dead-parent class (replies whose `Thread.commentId` was
  nulled by a v2 hard-delete) still can until V3 lands, so that skip matters. Comments under a
  Thread the topic copy skipped (entity gone) are skipped with it and counted.
- Parity checks (step `parity`, old side against new, every finding zero after `sweep`): live v3
  rows whose old row is gone (v2 by id, v1 by `legacyV1Id`; the mirror's delete yields to an
  entity cascade holding the row, and a cascade that later rolls back leaves it live) and deletes
  that were resurrected; per-Thread (root and reply thread) and per-model counts against the live
  old rows, not `Thread.commentCount` (which over-counted comic threads until the double
  increment was removed; a clamped reply answers through `replyToId`); `CommentTopic.commentCount`
  against its own rows (the trigger counts tombstones); reaction counts against the copied links;
  link and mute extras; locked state (`CommentTopic.locked` / `CommentV3.locked` vs
  `Thread.locked`); full-row column drift against the old rows (replaces spot checksums and the
  `updatedAt`/`deletedAt` comparison); and v1 parent mismatches.
- Two sweeps the mirror can leave behind (the topic-mute sweep only after the topic copy has
  converged): tombstones with neither a reply
  nor an answerer (a delete that yielded to another delete's probe of the same tombstone, or a
  last reply and last answerer deleted concurrently), and `CommentTopicMute` rows whose entity is
  gone (no FK to the topic by design; an entity delete cascades `ThreadMute` after its `Thread`
  row is already gone, so the mirror cannot map them).

Once the backfill has converged and parity holds, the cross-surface **readers** move (see the
Phase 4 prerequisite) — still before any write flip.

**Rollback story** (why reads flip before writes): while writes still land in the old tables,
flipping a surface's reads back is instant and lossless — dual-write kept both sides current. Once
a surface's _writes_ flip, new rows exist only in CommentV3; rolling that back requires a
reverse-copy (CommentV3 → old tables: ids are shared, but a v3-only comment also needs its entity's
root `Thread` and its parent's reply `Thread` recreated, a model comment follows its parent's
shape into the v1 or v2 table, and edits, deletes and links must flow back; the `reverse*` steps of
the backfill endpoint do this, scoped to the flip's window and surface so a comment the mirror
yielded on is never taken for a v3 delete, nor a post-rollback ghost for a v3 write) — proven on a
prod sample before the first write flip, and don't remove a surface's old write path until it has
soaked.

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
write path is removed; `commentOld` is removed once the model surface is flipped. The first write
flip also carries the Clavata trigger, its consumer, the text-scan profile and
`ReportEntity.CommentV3` (the Clavata bullet under Phase 1 above). A surface that writes
`CommentV3` directly must also delete through the v3 service. The mirror's delete is safe against
replies only because every reply in flight also holds an old `Thread` row or old parent that the
delete already waited on; a v3-direct reply holds neither, so that argument no longer covers it.
The same invariant covers every `NO KEY UPDATE` on a v3 row (a reaction count, an edit, a lock
toggle): each is preceded by a lock on the row's old side, so the old-side delete blocks before
its mirror runs and never skips a live row. A direct write to `CommentV3` or its reaction table
breaks that, and so does a hard `DELETE FROM "User"` (its `CommentV3Reaction` cascade locks v3
rows with no old-side lock; dormant, since `deleteUser` soft-deletes). The v3 delete must also
tombstone a comment that a clamped reply answers (`replyToId`) and collapse tombstones on both
edges (`parentId` and `replyToId`).

Per-surface cutover checklist additions from the residue sweep:

- **article/post flips**: explicitly purge `articleStatCache` / `postStatCache`
  (`src/server/redis/caches.ts` ~1492-1585) after any comment-count recompute — both are 24h-TTL
  caches over the metric tables and would serve stale counts for a day otherwise.
- **image flip**: `EntityMetric` rows with `metricType='Comment'` (surfaced by the
  `EntityMetricImage` view) are written on comment create/delete — re-point that writer with the
  image surface.
- **comicChapter flip**: `ChapterComments.tsx` bypasses the comment providers and passes
  `parentThreadId` in its mutation input — the comics client changes shape with its surface flip,
  unlike every provider-based surface. It also feeds the `Thread` id into `CommentsCtx` as the
  `entityId`; after the flip the entity id is `ComicChapter.id`, which `getChapterThread` (or the
  chapter shell) has to return. Its server side, `createChapterComment` in `comics.router.ts`,
  also bypasses `upsertComment` and writes `Thread`/`CommentV2` directly; it moves onto the
  unified service with this flip.
- **crucible flip**: the newest surface (#5780); `getCommentThreadCrucibleId` and the
  `new-crucible-comment` notification go with it.

**Phase 5 — downstream re-point.** Ordering note: the **read-only** consumers in this phase
(notification queries, moderator app reads, creator-studio, metrics jobs, the challenge gate) move
once the Phase 3 backfill converges, _before_ the first Phase 4 write flip — see the Phase 4
prerequisite. What lands after the flips is the cleanup that requires old write paths to be gone
(enum/endpoint collapses, `commentOld` removal, handler retirement). Notifications and the
moderator app are the two largest consumers and get their own sections below. The rest:

- event-engine: one CDC handler on `CommentV3` replaces `comments.ts` + `comment-v2.ts`; owner
  resolution becomes one entity lookup instead of the 15-way COALESCE. The handler, replica
  identity, subscription and topic are provisioned together just before the first Phase 4 write
  flip (end of _Phase 2_), not earlier: under dual-write the old handlers already count every
  mirrored row, so the new one dedupes on comment id until each surface's writes flip.
- Metrics jobs (`article/bounty/post/model3d.metrics.ts`): count from CommentV3.
  Preserve `ModelMetric.commentCount` = **distinct commenters** semantics. `question/answer.metrics.ts`
  retire with that surface.
- Creator-studio analytics (`analytics.ts` all-time tile + per-image series): single-table query;
  model comments become visible there for the first time (feature win, note it in release comms).
- Unify exclusion logic (`boundExcludedUserIds` + hidden/blocked handling) into one shared helper —
  today it's duplicated between v1 and v2 with subtle drift.
- Cron jobs touching the tables directly (beyond the metrics jobs above):
  - `src/server/services/scam-cleanup.service.ts` — the scam auto-mute cleanup (`runScamCleanup`)
    and its restore (`restoreScamCase`) treat `Comment` and `CommentV2` as separate kinds with
    separate hide and unhide statements. Collapses to one `CommentV3` branch; during Phases 2–4
    the trigger mirror carries its raw-SQL hides across. Its `ScamCleanupRecord` persists the
    hidden ids on the user restriction, so restores of v1 cases need the `legacyV1Id` alias.
  - `src/server/events/points/hooks.ts` — `onCommentCreated`/`onCommentsRemoved` read
    `Thread.rootThread` for the entity, count `CommentV2` rows and key on `CommentV2:<id>`;
    one more `rootThread` fallback to collapse, and its source ids need the same alias policy as
    notification details.
  - `src/server/services/creator-score-self-activity.service.ts` and
    `src/server/services/bot-account-detection/cohort.ts` — per-user comment counts over both
    tables; one count each on the new table.
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
  `ResourceReviewCard`/`ResourceReviewDetail`; replace with lazy `CommentTopic` joined on
  `entityType = 'review' AND entityId = r.id` (both columns, so the join prunes to one
  partition) + `COALESCE(0)`,
  a client-visible shape change), `src/server/services/collection.service.ts` (Thread-join
  count → `CommentTopic` on both columns), `src/server/services/challenge.service.ts` (four raw
  `Thread.commentCount` reads by `challengeId` → `entityType = 'challenge' AND entityId`),
  `src/server/metrics/post.metrics-old.ts` (live sibling of `post.metrics.ts`
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

### Thread mute (Phase 5 detail)

Added 2026-08-31, after this plan was written: **PR #4524** (commit `017e35fa03`) shipped per-thread
notification mute for CommentsV2. It is live in prod (225 `ThreadMute` rows on 2026-10-16). The
plan above predates it, so everything in this section is new scope, not a restatement.

What v2 has today:

- `ThreadMute (userId, threadId)`, FK'd to `Thread` with `ON DELETE CASCADE` on both sides.
- `muteableThreadsCte` in `src/server/common/thread-chain.ts` — a `WITH RECURSIVE` ancestor walk up
  `Thread.commentId → CommentV2.threadId`, capped at `MAX_THREAD_CHAIN_DEPTH = 100`.
- `notThreadMuted(recipient, threadId)` in `base.notifications.ts`, applied at **14 sites** in
  `comment.notifications.ts` (crucible added the 14th), producer-side.
- Two controls: per-comment (overflow menu) via `toggleThreadMute`, and section-level (beside the
  top-level composer) via `toggleSectionMute`, which is the only writer that targets an entity-root
  thread.
- `getThreadMuted` / `getSectionMuted` read the same shared CTE so the menu label and the
  suppression cannot disagree.
- A convention guard, `no-unmuteable-comment-processor`, wired into `test:lint-rules`.

#### What consolidation changes

**The recursive walk disappears.** v2 has to climb thread-by-thread because nesting is modeled as a
child `Thread` per comment. In CommentV3 ancestry _is_ `path`, so suppression is one `@>` GiST
containment test — the identical shape as the lock check, and a natural row in the interactions
table above. That deletes `thread-chain.ts` outright and takes three properties with it:

- **The depth cap stops being a correctness hole.** `MAX_THREAD_CHAIN_DEPTH` is a bound on work, not
  a proof; past it `notThreadMuted` fails open and sends. Measured on prod 2026-08-27: 149 chains are
  past the cap, where a mute silently stops suppressing today. A containment test has no cap, and the
  stored depth cap of 20 makes the question moot regardless.
- **The `parentThreadId` exclusion becomes unnecessary.** The v2 walk deliberately refuses that edge
  because it is written from client input, so trusting it would let a replier steer their reply into
  a chain the recipient muted and have the notification dropped — a suppression operated by someone
  other than its owner. The cost is 3,110 orphaned threads (0.057% of all threads) whose mutes go
  unrecognised. `CommentV3.parentId` is server-derived and `path` is set by a DB trigger, so there is
  no client-steerable edge and no trade to make.
- **The section mute stops depending on lazy row creation.** `toggleSectionMute` today returns
  `hasThread: false` and does nothing on an entity with no comments yet. `CommentTopicMute` keys off
  `(entityType, entityId)` and needs no row to exist, so it works before the first comment.

**The 14 filter sites ride on the notification rewrite.** Phase 3 re-points every notification
`prepareQuery` at CommentV3, and Phase 5 offers to collapse the per-entity queries into one
parameterized builder. Both must carry the mute filter — a rewrite that drops it reads as a clean
diff and silently un-mutes every user who set a mute, with no failing test unless the guard is
re-pointed in the same change. Do the collapse _because_ of this rather than as optional cleanup:
one builder is one place the filter can be missing.

**`no-unmuteable-comment-processor` must be re-pointed in lockstep.** It asserts over the v2 SQL
text. Left alone it either fails on the rewrite or, worse, passes vacuously against v3 SQL it no
longer recognises. It also pins one deliberate _exclusion_ — `new-mention` is intentionally not
muteable — which is a product decision the rewrite must preserve, not a gap.

🔴 **`ThreadMute` cascades to nothing in Phase 6.** The teardown drops `Thread`, and
`ThreadMute_threadId_fkey` is `ON DELETE CASCADE` — so unless mutes are migrated first, teardown
deletes every mute a user ever set, quietly and unrecoverably. The backfill runs in Phase 3 with the
rest, and Phase 6 must verify the new table is populated before the drop, not after.

#### Backfilling mutes

`ThreadMute.threadId` maps three ways, and only two of them work:

1. **Comment-level** — thread's `commentId` is set: that comment's new id is the `CommentMute.commentId`
   (v2 ids are preserved, so this is identity). Note the off-by-one: v2 mutes the comment's _child_
   thread, so the mute belongs on the comment that thread hangs off, not on the thread's own parent.
2. **Section-level** — thread has an entity FK and no `commentId`: becomes a `CommentTopicMute` row
   on `(userId, entityType, entityId)`.
3. **Orphaned** — neither: nothing to map to. Skip and log the count, same policy as orphaned-thread
   comments in Phase 3.

Volume is small (225 rows in prod on 2026-10-16), so this is a one-shot copy, not a batched
resumable job. It still needs the parity check, because the failure mode is invisible to the user
until a notification they muted arrives.

#### Open questions

- **Naming — settled 2026-09-01 as `CommentMute` / `CommentTopicMute`.** The alternative was
  `CommentEngagement` / `CommentTopicEngagement` with a type enum, matching the repo's ten
  `*Engagement` tables (`ChallengeEngagement` ships a single-value enum, so precedent covers one
  state) and leaving room for a `Follow`. Rejected: a `Follow` state is speculative — the ticket's
  "mute/unfollow" is two words for one feature — and if it is ever wanted, a second table costs then
  what the enum costs now, so nothing is bought by deciding early. Whichever pair is used, keep both
  halves in the same lane: `*Engagement` is named for the id it holds, so `CommentEngagement` on the
  section table (which holds `entityType`/`entityId`) would read as the comment-level one.
- **Does drilling in / re-rooting change what "this thread" means to a user?** v2's mute anchors on a
  thread the user can see in the UI. In v3, subtree semantics are exact — muting a comment silences
  everything under it forever, including replies added after a re-root. That is the same behavior,
  but it is worth stating in the UI copy, which today says "thread".
- **Is per-notification-type mute wanted?** Out of scope here; noted because a `CommentMute` row is
  all-or-nothing per subtree and adding a type dimension later is a PK change.

### Moderator app impact (Phase 5 detail)

`apps/moderator` (Kysely, direct DB — the same client family as the v3 service under decision 8,
so the two can share query shapes) has the v1/v2 split baked into six modules; consolidation
deletes about half of each:

- `user-account.service.ts`: `getComments()` (v1) and `getCommentsV2()` (v2, hand-built
  `coalesce` over `THREAD_TARGETS` that **omits** challenge/comicChapter/model3d/appListing/crucible
  — those render with a null entity today) merge into one query reading `entityType`/`entityId`
  off the row.
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
  (`src/pages/api/mod/comment/bulk-delete.ts`, `remove-as-tos.ts`, `restore-from-tos.ts`) accept
  a single `commentIds` list; keep the old dual-list shape as an accepted alias for one release so
  the moderator app and main app can deploy independently.

Sequencing: the moderator app's read rewrite lands **during the dual-write window, before the
first write flip** (CommentV3 is complete then, and dual-write is one-directional — waiting until
after flips would leave mod tooling blind to new comments on flipped surfaces). Its old-table code
paths are deleted with Phase 6. Pre-existing dead link to note while in there:
`src/pages/moderator/strikes.tsx` links v1 comments to `/comments/<id>`, a route that doesn't exist.

**Phase 6 — contract.** First drop the Phase 2 mirror triggers (all named `commentv3_mirror`) and
the `commentv3_*` functions that take old-table row types as parameters (`thread_entity`,
`mirror_v1`, `mirror_v1_one`, `mirror_v2`, `mirror_v2_one`); `DROP TABLE` fails while they exist.
Then drop `ThreadMute`, `Thread` (and its 16 entity relations' reverse relations), `Comment`,
`CommentV2`, `CommentReaction`, `CommentV2Reaction`, `CommentReport`, `CommentV2Report`, the
triggers `comment_count_update` (function `update_thread_comment_count`),
`trg_moderation_comment`/`trg_moderation_commentv2`, `comment_reaction_count_update`, and the
remaining `commentv3_*` functions (`ensure_topic`, `clamp_parent`, `v1_id_floor`,
`mirror_delete`, the eight `mirror_*_trigger`). Drop order for the tables: reaction/report join
tables first (they FK-reference the comment tables), then `Comment`/`CommentV2`, then `Thread`.
Also:

- Remove any remaining `Thread` entries from `schema-drift/drift-baseline.json` and update the
  remediation plan + its `production-plan.test.ts`, or the drift gate fails on a table that no
  longer exists.
- `DROP SCHEMA archive CASCADE` — the ten purge-archive tables (334,004 threads / 281,426
  comments / 5,868 reports; _Orphan purge_ step 8).
- **Leave the `Comment`/`CommentV2` values in the `EntityType` pg enum permanently.** Removing a pg
  enum value requires a type rewrite across every column using it, and historical `UserStrike`,
  `Appeal`, `JobQueue`, `EntityCollaborator`, and `ModerationRule` rows carry those values. Instead:
  new rows write `CommentV3`, and readers alias old values (`CommentV2` → id-direct, `Comment` →
  via `legacyV1Id`). Same policy for persisted strings elsewhere (notification `details.version`,
  ClickHouse event types, moderation queue keys).

### What we get to delete

`Thread` entirely; the recursive CTE in `getReplyThreads`; the dynamic
`as unknown as Prisma.ThreadWhereUniqueInput` casts (7 sites); the entity COALESCE chain (9 sites
plus the four added since); the v1/v2 UNIONs in notifications; one CDC handler; the duplicate
reaction and report join tables (four tables become two); the `commentOld` reaction type and one
`ReportEntity` value; the `{ commentIds, commentV2Ids }` dual-id API shape; the duplicated
exclusion logic; `src/server/common/thread-chain.ts` (its 100-deep ancestor walk,
`seededThreadChainCte` and `threadIsRooted`), which `path @>` replaces for the lock check, the
mute check and block-hide alike.

### Explicitly not migrated

- `clubPost` threads — clubs are dead code; rows (if any) are left behind and dropped with Thread.
- `question`/`answer` — decided (decision 1): not migrated; rows drop with Thread, and
  `QuestionAnswerComments.tsx` + `question/answer.metrics.ts` retire alongside.
- Comments attached to orphaned Threads (all entity FKs null) — purged and archived 2026-10-19;
  the backfill still skips any that recur (inventory in _Orphaned-thread comments — decided_).

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
