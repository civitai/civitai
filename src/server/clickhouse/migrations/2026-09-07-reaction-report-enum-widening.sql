-- Reaction + report enum widening — ClickHouse DDL.
--
-- Apply this MANUALLY. We do not auto-run DDL (same policy as the Postgres migrations).
--
-- 🔴 THIS FILE IS PART "ALREADY APPLIED", PART "STILL TO APPLY". Read the section headers.
-- Sections 1 and 2 were applied by hand on 2026-09-07 and are recorded here so the history
-- exists in the repo and so the drift guard can see the definitions. Sections 3, 4 and 5
-- have NOT been applied.
--
-- WHY THIS FILE EXISTS AT ALL. The enum-drift guard in this directory's sibling test only
-- ever covered `actions.type`. Every other enum column the tracker writes was unchecked,
-- and three of them had drifted:
--
--   * `reactions.nsfw` did not carry 'Blocked', which the app has emitted since
--     NsfwLevelDeprecated gained that member. Measured over a 2h38m window on 2026-09-07:
--     7 of 10 tracker rejections were this one value, all from real users — on the order of
--     ~387 rows/day discarded.
--   * `reports.reason` did not carry 'Spam' or 'StickerPlacement', both of which exist in
--     the Prisma ReportReason enum and are reachable from the report form.
--   * `reactions.type` does not carry 'Post_Create' or 'Post_Delete', which the reaction
--     controller has constructed in its `case 'post':` branch for as long as that branch
--     has existed. An `as ReactionType` cast at the call site is why the type system never
--     saw it; that cast is removed in the same change as this file.
--
-- 🔴 THE FAILURE IS SILENT AND CLIENT-SIDE. The app POSTs to the tracker service
-- fire-and-forget; a value the target column does not carry is rejected THERE, while it is
-- serializing the batch, before ClickHouse is ever asked. So the caller sees a successful
-- send, the app logs nothing, `SHOW CREATE TABLE` looks fine, and the rows simply never
-- exist. A dashboard over them reads a clean zero that is indistinguishable from
-- "nobody did this".
--
-- 🔴 THE DDL IS ONLY HALF THE OPERATION. `civitai-clickhouse-tracker` builds its column
-- serializers from the schema its pods read AT CONNECT TIME and never re-reads them, so a
-- value added after those pods booted is still rejected client-side. The tracker service
-- must be restarted so it re-reads the column schema, or the ALTER verifies perfectly and
-- the value still collects ZERO rows. See ./README.md — this has shipped broken twice.
--
-- Every section below appends at an unused index, which is a metadata-only ALTER: no data
-- is rewritten and no mutation is scheduled. `MODIFY COLUMN` REPLACES the whole enum
-- definition, so each statement restates every existing value at exactly the index it
-- already has. Do NOT renumber or rename an existing value; that WOULD rewrite the table
-- and silently remap existing rows.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.


-- =====================================================================================
-- 1. reactions.nsfw — ✅ APPLIED TO PRODUCTION 2026-09-07T23:00:20Z (tracker restarted)
--
--    Adds 'Blocked' = 5. Recorded here for history; re-applying it is a no-op.
--    'Undefined' = 0 has no counterpart in NsfwLevelDeprecated and is kept as-is — the
--    column is allowed to be wider than the app domain, never narrower.
-- =====================================================================================

ALTER TABLE default.reactions
  MODIFY COLUMN `nsfw` Enum8(
    'Undefined' = 0,
    'None' = 1,
    'Soft' = 2,
    'Mature' = 3,
    'X' = 4,
    'Blocked' = 5
  );


-- =====================================================================================
-- 2. reports.reason — ✅ APPLIED TO PRODUCTION 2026-09-07T23:00:20Z (tracker restarted)
--
--    Adds 'Spam' = 8 and 'StickerPlacement' = 9, matching the Prisma ReportReason enum.
--    Recorded here for history; re-applying it is a no-op.
-- =====================================================================================

ALTER TABLE default.reports
  MODIFY COLUMN `reason` Enum8(
    'TOSViolation' = 1,
    'NSFW' = 2,
    'Ownership' = 3,
    'AdminAttention' = 4,
    'Claim' = 5,
    'CSAM' = 6,
    'Automated' = 7,
    'Spam' = 8,
    'StickerPlacement' = 9
  );


-- =====================================================================================
-- 3. reactions.type — ⚠️ NOT YET APPLIED. Adds 'Post_Create' = 17, 'Post_Delete' = 18.
--
-- 🔴🔴 SECTIONS 3 AND 4 ARE ONE OPERATION. APPLY BOTH, IN THIS ORDER, IN ONE SITTING.
--
--    `reactions_owner_scores_mv` (section 4) scores a reaction +1 if its type is in an
--    explicit list of '*_Create' values and **-1 for everything else**. There is no
--    "unknown" arm. So widening this column WITHOUT widening that list does not merely
--    fail to count post reactions — it makes every single one of them DECREMENT the
--    content owner's score. That converts the current, recoverable failure (rows are
--    dropped) into an unrecoverable one (rows land, carrying the wrong sign, into an
--    aggregate that has no source of truth to rebuild from).
--
--    If you apply only one of the two, apply NEITHER. Dropping post reactions for another
--    day is strictly better than corrupting owner scores for an hour.
-- =====================================================================================

