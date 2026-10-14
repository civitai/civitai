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
import {
  guardedProcedure,
  isFlagProtected,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';

// Services live inside the Creator Shop, so every procedure needs both flags.
const servicesProcedure = protectedProcedure
  .use(isFlagProtected('creatorShop'))
  .use(isFlagProtected('creatorServices'));
// Offering text is public and unreviewed, so writing it takes the email/mute/onboarding gate.
// Pause and remove stay on `servicesProcedure`: a muted seller must still be able to withdraw.
const servicesGuardedProcedure = guardedProcedure
  .use(isFlagProtected('creatorShop'))
  .use(isFlagProtected('creatorServices'));

export const creatorServiceRouter = router({
  getSellEligibility: servicesProcedure.query(({ ctx }) => getServiceSellEligibility(ctx.user.id)),
  getMine: servicesProcedure.query(({ ctx }) => getMyServiceOfferings(ctx.user.id)),
  upsert: servicesGuardedProcedure
    .input(upsertServiceOfferingSchema)
    .mutation(({ input, ctx }) => upsertServiceOffering({ sellerId: ctx.user.id, input })),
  setStatus: servicesProcedure
    .input(setServiceOfferingStatusSchema)
    .mutation(({ input, ctx }) => setServiceOfferingStatus({ sellerId: ctx.user.id, input })),
  remove: servicesProcedure
    .input(getByIdSchema)
    .mutation(({ input, ctx }) => removeServiceOffering({ sellerId: ctx.user.id, id: input.id })),

  getForShop: publicProcedure
    .use(isFlagProtected('creatorShop'))
    .use(isFlagProtected('creatorServices'))
    .input(getShopServiceOfferingsSchema)
    .query(({ input }) => getShopServiceOfferings(input)),
});
