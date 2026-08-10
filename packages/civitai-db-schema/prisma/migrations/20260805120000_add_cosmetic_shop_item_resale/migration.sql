-- Cross-creator resale listings: who resells which shop item, and the seller
-- share they listed under. Replaces `User.settings.creatorShop.resoldItemIds`,
-- which could only be read one shop at a time — "who resells my item?" meant
-- scanning every user's settings JSON.
--
-- `sellerShare` is captured at listing time and never rewritten: the original
-- creator can lower the item's share (or withdraw resale) afterwards, and
-- existing resellers are grandfathered on what they agreed to.
-- Applied manually (we do NOT use prisma migrate deploy).

CREATE TABLE "UserCosmeticShopItemResale" (
    "userId" INTEGER NOT NULL,
    "shopItemId" INTEGER NOT NULL,
    "sellerShare" INTEGER NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCosmeticShopItemResale_pkey" PRIMARY KEY ("userId", "shopItemId")
);

-- The reverse lookup this table exists for: every reseller of one item.
CREATE INDEX "UserCosmeticShopItemResale_shopItemId_idx" ON "UserCosmeticShopItemResale"("shopItemId");

ALTER TABLE "UserCosmeticShopItemResale" ADD CONSTRAINT "UserCosmeticShopItemResale_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserCosmeticShopItemResale" ADD CONSTRAINT "UserCosmeticShopItemResale_shopItemId_fkey" FOREIGN KEY ("shopItemId") REFERENCES "CosmeticShopItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DDL only. Existing resellers still live in `User.settings.creatorShop
-- .resoldItemIds` and are migrated by
--   pnpm tsscript scripts/oneoffs/backfill-cosmetic-resale-listings.ts
-- which is resumable, has --dry-run / --verify, and can --prune the legacy key
-- afterwards. Run it right after this migration: until it does, existing
-- resellers have no listing rows and their resold sections read empty.
