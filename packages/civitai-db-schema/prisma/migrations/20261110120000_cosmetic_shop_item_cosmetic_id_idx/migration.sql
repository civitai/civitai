-- Creator mystery pack checks look up each content's listing by "cosmeticId"; without this index
-- every lookup scans the whole table.
--
-- Apply by hand, off-peak: the code works without it, only slower. CONCURRENTLY cannot run inside a
-- transaction, so run this statement on its own.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "CosmeticShopItem_cosmeticId_idx"
  ON "CosmeticShopItem" ("cosmeticId");
