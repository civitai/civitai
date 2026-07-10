-- A2 — fractional licensing fee, RENAME-EXPAND (phase 3, step 1 of 2).
--
-- Goal: eliminate the @map by giving the decimal column its proper name, "licensingFee". A bare RENAME can't be
-- done under staged/rolling deploys (old pods query "licensingFeeAmount", new pods "licensingFee", one column
-- name at a time, and we never run a migration + deploy atomically), so this repeats the expand/contract
-- pattern: add the target-named column, keep both in sync during rollout, cut the code over. A later
-- RENAME-CONTRACT migration drops "licensingFeeAmount".
--
-- Prerequisite: the CONTRACT migration (20260710120000) is applied, so the old Int "licensingFee" is gone and
-- the name is free.
--
-- Safe to apply BEFORE this phase's code deploys (additive column + sync trigger; old pods ignore the new
-- column and keep using "licensingFeeAmount"). Applied manually per repo convention; idempotent.

ALTER TABLE "ModelVersion" ADD COLUMN IF NOT EXISTS "licensingFee" DECIMAL(10, 2);

UPDATE "ModelVersion"
  SET "licensingFee" = "licensingFeeAmount"
  WHERE "licensingFeeAmount" IS NOT NULL AND "licensingFee" IS NULL;

-- Both columns are DECIMAL(10,2), so the sync is EXACT in both directions (no rounding). Old (contract) pods
-- write "licensingFeeAmount"; new pods write "licensingFee"; the trigger mirrors whichever column changed.
CREATE OR REPLACE FUNCTION "syncModelVersionLicensingFeeRename"() RETURNS trigger AS $$
BEGIN
  IF NEW."licensingFee" IS DISTINCT FROM OLD."licensingFee" THEN
    NEW."licensingFeeAmount" := NEW."licensingFee";
  ELSIF NEW."licensingFeeAmount" IS DISTINCT FROM OLD."licensingFeeAmount" THEN
    NEW."licensingFee" := NEW."licensingFeeAmount";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "modelVersionLicensingFeeRenameSync" ON "ModelVersion";
CREATE TRIGGER "modelVersionLicensingFeeRenameSync"
  BEFORE INSERT OR UPDATE OF "licensingFee", "licensingFeeAmount" ON "ModelVersion"
  FOR EACH ROW EXECUTE FUNCTION "syncModelVersionLicensingFeeRename"();
