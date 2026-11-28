-- The buyer disclosure a deal's buyer agreed to before the hold: its version and the exact lines shown.
-- Additive and nullable: deals made before this have neither.
ALTER TABLE "ServiceDeal"
  ADD COLUMN IF NOT EXISTS "buyerDisclosureVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "buyerDisclosureLines" TEXT[];
