-- Records who was paid for each cosmetic sale (creator / reseller / platform split,
-- per Buzz color) so a takedown can reverse exactly what was paid out. Nullable:
-- pre-existing rows keep NULL and fall back to deriving the split from the item.
ALTER TABLE "UserCosmeticShopPurchases" ADD COLUMN IF NOT EXISTS "meta" JSONB;
