-- Apply by hand, off-peak. CONCURRENTLY cannot run inside a transaction, so run this statement on
-- its own. Safe before or after the deploy; reads are only slower without it.
--
-- A cancelled build leaves an invalid index under this name, which IF NOT EXISTS then skips. After
-- applying, check pg_index.indisvalid; if false, DROP INDEX CONCURRENTLY and run this again.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "CosmeticShopItem_cosmeticId_idx"
  ON "CosmeticShopItem" ("cosmeticId");
