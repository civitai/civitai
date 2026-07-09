-- Licensing lineage: a ModelVersion can inherit another version's licensing fee
-- via licensingSourceVersionId (e.g. a checkpoint built on Anima-Turbo points at
-- the turbo version so it charges the turbo fee, not the base-model rule).
-- Decoupled from baseModel so gen-compat / leaderboards / filters are unaffected.
-- Resolution order per resource: own licensingFee -> licensingSource's fee ->
-- (baseModel, modelType) BaseModelLicensingFee fallback.
--
-- NOTE: applied MANUALLY (this repo does NOT use `prisma migrate deploy`).

-- a) Add the nullable column. Existing rows default NULL = current fallback
--    behavior, so this is a no-op for everything until authors opt in.
ALTER TABLE "ModelVersion" ADD COLUMN "licensingSourceVersionId" INTEGER;

-- b) Self-referencing FK. NOT VALID first so we don't hold ACCESS EXCLUSIVE
--    while scanning this large, hot table; VALIDATE then runs under SHARE
--    UPDATE EXCLUSIVE (does not block concurrent reads/writes). All rows are
--    NULL at add time so validation is effectively a no-op, but keep the
--    two-step pattern for consistency with the rest of the repo.
ALTER TABLE "ModelVersion"
  ADD CONSTRAINT "ModelVersion_licensingSourceVersionId_fkey"
  FOREIGN KEY ("licensingSourceVersionId") REFERENCES "ModelVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "ModelVersion"
  VALIDATE CONSTRAINT "ModelVersion_licensingSourceVersionId_fkey";

-- c) Index the referencing column. The FK is ON DELETE SET NULL, so without
--    this every ModelVersion delete would seq-scan to find referencing rows.
--    The column is all-NULL right now, so the build is instant.
CREATE INDEX "ModelVersion_licensingSourceVersionId_idx"
  ON "ModelVersion" ("licensingSourceVersionId");
