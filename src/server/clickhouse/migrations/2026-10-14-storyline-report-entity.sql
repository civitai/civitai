-- reports.entityType — add 'storyline'. ClickHouse DDL.
--
-- Apply this MANUALLY, BEFORE the code that emits it deploys. We do not auto-run DDL (same policy as
-- the Postgres migrations).
--
-- WHY. `ReportEntity` (src/shared/utils/report-helpers.ts) gains 'storyline', which
-- `createReportHandler` emits as `entityType` when someone reports a storyline from its page. The
-- column's newest definition — ./2026-10-07-game-frame-report-entity.sql — stops at
-- 'gameFrameGame' = 19.
--
-- 🔴 THE DDL IS HALF THE OPERATION AND THE OTHER HALF FAILS SILENTLY. See ./README.md: the tracker
-- rejects an unknown value client-side, so the send succeeds and the rows never exist until the
-- tracker is restarted after this DDL. The report still lands in Postgres, so what is lost is
-- moderation analytics, not moderation.
--
-- `MODIFY COLUMN` REPLACES the whole enum definition, so the statement below restates every
-- existing value at exactly the index it already has and appends at an unused index — a
-- metadata-only ALTER. Do NOT renumber or rename an existing value.
--
-- TO ROLL BACK: re-run the statement below with 'storyline' = 20 removed, having first confirmed
-- `SELECT count() FROM default.reports WHERE entityType = 'storyline'` is 0.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.
-- The real event: file a report against a storyline, then
-- `SELECT count() FROM default.reports WHERE entityType = 'storyline'` must be > 0.

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
    'model3dReview' = 16,
    'announcement' = 17,
    'crucible' = 18,
    'gameFrameGame' = 19,
    'storyline' = 20
  );
