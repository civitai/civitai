# CommentV3 Phase 5: post-flip cleanup

Built 2026-11-09, deployed 2026-11-10.

Every surface reads and writes CommentV3 since the model flip (#8282). Phase 5 removes what the
flips left behind, so that no live comment path reads or writes the old comment tables (`Comment`,
`CommentReaction`, `CommentReport`, `CommentV2`, `CommentV2Reaction`, `CommentV2Report`, `Thread`,
`ThreadMute`): only the readers and the reaction erasure listed under "Kept, with reasons" still
touch them. The checklist is `docs/comments-consolidation-checklist.md` → "Phase 5"; the wider
plan is `docs/comments-consolidation.md`.

**Scope (Briant, 2026-11-09):** Phase 5 plus every code removal the checklist lists under Phase 6's
"Transition code to remove". No data is dropped: the old tables, their rows and the mirror's trigger
functions stay for Phase 6's database teardown.

**Built as if the model flip's soak were over.** Removing `syncOldRows` and the reverse copy ends
the rollback: once this ships, the old tables stop following CommentV3, and nothing can copy
CommentV3 back into them. There is no rollback path to the old tables after this. Do not merge
before the soak has really ended.

## Deploy

1. Apply migration `20270101120000_comment_v3_old_table_triggers_off` by hand, before the deploy. It
   drops the eight `commentv3_mirror` triggers and `trg_moderation_comment`/`_v2`. With nothing
   keeping the old rows current, any write still reaching an old row would reach the live comment:
   a delete (a cascade, the purge) deletes or tombstones it, a `Comment` update copies the whole
   stale row over it, and a `CommentV2` update copies the columns it changed. Until the deploy, the
   old code's `syncOldRows` writes values CommentV3 already holds, so dropping the mirror first
   costs nothing on every surface that writes CommentV3. On 3D model reviews, a ban, scam hide,
   account wipe or moderator delete made between the migration and the deploy no longer reaches
   the comment's CommentV3 copy (nothing renders those comments).
2. Deploy the main app, the moderator app and the event engine together: the mod comment endpoints
   take `commentIds` now, and the event engine's `comment-v2.ts` handler is gone.
3. Right after the deploy, run the "Stored records" SQL under "Hand-run SQL" on both databases.
4. Once the deploy is healthy, run the old comment purge.

All four steps ran on prod on 2026-11-10.

## Live bugs fixed

- **Review comment count.** `getResourceReview` read `Thread.commentCount`, which only the CommentV2
  insert trigger maintains, so a review's page showed its pre-flip count (0 for a new review). It
  counts CommentV3 now, and a new review no longer creates an empty `Thread`.
- **Legacy reaction check.** `holdsReaction` looked for a no-longer-offered reaction (Dislike) in
  `CommentV2Reaction` while the toggle acts on `CommentV3Reaction`, so a removed legacy Dislike
  could come back, and on a model comment it could not be removed. It reads `CommentV3Reaction`.
- **Moderator text-scan lab.** It had no `CommentV3` type and loaded comment ids from CommentV2, so a
  post-flip comment was "not found", and its test-set purge wiped stored cases of post-flip
  comments as deleted. It gains `CommentV3` (`/comments/<id>` and `/comments/v2/<id>` links; a
  model-page link resolves through `legacyV1Id`), and the purge checks CommentV3.

## Removed

- **Old-row sync:** `syncOldRows` (edit, delete, flags, lock) in `commentv3/write.service.ts`.
- **Surface switches:** `constants.comments.v3ReadSurfaces`/`v3WriteSurfaces`, `isV3WriteSurface`,
  `v3WriteSurfaceSql`, `hasV3SurfaceTwinSql`, `v3SurfaceCommentIds`, `v3WriteCommentIds`.
  `deepLinkParentId` is the comment's `parentId`.
- **`commentsv2.service.ts`.** `getThreadEntityOwnerId`/`isViewerContentOwner` moved to
  `comment-owner.service.ts`, `getJudgeCommentForImage` to `challenge-judge-review.service.ts`; the
  bulk delete is `bulkDeleteComments` (`commentv3/moderation.service.ts`); the ToS endpoints call the
  CommentV3 set and clear.
- **New comments and edits on 3D model reviews** are refused (the owner's hide and pin too): nothing
  renders those comments, and the surface was never a CommentV3 write surface. It keeps its owner
  lookups.
- **CommentV2 arms** in reactions, block checks (`thread-chain.ts` deleted), block-hide, the ban,
  the account wipe, scam cleanup, storyline delete, the points hooks, and report creation.
- **Block-hide** reads one CommentV3 join from the blocker's sections (`SECTION_OWNERS`) to the
  blocked user's comments. Measured on the prod replica (2026-11-09): for the heaviest commenter
  about 50 ms (the old per-comment owner lookup ran past its 5 s timeout above roughly 40k comments,
  and the hide failed); against the heaviest owner 2.2 s. The ban's ToS flag updates in batches of
  1,000 (`setFlagsInBatches`); scam cleanup stays one transaction, so its record matches what it hid.
- **Moderation queue:** the `Comment`/`CommentV2` entries in `entity-moderation.ts` and the Clavata
  cutover set.
- **Text scan:** the `Comment`/`CommentV2` entity types and their scan profiles
  (`comment.profile.ts`, `comment-v2.profile.ts`), their CSAM-hold cases and Clavata targets. The
  scam adapter's cleanup kind for comments is `comments`; `restore()` still restores a stored
  `commentsV2` record as it is, since its ids are CommentV3 ids.
- **Dead code:** `getImageThread` in `@civitai/db-queries` and its parity cases; the moderator
  app's `CommentTopic` delete ahead of an article (the partition FK cascade removes it).
- **Transition tooling:** the backfill and reverse-copy services, the admin backfill endpoint, and
  the daily parity job with its gauge.
- **Event engine:** `comment-v2.ts` and `COMMENT_V3_SURFACES` (`comment-v3.ts` counts the comments
  of every surface in its `SURFACES` map; crucible and storyline are deliberately not counted, as
  before), `public.Comment`/`public.CommentV2` in the CDC config, Kafka topic and replica-identity
  scripts, and the one-off `backfill-user-comment-count.mjs`.
- **Reports:** `ReportEntity.Comment`/`CommentV2` are gone, so new reports on them are refused; the
  old types leave `ReportModal.tsx`, `report-helpers.ts` and the shared `OWNED_REPORT_TABLES`. Old
  report rows keep their type, and every old link whose comment reached CommentV3 is in
  `CommentV3Report`.

## Changed contracts

- **Mod endpoints** `comment/bulk-delete`, `remove-as-tos`, `restore-from-tos`: input `{ commentIds }`
  (was `commentV2Ids`); output `{ deleted }` / `{ comments: { … } }`. The catalog is regenerated.
- **Moderator app:**
  - Comment reports list once, under the CommentV3 type. The comment queue is `/reports/comment`,
    the old CommentV2 address, so saved links keep working; `/reports/model-comment` and
    `/reports/comment-v3` are gone and answer 404.
  - A user's comments are one list, newest first, capped at 50. User Lookup's comment ToS and hidden
    counts cover every surface, so they rise: tell the mod team.
  - Saved relabel snapshots, lab test cases and CSAM holds stored as `Comment`/`CommentV2` are
    rewritten to `CommentV3` by the hand-run SQL right after the deploy. Until then they show their
    raw type and no link.

## Kept, with reasons

The Phase 5 state, superseded by Phase 6 (`docs/plans/comments-v3-phase6.md`). These stayed until
Phase 6's teardown:

- **The old tables and their rows**, and the mirror's trigger functions (Phase 6 drops them before
  the tables they take as row types).
- **Personal-data export and reaction erasure** (`personal-data-export/registry.ts`,
  `user-reaction-erasure.service.ts`) still cover the old tables: the rows are still held.
- **CSAM evidence:** the comment archive (`archiveUserComments`) and the hold context text
  (`csam-context-text.ts`) still read the CommentV2 rows that never reached CommentV3, so an
  author's evidence stays complete until those rows are purged or dropped.
- **`legacyV1Id` resolution** of old model-comment links and notifications, which reads CommentV3.
- **The `comment-v3-mirror.sql.behavior` test** and the fixture it loads, which go with the mirror's
  functions.
- **Moderator DB:** `ModerationQueueMetrics.Comment`/`CommentV2` columns belong to the external job
  that writes them; their hand-off stays with that job's owner.

## Deferred after this PR (Group B)

Names still carrying `CommentV2`; tracked in the checklist's "Deferred after Phase 5 (Group B)".
None blocks Phase 6.

- **`mode.ts`'s CommentV3 → CommentV2 rollout fallback** is removed in Phase 5.5, after CommentV3
  was given its own rollout on 2026-11-10 (removing it first would have stopped comment scanning).
  CommentV3 now reads only its own field, so a `null` write turns comment scanning off. Left:
  delete the stale `Comment` and `CommentV2` fields of `system:text-scan:modes` once it deploys.
- **Kept as permanent labels** (decided 2026-11-10), because each names stored history elsewhere:
  ClickHouse `CommentV2_*` events, event points' `CommentV2:` source keys, and the Buzz entity
  type `'CommentV2'`.

## Hand-run SQL

**Stored records of the old comment types.** No code reads `Comment` or `CommentV2` as a stored
entity type any more, so the rows that still carry one are rewritten to `CommentV3` once, on the
primary, right after the deploy. A `CommentV2` id is the CommentV3 id; a `Comment` id is a v1 id,
which maps through `legacyV1Id`. After the deploy, not before: the old code would read a rewritten
`comments` cleanup record as v1 ids and could restore the wrong comment. The new code restores a
not-yet-rewritten record correctly: a `commentsV2` record as it is (CommentV3 ids), and a `comments`
record on a `Comment` trigger through `legacyV1Id` (`scam-cleanup.service.ts`). Until it runs, a
scam review shows no text for an old-type trigger.

- Scam restrictions: each trigger's `entityType`/`entityId`, and its cleanup record. The cleanup
  kind for comments is `comments` (CommentV3 ids): `commentsV2` records keep their ids; an old
  `comments` record held v1 ids, and is told apart by its trigger's `Comment` type, which the new
  code never writes. Every rewritten record is marked `migrated`, so a second run maps nothing
  twice even where a trigger keeps the `Comment` type (below), and the new restore reads it as
  CommentV3 ids.
- CSAM text holds of either type. A `Comment` hold or trigger whose v1 id never reached CommentV3
  keeps its type rather than take a number that names an unrelated comment: it stays visible with
  no link, and a hold of it cannot be removed (on prod, every one maps).
- Queue rows (`JobQueue`) and scan results (`EntityModeration`, plain and `:shadow`) of either type,
  which nothing processes or reads any more: deleted.

Before running it, check that no comment has a Pending hold under both an old type and `CommentV3`
(`TextScanHold` allows one Pending hold per entity): the rewrite would hit that index and roll the
whole transaction back. On prod today the only old-type holds are Dismissed.

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';

UPDATE "UserRestriction" r SET triggers = (
  SELECT jsonb_agg(z.t ORDER BY z.ord) FROM (
    SELECT e.ord, CASE
      WHEN e.t->'cleanup'->>'kind' = 'commentsV2'
        THEN jsonb_set(jsonb_set(e.t, '{cleanup,kind}', '"comments"'), '{cleanup,migrated}', 'true')
      WHEN e.t->'cleanup'->>'kind' = 'comments' AND e.t->>'entityType' = 'Comment'
        AND NOT (e.t->'cleanup' ? 'migrated')
        THEN jsonb_set(jsonb_set(e.t, '{cleanup,ids}', COALESCE((
               SELECT jsonb_agg(v.id ORDER BY v.id) FROM "CommentV3" v
               WHERE v."legacyV1Id" IN (SELECT x::int FROM jsonb_array_elements_text(e.t->'cleanup'->'ids') x)
             ), '[]'::jsonb)), '{cleanup,migrated}', 'true')
      ELSE e.t END AS t1
    FROM jsonb_array_elements(r.triggers) WITH ORDINALITY e(t, ord)
  ) y, LATERAL (SELECT y.ord, CASE
      WHEN y.t1->>'entityType' = 'CommentV2' THEN jsonb_set(y.t1, '{entityType}', '"CommentV3"')
      WHEN y.t1->>'entityType' = 'Comment' AND m.id IS NOT NULL
        THEN jsonb_set(jsonb_set(y.t1, '{entityType}', '"CommentV3"'), '{entityId}', to_jsonb(m.id))
      ELSE y.t1 END AS t
    FROM (SELECT 1) one
    LEFT JOIN "CommentV3" m ON y.t1->>'entityType' = 'Comment'
      AND m."legacyV1Id" = (y.t1->>'entityId')::int) z)
WHERE r.type = 'scam' AND jsonb_typeof(r.triggers) = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.triggers) t
              WHERE t->>'entityType' IN ('Comment', 'CommentV2') OR t->'cleanup'->>'kind' = 'commentsV2');

