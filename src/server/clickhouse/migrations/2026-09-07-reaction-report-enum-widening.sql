-- Reaction + report enum widening — ClickHouse DDL.
--
-- Apply this MANUALLY. We do not auto-run DDL (same policy as the Postgres migrations).
--
-- 🔴 EVERY SECTION IN THIS FILE IS NOW APPLIED. It is a history record, not a work list:
-- sections 1 and 2 on 2026-09-07, section 5 on 2026-09-08T04:04:14Z, and the coupled
-- 3+4 pair on 2026-09-08T18:08:24Z/:25Z. Re-applying any of them is a no-op. They are
-- recorded here so the history exists in the repo and so the drift guard can see the
-- definitions. The sections are numbered in the order they were WRITTEN, not the order they
-- were applied, so the numbering is not a running order: each section header carries its own
-- status and that is the only thing to trust here.
--
-- 🔴 "APPLIED" IS NOT "SAFE TO EDIT". The ordering constraint in section 3 and the
-- whole-statement warning in section 4 govern any REVERT just as they governed the apply,
-- and a revert of one half alone is the corruption this file exists to prevent.
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
-- Every ENUM section below (1, 2, 3, 5 — section 4 is a MODIFY QUERY, not a column change)
-- appends at an unused index, which is a metadata-only ALTER: no data
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
-- 3. reactions.type — ✅ APPLIED TO PRODUCTION 2026-09-08T18:08:24Z, with section 4 at
--    18:08:25Z — one second later — and the tracker pods replaced at 18:09:09Z and
--    18:09:32Z. Adds 'Post_Create' = 17, 'Post_Delete' = 18.
--
--    The POST-APPLY gap query below returned 0: no post reaction landed between the two
--    statements, so no owner score was decremented and none needs repair.
--
--    Recorded here for history; re-applying it is a no-op. 🔴 The warning below is NOT
--    historical trivia — it still governs any REVERT, and it is the reason this section
--    cannot be reverted on its own. See the rollback bundle and, in particular, its
--    ORDER, at <talos-infra>/claudedocs/clickhouse-enum-widening-2026-09-07/rollback-reaction-type.sql
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
--
-- 🔴 "IN ONE SITTING" IS NOT, BY ITSELF, PROTECTION — the window is opened by a pod restart
--    you do not control. The tracker builds its serializers from the schema it reads at
--    connect time, so the moment any tracker pod restarts after section 3 lands it starts
--    ACCEPTING 'Post_Create', with section 4 still unapplied. That deployment has been
--    observed replacing its pods on its own, with no human action, on the order of every few
--    hours — so the interval between the two statements is a live risk window, not a
--    formality, and working quickly narrows it rather than closing it.
--
--    Rows that land in that window are scored -1 by the old view body, and a materialized
--    view does NOT backfill: section 4 changes what is computed from the moment it is applied
--    and repairs nothing already written to `reactions_owner_scores`. So apply section 4
--    IMMEDIATELY after section 3 — and afterwards run the window query in the POST-APPLY
--    block at the foot of this file to find out whether anything landed in between. That
--    query is the only way to learn it happened; nothing alerts on it.
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
-- 4. reactions_owner_scores_mv — ✅ APPLIED TO PRODUCTION 2026-09-08T18:08:25Z.
--    THE OTHER HALF OF SECTION 3.
--
--    Verified by diffing the WHOLE statement against the pre-image recorded below, not by
--    reading the IN list: removing the single added 'Post_Create' from the live post-image
--    reproduces that pre-image character-for-character once whitespace is collapsed. The
--    multiIf arms, the 2024-04-27 cutoff, the FROM and the GROUP BY are provably unchanged.
--
--    Recorded here for history; re-applying it is a no-op.
--
--    Adds 'Post_Create' to the +1 list. Everything not in this list scores -1, which is
--    why this cannot lag behind section 3 by even one deploy.
--
--    'Post_Delete' is deliberately NOT added: a delete is a -1, which is what the
--    fall-through arm already gives it. Only the '*_Create' half of a pair belongs here.
--
-- 🔴 MODIFY QUERY REPLACES THE WHOLE SELECT, AND THIS VIEW MAINTAINS EVERY USER'S ALL-TIME
--    REACTION SCORE. `reactions_owner_scores` is read by `getReactionTasks` in
--    src/server/metrics/user.metrics.ts, which is where the number reaches users. So an edit
--    ANYWHERE in the statement below — the multiIf arms, the 2024-04-27 self-reaction cutoff,
--    the FROM, the GROUP BY — silently rewrites that score for everyone, and nothing about
--    applying it would look wrong. Two concrete examples, both of which leave the IN list
--    untouched and so pass any check that only reads the IN list: swapping the multiIf arms
--    (`, 1, -1)` -> `, -1, 1)`) scores every reaction -1; moving the cutoff forward disables
--    the self-reaction exclusion, so a user can farm their own score.
--
--    The rest of the query is therefore NOT a claim to take on trust. It is the live
--    definition, recorded below, and `tracker-enum-drift.test.ts` pins the whole statement
--    (whitespace-normalised) against that pre-image plus the one added value.
--
-- 🔴 THE LIVE PRE-IMAGE — read verbatim from production with
--    `SHOW CREATE TABLE default.reactions_owner_scores_mv` on 2026-09-08, i.e. after
--    sections 1, 2 and 5 were applied and while sections 3 and 4 are still unapplied:
--
--      CREATE MATERIALIZED VIEW default.reactions_owner_scores_mv TO default.reactions_owner_scores
--      (
--          `ownerId` Int32,
--          `score` Int64
--      )
--      AS SELECT
--          ownerId,
--          sum(multiIf((type IN ('Image_Create', 'Comment_Create', 'CommentV2_Create', 'Review_Create', 'Question_Create', 'Answer_Create', 'BountyEntry_Create', 'Article_Create')), 1, -1)) AS score
--      FROM default.reactions
--      WHERE (time < parseDateTimeBestEffort('2024-04-27')) OR (userId != ownerId)
--      GROUP BY ownerId
--
--    TO ROLL BACK: re-run the MODIFY QUERY below with 'Post_Create' removed from the IN list
--    and nothing else changed — that is exactly the SELECT above. 🔴 Roll back ONLY together
--    with reverting section 3; a narrowed view against a widened column is the sign-inversion
--    corruption described in section 3, arrived at from the other direction.
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
-- 5. reports.entityType — ✅ APPLIED TO PRODUCTION 2026-09-08T04:04:14Z. A FOURTH GAP,
--    found by the new guard, and applied by hand AFTER this file was first written — which
--    is why it sits below sections 3 and 4 and is nonetheless already live.
--
--    The report form accepts every member of the ReportEntity enum
--    (src/shared/utils/report-helpers.ts), but the column stopped at 'chat' = 12. Reports
--    filed against a challenge, a comic project, a 3D model or a 3D-model review were
--    therefore dropped by the tracker, exactly like the three gaps above. The COLUMN half of
--    that was closed at 2026-09-08T04:04:14Z; see the restart caveat below before reading
--    that as the end of the loss. The report itself is written to Postgres normally — only
--    the ClickHouse analytics row was lost — so this was under-reporting in moderation
--    analytics, not lost moderation.
--
--    ⚠️ THE TRACKER-RESTART HALF IS NOT RECORDED HERE. Sections 1 and 2 note the restart
--    explicitly because it was observed; for this section it was not, so treat 'is the
--    tracker actually writing these four values' as OPEN until the entityType positive
--    control in the POST-APPLY block below returns non-zero. The DDL landing is not the
--    same claim — that is this whole file's point.
--
--    Recorded here for history; re-applying it is a no-op.
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
--     -- 🔴 DIFF THE WHOLE STATEMENT against the pre-image recorded in section 4's header.
--     -- Checking that the IN list contains 'Post_Create' is NOT sufficient and must not be
--     -- what you do here: MODIFY QUERY replaced the entire SELECT, so a swapped multiIf sign
--     -- or a moved 2024-04-27 cutoff passes that check while changing every user's all-time
--     -- reaction score. The ONLY difference from the pre-image you should see is one added
--     -- element at the end of the IN list:
--     --     ..., 'Article_Create', 'Post_Create')), 1, -1)) AS score
--     -- Everything else — `multiIf(..., 1, -1)`, `parseDateTimeBestEffort('2024-04-27')`,
--     -- `userId != ownerId`, `FROM default.reactions`, `GROUP BY ownerId` — must be
--     -- character-identical ONCE WHITESPACE IS COLLAPSED. ClickHouse re-renders the statement
--     -- from its own parse rather than echoing what you sent, so its layout will not match
--     -- what you pasted; that difference is expected and is the only one that is.
--     -- 🔴 If section 3 is live and this is not, STOP: post reactions are actively
--     -- decrementing owner scores.
--
--   Did any post reaction land in the gap between section 3 and section 4? Those rows scored
--   -1, and a materialized view does not backfill, so section 4 does NOT repair them:
--
--   SELECT count() FROM default.reactions
--   WHERE type = 'Post_Create' AND time < '<the UTC instant section 4 was applied>';
--     -- Write the instant down when you run section 4 rather than reconstructing it later.
--     -- Non-zero means that many post reactions were scored -1 where they should have scored
--     -- +1, so each affected owner's all-time score is low by 2 per such reaction.
--     -- `reactions_owner_scores` is an aggregate with no source of truth to rebuild from, so
--     -- record the count and the affected ownerIds rather than assuming it washes out.
--     -- 'Post_Delete' is deliberately excluded: it scores -1 under both the old and the new
--     -- view body, so it cannot be mis-scored.
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
--
--   Section 5's positive control — the one that decides whether the tracker restart half of
--   that section ever happened. The DDL landed 2026-09-08T04:04:14Z; a restart was NOT
--   recorded, and until this returns rows the four widened values are still capable of being
--   rejected client-side by pods that connected before the ALTER:
--
--   SELECT entityType, count() FROM default.reports
--   WHERE entityType IN ('challenge', 'comicProject', 'model3d', 'model3dReview')
--   GROUP BY entityType;
--     -- No time predicate is needed and none is used: the column could not REPRESENT these
--     -- four values before 2026-09-08T04:04:14Z, so any row carrying one necessarily postdates
--     -- the ALTER. (Written this way deliberately — this file has not verified what the
--     -- `reports` table's timestamp column is called.)
--     -- 🔴 A zero here is ambiguous and must not be read as "fixed": it is equally consistent
--     -- with "the tracker was never restarted" and with "nobody has reported one of these
--     -- four entity types yet". Nobody has measured how often these four are reported, so
--     -- there is no basis for treating a zero as surprising. To settle it, file one report
--     -- against a challenge yourself and re-run — that converts an absence, which cannot
--     -- distinguish those two causes, into a real positive control, which can.
