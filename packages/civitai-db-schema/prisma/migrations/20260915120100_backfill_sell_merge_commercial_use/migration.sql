-- STEP 3 of 3, AFTER the deploy (step 2). Two reasons it waits:
--   * a value added by ALTER TYPE is not usable in the transaction that added it, and
--   * this writes 'SellMerge' onto existing rows, so every reader must already know it.
--
-- Splitting 'Sell' ("sell this model or merges") into 'Sell' ("sell this model") and
-- 'SellMerge' ("sell merges using this model"). Every model that granted the combined
-- permission grants both halves, so no creator's effective terms change here; only a
-- future edit by the creator can make the two diverge.

ALTER TABLE "Model"
  ALTER COLUMN "allowCommercialUse"
  SET DEFAULT ARRAY['Image', 'RentCivit', 'Rent', 'Sell', 'SellMerge']::"CommercialUse"[];

UPDATE "Model"
SET "allowCommercialUse" = array_append("allowCommercialUse", 'SellMerge'::"CommercialUse")
WHERE 'Sell' = ANY ("allowCommercialUse")
  AND NOT ('SellMerge' = ANY ("allowCommercialUse"));
