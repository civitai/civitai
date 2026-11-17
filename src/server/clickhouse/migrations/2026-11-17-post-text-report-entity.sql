-- reports.entityType — add 'postText'. ClickHouse DDL.
--
-- Apply this MANUALLY, BEFORE the code that emits it deploys. We do not auto-run DDL (same policy as
-- the Postgres migrations).
--
-- WHY. `ReportEntity` gains 'postText'. Until this is applied, the tracker silently drops those
-- report events (the report still lands in Postgres).
--
-- `MODIFY COLUMN` replaces the whole enum: every existing value is restated at its index and the new
-- one appended. Do NOT renumber or rename an existing value.
--
-- TO ROLL BACK: re-run the statement below with 'postText' = 23 removed, having first confirmed
-- `SELECT count() FROM default.reports WHERE entityType = 'postText'` is 0.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.

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
    'commentV3' = 22,
    'postText' = 23
  );
