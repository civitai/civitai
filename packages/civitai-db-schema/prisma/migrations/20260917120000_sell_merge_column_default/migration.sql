-- APPLIED to prod 2026-09-17, prefixed at apply time with `SET lock_timeout = '3s'`.
--
-- Apply DDL to "Model" behind a lock_timeout. The change here is catalog-only and instant, but
-- ALTER TABLE takes ACCESS EXCLUSIVE, and the ACQUISITION can queue behind a long transaction and
-- park every reader of the hottest table in the product behind it. A timeout makes that a clean
-- failure you retry rather than an incident. It is an apply-time property, not part of the
-- migration, which is why it is recorded here instead of in the statement.
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
