import { getByIdSchema } from '~/server/schema/base.schema';
import {
  getPaginatedCosmeticShopItemInput,
  upsertCosmeticShopItemInput,
} from '~/server/schema/cosmetic-shop.schema';
import {
  getPaginatedCosmeticShopItems,
  getShopItemById,
  upsertCosmeticShopItem,
} from '~/server/services/cosmetic-shop.service';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';

export const cosmeticShopRouter = router({
  getShopItemsPaged: moderatorProcedure
    .input(getPaginatedCosmeticShopItemInput)
    .query(({ input }) => {
      return getPaginatedCosmeticShopItems(input);
    }),
  getShopItemById: protectedProcedure.input(getByIdSchema).query(({ input }) => {
    return getShopItemById(input);
  }),
  upsertShopItem: moderatorProcedure
    .input(upsertCosmeticShopItemInput)
    .mutation(({ input, ctx }) => {
      return upsertCosmeticShopItem({
        ...input,
        userId: ctx.user.id,
      });
    }),
});
