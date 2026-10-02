-- reports.entityType — add 'crucible'. ClickHouse DDL.
--
-- Apply this MANUALLY, BEFORE the code that emits it deploys. We do not auto-run DDL (same policy as
-- the Postgres migrations).
--
-- ✅ COLUMN APPLIED 2026-09-30: `default.reports.entityType` carries 'crucible' = 18 on both replicas,
-- 1..17 unchanged, no mutation scheduled.
-- 🔴 The tracker-restart half is NOT recorded. Treat "is the tracker actually writing this value" as
-- OPEN until the positive control below returns non-zero.
--
-- WHY. `ReportEntity` (src/shared/utils/report-helpers.ts) gains 'crucible', which
-- `createReportHandler` emits as `entityType`. The column's newest definition —
-- ./2026-09-10-announcement-report-entity.sql — stops at 'announcement' = 17.
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
-- TO ROLL BACK: re-run the statement below with 'crucible' = 18 removed, having first confirmed
-- `SELECT count() FROM default.reports WHERE entityType = 'crucible'` is 0.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.
-- The real event: file a report against a crucible, then
-- `SELECT count() FROM default.reports WHERE entityType = 'crucible'` must be > 0.

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
    'crucible' = 18
  );