UPDATE "TextScanHold" h SET "entityType" = 'CommentV3', "entityId" = v.id
FROM "CommentV3" v WHERE h."entityType" = 'Comment' AND v."legacyV1Id" = h."entityId";
UPDATE "TextScanHold" SET "entityType" = 'CommentV3' WHERE "entityType" = 'CommentV2';

DELETE FROM "JobQueue" WHERE "entityType" IN ('Comment', 'CommentV2');
DELETE FROM "EntityModeration"
WHERE "entityType" IN ('Comment', 'CommentV2', 'Comment:shadow', 'CommentV2:shadow');

COMMIT;
```

On the moderator database, the relabel items carry the old report slugs. `commentV2` keeps its id:

```sql
UPDATE text_relabel_item SET entity_type = 'commentV3' WHERE entity_type = 'commentV2';
UPDATE text_scan_test_case SET entity_type = 'CommentV3' WHERE entity_type = 'CommentV2';
```

Text-scan lab test cases of the old types are rewritten too. None exist today; a `Comment` case
would need the same v1-id mapping as the relabel items below, minding the
`(set_id, entity_type, entity_id)` unique key.

The `comment` relabel items hold v1 ids, which live in the main database. Map them by building the pairs
on the main replica (`SELECT "legacyV1Id", id FROM "CommentV3" WHERE "legacyV1Id" = ANY(<ids>)`)
and updating each item's `entity_id` with `entity_type = 'commentV3'`; an item whose comment never
reached CommentV3 keeps its id under `commentV3` and resolves to nothing, as it already does.

**Old comment purge.** The orphan purge in the checklist (Phase 5, first item): sizes on the
replica first, then the four deletes in order, applied by hand to each writable environment. With
the mirror dropped, its deletes touch only the old tables.

## Phase 5.5 and what is left

Phase 5.5 (its own PR, Briant 2026-11-09) holds the shared notification builder, the exclusion
helper and the removal of the `mode.ts` fallback. The remaining items are tracked in
`docs/comments-consolidation-checklist.md` → "Phase 5" and "Phase 5.5".
