-- Packs: one CosmeticShopItem listing plus a join to its member cosmetics.

ALTER TABLE "CosmeticShopItem" ALTER COLUMN "cosmeticId" DROP NOT NULL;

ALTER TABLE "UserCosmeticShopPurchases" ALTER COLUMN "cosmeticId" DROP NOT NULL;

CREATE TABLE "CosmeticShopItemCosmetic" (
    "shopItemId" INTEGER NOT NULL,
    "cosmeticId" INTEGER NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,
    "floorAmount" INTEGER NOT NULL,

    CONSTRAINT "CosmeticShopItemCosmetic_pkey" PRIMARY KEY ("shopItemId","cosmeticId")
);

CREATE INDEX "CosmeticShopItemCosmetic_cosmeticId_idx" ON "CosmeticShopItemCosmetic"("cosmeticId");

ALTER TABLE "CosmeticShopItemCosmetic"
    ADD CONSTRAINT "CosmeticShopItemCosmetic_shopItemId_fkey"
    FOREIGN KEY ("shopItemId") REFERENCES "CosmeticShopItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CosmeticShopItemCosmetic"
    ADD CONSTRAINT "CosmeticShopItemCosmetic_cosmeticId_fkey"
    FOREIGN KEY ("cosmeticId") REFERENCES "Cosmetic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UserCosmeticShopPurchaseCosmetic" (
    "buzzTransactionId" TEXT NOT NULL,
    "cosmeticId" INTEGER NOT NULL,
    "unitAmount" INTEGER NOT NULL,
    "meta" JSONB,

    CONSTRAINT "UserCosmeticShopPurchaseCosmetic_pkey" PRIMARY KEY ("buzzTransactionId","cosmeticId")
);

CREATE INDEX "UserCosmeticShopPurchaseCosmetic_cosmeticId_idx" ON "UserCosmeticShopPurchaseCosmetic"("cosmeticId");

ALTER TABLE "UserCosmeticShopPurchaseCosmetic"
    ADD CONSTRAINT "UserCosmeticShopPurchaseCosmetic_buzzTransactionId_fkey"
    FOREIGN KEY ("buzzTransactionId") REFERENCES "UserCosmeticShopPurchases"("buzzTransactionId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCosmeticShopPurchaseCosmetic"
    ADD CONSTRAINT "UserCosmeticShopPurchaseCosmetic_cosmeticId_fkey"
    FOREIGN KEY ("cosmeticId") REFERENCES "Cosmetic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
