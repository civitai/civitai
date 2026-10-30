-- reports.entityType — add 'commentV3'. ClickHouse DDL.
--
-- Apply this MANUALLY, BEFORE the code that emits it deploys. We do not auto-run DDL (same policy as
-- the Postgres migrations).
--
-- WHY. `ReportEntity` (src/shared/utils/report-helpers.ts) gains 'commentV3' for comments on the
-- surfaces that write CommentV3 directly (docs/plans/comments-v3-article-flip.md, stage B), and
-- tracker-enum-drift.test.ts holds the column to every value of that enum. Reports are filed
-- through the tRPC report router, which emits a tracker event, so a tracker holding the old enum
-- silently drops them (the report still lands in Postgres).
--
-- `MODIFY COLUMN` REPLACES the whole enum definition, so the statement below restates every
-- existing value at exactly the index it already has (./2026-10-15-service-offering-report-entity.sql)
-- and appends at an unused index — a metadata-only ALTER. Do NOT renumber or rename an existing value.
--
-- TO ROLL BACK: re-run the statement below with 'commentV3' = 22 removed, having first confirmed
-- `SELECT count() FROM default.reports WHERE entityType = 'commentV3'` is 0.
--
-- POST-APPLY: the tracker must pick up the new enum (ask an infra owner to restart it), then
-- confirm with a real event.

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
    'storyline' = 20,
    'serviceOffering' = 21,
    'commentV3' = 22
  );
