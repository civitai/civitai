-- Cosmetic shop wishlist: per-user saved shop listings, surfaced back on /shop.
-- Keys off CosmeticShopItem (the listing) rather than Cosmetic, matching how
-- purchases and the shop grid are keyed.
-- Applied manually (we do NOT use prisma migrate deploy).

CREATE TABLE "UserCosmeticShopItemWishlist" (
    "userId" INTEGER NOT NULL,
    "shopItemId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCosmeticShopItemWishlist_pkey" PRIMARY KEY ("userId", "shopItemId")
);

CREATE INDEX "UserCosmeticShopItemWishlist_shopItemId_idx" ON "UserCosmeticShopItemWishlist"("shopItemId");

ALTER TABLE "UserCosmeticShopItemWishlist" ADD CONSTRAINT "UserCosmeticShopItemWishlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserCosmeticShopItemWishlist" ADD CONSTRAINT "UserCosmeticShopItemWishlist_shopItemId_fkey" FOREIGN KEY ("shopItemId") REFERENCES "CosmeticShopItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
