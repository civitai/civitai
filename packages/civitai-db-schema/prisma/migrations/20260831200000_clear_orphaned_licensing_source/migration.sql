-- Clears ModelVersion."licensingSourceVersionId" where the stored source is no longer a valid
-- licensing root for that version: no LicensingRoot row for it, its baseModel differs from the
-- version's, or its modelType differs from the type of the Model the version now lives on.
--
-- Such a row charges the ROOT owner's per-image licence fee to everyone who generates with the
-- derivative, on a line labelled with the derivative's own name. upsertModelVersionHandler coerces
-- this same predicate, but only on the owner's next save of that version, which may never come --
-- hence this one-shot repair. Every row it touches is one the app would refuse to write today.
--
-- Scoped to versions created on or after the LicensingRoot table's first rows (2026-07-15 21:56:17
-- UTC). Older versions predate the table, when a retired picker may legitimately have offered a
-- checkpoint's root to a non-Checkpoint version -- clearing one takes income from a creator who
-- chose to earn it. Measured on prod 2026-08-31: 29 rows in scope, 23 older ones left alone
-- pending Justin's decision, tracked on CU 868kwf2fd.
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
  AND mv."createdAt" >= TIMESTAMP '2026-07-15 21:56:17'
  AND NOT EXISTS (
    SELECT 1
    FROM "LicensingRoot" lr
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE lr."modelVersionId" = mv."licensingSourceVersionId"
      AND lr."baseModel" = mv."baseModel"
      AND lr."modelType" = m."type"
  );
