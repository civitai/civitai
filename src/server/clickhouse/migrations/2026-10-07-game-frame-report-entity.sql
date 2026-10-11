-- reports.entityType — add 'gameFrameGame'. ClickHouse DDL.
--
-- Apply this MANUALLY. We do not auto-run DDL (same policy as the Postgres migrations).
--
-- WHY. `ReportEntity` (src/shared/utils/report-helpers.ts) gains 'gameFrameGame' for Civitai Games
-- reports, and tracker-enum-drift.test.ts holds the column to every value of that enum. Nothing emits
-- it yet: game reports are filed by Game Frame's server through /api/internal/game-frame/reports,
-- which has no tRPC context and does not call `ctx.track.report`. So the apply order relative to the
-- deploy does not matter. The restart below is still needed, so a later emitter is not silently
-- dropped by a tracker holding the old enum.
--
-- `MODIFY COLUMN` REPLACES the whole enum definition, so the statement below restates every
-- existing value at exactly the index it already has (./2026-10-01-crucible-report-entity.sql) and
-- appends at an unused index — a metadata-only ALTER. Do NOT renumber or rename an existing value.
--
-- TO ROLL BACK: re-run the statement below with 'gameFrameGame' = 19 removed, having first confirmed
-- `SELECT count() FROM default.reports WHERE entityType = 'gameFrameGame'` is 0.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.
-- (No game report emits a tracker event yet; until one does, confirm only that the restart happened.)

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
    'gameFrameGame' = 19
  );
