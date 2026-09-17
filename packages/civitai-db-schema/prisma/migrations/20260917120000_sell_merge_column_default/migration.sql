-- NOT YET APPLIED.
--
-- Safe to apply any time after 20260915120000_add_sell_merge_commercial_use (applied to prod
-- 2026-09-15) -- the label must exist before it can be named in a default. It changes no existing
-- row.
--
-- Prisma sends its own @default from schema.full.prisma on create, so this column default is never
-- what a model is born with and a disagreement between the two is invisible in the product. That is
-- exactly how the same column shipped @default([Sell]) against a four-value column default for two
-- and a half years (fixed in #4036): nothing compares them -- not db:check-generated, and the
-- schema-drift report excludes column defaults by name.
--
-- Order matches the @default array so the two can be diffed by eye.

ALTER TABLE "Model"
  ALTER COLUMN "allowCommercialUse"
  SET DEFAULT ARRAY['Image', 'RentCivit', 'Rent', 'Sell', 'SellMerge']::"CommercialUse"[];
