import { getByIdSchema } from '~/server/schema/base.schema';
import {
  getShopServiceOfferingsSchema,
  setServiceOfferingStatusSchema,
  upsertServiceOfferingSchema,
} from '~/server/schema/creator-service.schema';
import {
  getMyServiceOfferings,
  getServiceSellEligibility,
  getShopServiceOfferings,
  removeServiceOffering,
  setServiceOfferingStatus,
  upsertServiceOffering,
} from '~/server/services/creator-service.service';
import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';

// Services live inside the Creator Shop, so every procedure needs both flags.
const sellerProcedure = protectedProcedure
  .use(isFlagProtected('creatorShop'))
  .use(isFlagProtected('creatorServices'));

export const creatorServiceRouter = router({
  getSellEligibility: sellerProcedure.query(({ ctx }) => getServiceSellEligibility(ctx.user.id)),
  getMine: sellerProcedure.query(({ ctx }) => getMyServiceOfferings(ctx.user.id)),
  upsert: sellerProcedure
    .input(upsertServiceOfferingSchema)
    .mutation(({ input, ctx }) => upsertServiceOffering({ sellerId: ctx.user.id, input })),
  setStatus: sellerProcedure
    .input(setServiceOfferingStatusSchema)
    .mutation(({ input, ctx }) => setServiceOfferingStatus({ sellerId: ctx.user.id, input })),
  remove: sellerProcedure
    .input(getByIdSchema)
    .mutation(({ input, ctx }) => removeServiceOffering({ sellerId: ctx.user.id, id: input.id })),

  getForShop: publicProcedure
    .use(isFlagProtected('creatorShop'))
    .use(isFlagProtected('creatorServices'))
    .input(getShopServiceOfferingsSchema)
    .query(({ input }) => getShopServiceOfferings(input)),
});
