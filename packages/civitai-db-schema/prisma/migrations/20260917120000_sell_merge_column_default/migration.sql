-- APPLIED to prod 2026-09-17.
--
-- Apply after 20260915120000_add_sell_merge_commercial_use -- the label must exist before a
-- default can name it. Rewrites no row.
--
-- Prisma sends its own @default from schema.full.prisma on create, so this column default only
-- reaches rows written outside Prisma, and the two can disagree with no product symptom. Nothing
-- compares them: db:check-generated diffs the generated client, not the database, and the
-- schema-drift report lists column defaults under "What it does not check". That is how this same
-- column ran @default([Sell]) against a four-value column default until #4036. Change one, change
-- the other.

ALTER TABLE "Model"
  ALTER COLUMN "allowCommercialUse"
  SET DEFAULT ARRAY['Image', 'RentCivit', 'Rent', 'Sell', 'SellMerge']::"CommercialUse"[];
