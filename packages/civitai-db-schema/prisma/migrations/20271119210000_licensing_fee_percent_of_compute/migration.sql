-- Percent-of-compute licence fees, and a markup logged apart from the fee.
--
-- Apply BEFORE the deploy: the regenerated client selects "licensingFeeMarkup". Nothing writes
-- PercentOfCompute until a version is set to it by hand, and no version may be set to it until the
-- orchestrator reads the type.
ALTER TYPE "LicensingFeeType" ADD VALUE IF NOT EXISTS 'PercentOfCompute';

ALTER TABLE "ModelVersion" ADD COLUMN IF NOT EXISTS "licensingFeeMarkup" DECIMAL(5,2);
