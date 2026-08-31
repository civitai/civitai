-- Applied by hand. This repo does not run `prisma migrate deploy`.
--
-- Clears ModelVersion."licensingSourceVersionId" where the stored source is no longer a valid
-- licensing root for that version: no LicensingRoot row for it, its baseModel differs from the
-- version's, or its modelType differs from the type of the Model the version now lives on.
--
-- Such a row charges the ROOT owner's per-image licence fee to everyone who generates with the
-- derivative, on a line labelled with the derivative's own name, and no surface on the site can
-- clear it. The predicate below is the same rule upsertModelVersionHandler already coerces against,
-- so every row it touches is one the application would refuse to write today.
--
-- Scoped to versions created on or after the LicensingRoot table's own rows (2026-07-15 21:56:17
-- UTC). Versions older than that predate the table, when a retired picker may legitimately have
-- offered a checkpoint's root to a non-Checkpoint version — clearing one of those would take income
-- from a creator who chose to earn it. 23 such rows are deliberately left alone for a human call.
--
-- Measured on prod 2026-08-31: 52 rows fail the predicate, 29 of them on or after the cutoff
-- (22 LORA, 1 Other, 1 ComfyWorkflows, 5 Checkpoints whose baseModel no longer matches their root).
--
-- Idempotent: re-running it matches nothing new.
--
-- `ModelVersion."createdAt"` is `timestamp without time zone` holding UTC wall-clock, so the bound is
-- written as TIMESTAMP, not TIMESTAMPTZ. A TIMESTAMPTZ literal is resolved through the APPLYING
-- SESSION's TimeZone, which is unpinned when a human runs this by hand — and the boundary is the one
-- thing this migration has to get exactly right.
--
-- Raw SQL does not fire Prisma's `@updatedAt`, so the repaired rows keep their timestamps and do not
-- all surface as freshly updated at once. That also means nothing invalidates the caches the fee is
-- read from: run POST /api/v1/model-versions/bust-cache (moderator-scoped) for each affected id
-- after applying. The application path does its own bust, one owner save at a time.
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
