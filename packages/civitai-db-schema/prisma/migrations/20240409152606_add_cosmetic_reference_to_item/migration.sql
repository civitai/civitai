-- AddForeignKey
ALTER TABLE "CosmeticShopItem" ADD CONSTRAINT "CosmeticShopItem_cosmeticId_fkey" FOREIGN KEY ("cosmeticId") REFERENCES "Cosmetic"("id") ON DELETE CASCADE ON UPDATE CASCADE;