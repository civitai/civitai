-- The other half of 20260831200000_clear_orphaned_licensing_source: the same predicate, with the
-- bound inverted, for the versions that one deliberately left alone.
--
-- That migration scoped itself to versions created on or after the LicensingRoot table's first rows
-- (2026-07-15 21:56:17 UTC) because an older version may have been offered a checkpoint's root by a
-- retired picker, and clearing one would take income from a creator who chose to earn it. Justin
-- ruled on 2026-09-02 that the state is wrong regardless and is to be corrected, so the carve-out
-- goes (CU 868kwf2fd).
--
-- Measured on prod the same day: 23 rows match, unchanged from the 23 that migration left. All 23
-- predate the table, all are model-type mismatches only (0 have a base model that disagrees with
-- their source), none lands on a Checkpoint model, and none has been touched since 2026-07-14. The
-- in-scope half is still 0, i.e. nothing has re-entered the state the earlier migration cleared.
--
-- `ModelVersion."createdAt"` is `timestamp without time zone` holding UTC, so the bound must be a
-- TIMESTAMP literal -- a TIMESTAMPTZ one resolves through the applying session's unpinned TimeZone.
--
-- Raw SQL does not fire Prisma's `@updatedAt`, so nothing invalidates the caches the fee is read
-- from. POST the repaired ids to /api/v1/model-versions/bust-cache as one `versionIds` array (max
-- 500) after applying, as a moderator -- a non-moderator session only busts its own versions.
UPDATE "ModelVersion" mv
SET "licensingSourceVersionId" = NULL
WHERE mv."licensingSourceVersionId" IS NOT NULL
  AND mv."createdAt" < TIMESTAMP '2026-07-15 21:56:17'
  AND NOT EXISTS (
    SELECT 1
    FROM "LicensingRoot" lr
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE lr."modelVersionId" = mv."licensingSourceVersionId"
      AND lr."baseModel" = mv."baseModel"
      AND lr."modelType" = m."type"
  );
