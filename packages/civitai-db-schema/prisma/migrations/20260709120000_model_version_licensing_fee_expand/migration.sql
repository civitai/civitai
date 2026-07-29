-- A2 — fractional licensing fee, EXPAND phase (safe under staged / rolling deploys).
--
-- Adds a NEW decimal column alongside the existing INTEGER `licensingFee`, which is left UNTOUCHED so old
-- pods keep reading it with their old (Int) Prisma client. New code maps the Prisma field `licensingFee` to
-- this `licensingFeeAmount` column and reads/writes it. A bidirectional BEFORE trigger keeps the two columns
-- in sync during the rollout window:
--   * new code writes `licensingFeeAmount` (fractional) -> mirror to `licensingFee` = FLOOR(amount) for old readers
--   * old code writes `licensingFee` (integer)          -> mirror to `licensingFeeAmount`
-- A fractional fee therefore shows as its FLOORED value to any still-running old pod for the minutes of the
-- rollout — transient, and never an overcharge (a sub-1-buzz fee reads as 0 to old pods).
--
-- CONTRACT (a SEPARATE, later migration — only after this release is 100% rolled out and stable): drop the
-- trigger + function and drop the old `licensingFee` INTEGER column. Do NOT rename the new column while pods
-- are still rolling.
--
-- Applied manually per repo convention (we do NOT run `prisma migrate deploy`).

ALTER TABLE "ModelVersion"
  ADD COLUMN "licensingFeeAmount" DECIMAL(10, 2);

UPDATE "ModelVersion"
  SET "licensingFeeAmount" = "licensingFee"
  WHERE "licensingFee" IS NOT NULL;

CREATE OR REPLACE FUNCTION "syncModelVersionLicensingFee"() RETURNS trigger AS $$
BEGIN
  IF NEW."licensingFeeAmount" IS DISTINCT FROM OLD."licensingFeeAmount" THEN
    NEW."licensingFee" := FLOOR(NEW."licensingFeeAmount");
  ELSIF NEW."licensingFee" IS DISTINCT FROM OLD."licensingFee" THEN
    NEW."licensingFeeAmount" := NEW."licensingFee";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "modelVersionLicensingFeeSync"
  BEFORE INSERT OR UPDATE OF "licensingFee", "licensingFeeAmount" ON "ModelVersion"
  FOR EACH ROW EXECUTE FUNCTION "syncModelVersionLicensingFee"();