ALTER TABLE default.reactions
  MODIFY COLUMN `type` Enum8(
    'Image_Create' = 1,
    'Image_Delete' = 2,
    'Comment_Create' = 3,
    'Comment_Delete' = 4,
    'CommentV2_Create' = 5,
    'CommentV2_Delete' = 6,
    'Review_Create' = 7,
    'Review_Delete' = 8,
    'Question_Create' = 9,
    'Question_Delete' = 10,
    'Answer_Create' = 11,
    'Answer_Delete' = 12,
    'BountyEntry_Create' = 13,
    'BountyEntry_Delete' = 14,
    'Article_Create' = 15,
    'Article_Delete' = 16,
    'Post_Create' = 17,
    'Post_Delete' = 18
  );


-- =====================================================================================
-- 4. reactions_owner_scores_mv — ⚠️ NOT YET APPLIED. THE OTHER HALF OF SECTION 3.
--
--    Adds 'Post_Create' to the +1 list. Everything not in this list scores -1, which is
--    why this cannot lag behind section 3 by even one deploy. The rest of the query —
--    the target table, the 2024-04-27 self-reaction cutoff, the GROUP BY — is restated
--    byte-for-byte from the live definition; MODIFY QUERY replaces the whole SELECT.
--
--    'Post_Delete' is deliberately NOT added: a delete is a -1, which is what the
--    fall-through arm already gives it. Only the '*_Create' half of a pair belongs here.
-- =====================================================================================

ALTER TABLE default.reactions_owner_scores_mv
  MODIFY QUERY
    SELECT
      ownerId,
      sum(multiIf((type IN (
        'Image_Create',
        'Comment_Create',
        'CommentV2_Create',
        'Review_Create',
        'Question_Create',
        'Answer_Create',
        'BountyEntry_Create',
        'Article_Create',
        'Post_Create'
      )), 1, -1)) AS score
    FROM default.reactions
    WHERE (time < parseDateTimeBestEffort('2024-04-27')) OR (userId != ownerId)
    GROUP BY ownerId;


-- =====================================================================================
-- 5. reports.entityType — ⚠️ NOT YET APPLIED. A FOURTH GAP, found by the new guard.
--
--    The report form accepts every member of the ReportEntity enum
--    (src/shared/utils/report-helpers.ts), but the column stops at 'chat' = 12. Reports
--    filed against a challenge, a comic project, a 3D model or a 3D-model review are
--    therefore dropped by the tracker today, exactly like the three gaps above. The
--    report itself is written to Postgres normally — only the ClickHouse analytics row
--    is lost — so this is under-reporting in moderation analytics, not lost moderation.
--
--    Independent of sections 3 and 4: no materialized view reads `reports`.
-- =====================================================================================

ALTER TABLE default.reports
  MODIFY COLUMN `entityType` Enum8(
    'model' = 1,
    'comment' = 2,
    'commentV2' = 3,
    'image' = 4,
    'resourceReview' = 5,
    'article' = 6,
    'post' = 7,
    'reportedUser' = 8,
    'collection' = 9,
    'bounty' = 10,
    'bountyEntry' = 11,
    'chat' = 12,
    'challenge' = 13,
    'comicProject' = 14,
    'model3d' = 15,
    'model3dReview' = 16
  );


-- =====================================================================================
-- POST-APPLY verification. Run all of it; a bare zero from any of these proves nothing on
-- its own, which is the whole failure mode this file documents.
-- =====================================================================================
--
--   SHOW CREATE TABLE default.reactions;
--     -- `type` must show 'Post_Create' = 17 and 'Post_Delete' = 18, with 1..16 unchanged.
--     -- `nsfw` must show 'Blocked' = 5.
--
--   SHOW CREATE TABLE default.reports;
--     -- `reason` must show 'Spam' = 8 and 'StickerPlacement' = 9, with 1..7 unchanged.
--     -- `entityType` must show 13..16 added, with 1..12 unchanged.
--
--   SHOW CREATE TABLE default.reactions_owner_scores_mv;
--     -- the IN list must contain 'Post_Create'. 🔴 If section 3 is live and this is not,
--     -- STOP: post reactions are actively decrementing owner scores.
--
-- Positive control, AFTER the tracker has been restarted — react to a post, then:
--
--   SELECT type, count() FROM default.reactions
--   WHERE type IN ('Post_Create', 'Post_Delete') AND time > now() - INTERVAL 1 HOUR
--   GROUP BY type;
--     -- must be non-zero. A zero here means the tracker was not restarted (its serializers
--     -- predate the ALTER), NOT that the enum is missing — this file rules the enum out.
--
--   SELECT count() FROM default.reactions
--   WHERE nsfw = 'Blocked' AND time > now() - INTERVAL 1 DAY;
--     -- non-zero since 2026-09-07 confirms section 1 is landing rows rather than merely
--     -- existing in the schema.
