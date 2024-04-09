import { getPaginatedCosmeticShopItemInput } from '~/server/schema/cosmetic-shop.schema';
import { getPaginatedCosmeticShopItems } from '~/server/services/cosmetic-shop.service';
import { moderatorProcedure, router } from '~/server/trpc';

export const cosmeticShopRouter = router({
  getShopItemsPaged: moderatorProcedure
    .input(getPaginatedCosmeticShopItemInput)
    .query(({ input }) => {
      return getPaginatedCosmeticShopItems(input);
    }),
});
