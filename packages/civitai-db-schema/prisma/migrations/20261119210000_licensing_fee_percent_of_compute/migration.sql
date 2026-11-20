-- Percent-of-compute licence fees, and a markup logged apart from the fee.
--
-- Safe to apply before the deploy: the column is nullable and nothing writes PercentOfCompute until a
-- version is set to it by hand. Apply this BEFORE the deploy, because the regenerated client selects
-- "licensingFeeMarkup". Set no version to PercentOfCompute until the orchestrator reads the type.
ALTER TYPE "LicensingFeeType" ADD VALUE IF NOT EXISTS 'PercentOfCompute';

ALTER TABLE "ModelVersion" ADD COLUMN IF NOT EXISTS "licensingFeeMarkup" DECIMAL(5,2);
