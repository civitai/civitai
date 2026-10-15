import { getByIdSchema } from '~/server/schema/base.schema';
import {
  getShopServiceOfferingsSchema,
  setServiceOfferingStatusSchema,
  takedownServiceOfferingSchema,
  upsertServiceOfferingSchema,
} from '~/server/schema/creator-service.schema';
import {
  getMyServiceOfferings,
  getServiceSellEligibility,
  getShopServiceOfferings,
  removeServiceOffering,
  setServiceOfferingStatus,
  takedownServiceOffering,
  upsertServiceOffering,
} from '~/server/services/creator-service.service';
import {
  guardedProcedure,
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { domainServableLevels, resolveRequestBrowsingLevels } from '~/server/utils/browsing-level';

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
  getMine: servicesProcedure.query(({ ctx }) =>
    getMyServiceOfferings({ sellerId: ctx.user.id, servable: domainServableLevels(ctx) })
  ),
  upsert: servicesGuardedProcedure
    .input(upsertServiceOfferingSchema)
    .mutation(({ input, ctx }) => upsertServiceOffering({ sellerId: ctx.user.id, input })),
  setStatus: servicesProcedure
    .input(setServiceOfferingStatusSchema)
    .mutation(({ input, ctx }) => setServiceOfferingStatus({ sellerId: ctx.user.id, input })),
  remove: servicesProcedure
    .input(getByIdSchema)
    .mutation(({ input, ctx }) => removeServiceOffering({ sellerId: ctx.user.id, id: input.id })),
  // No rollout flags: they are evaluated on the caller, and a moderator outside the rollout must
  // still be able to take down a listing that is live for those inside it.
  takedown: moderatorProcedure
    .input(takedownServiceOfferingSchema)
    .mutation(({ input, ctx }) => takedownServiceOffering({ moderatorId: ctx.user.id, input })),

  getForShop: publicProcedure
    .use(isFlagProtected('creatorShop'))
    .use(isFlagProtected('creatorServices'))
    .input(getShopServiceOfferingsSchema)
    .query(({ input, ctx }) => {
      // Fills a signed-in viewer's own level when none was sent, then holds it to the domain cap.
      resolveRequestBrowsingLevels(input, ctx);
      return getShopServiceOfferings({
        ...input,
        servable: domainServableLevels(ctx),
        viewerId: ctx.user?.id,
        isModerator: ctx.user?.isModerator,
      });
    }),
});
