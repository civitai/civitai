import { TRPCError } from '@trpc/server';
import { getByIdSchema } from '~/server/schema/base.schema';
import type { GetServiceOfferingReviewsInput } from '~/server/schema/creator-service.schema';
import {
  getServiceOfferingByIdSchema,
  getServiceOfferingFeedSchema,
  getServiceOfferingReviewsSchema,
  getShopServiceOfferingsSchema,
  setServiceOfferingStatusSchema,
  takedownServiceOfferingSchema,
  upsertServiceOfferingSchema,
} from '~/server/schema/creator-service.schema';
import {
  getServiceOfferingReviewWork,
  getServiceOfferingReviews,
  serviceReviewViewer,
} from '~/server/services/creator-service-review-display.service';
import {
  assertServiceOfferingViewable,
  getMyServiceOfferings,
  getServiceSellEligibility,
  getServiceOfferingById,
  getServiceOfferingFeed,
  getShopServiceOfferings,
  removeServiceOffering,
  setServiceOfferingStatus,
  takedownServiceOffering,
  upsertServiceOffering,
} from '~/server/services/creator-service.service';
import {
  guardFlagEnabled,
  guardedProcedure,
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { domainServableLevels, resolveRequestBrowsingLevels } from '~/server/utils/browsing-level';
import { ServiceOfferingStatus } from '~/shared/utils/prisma/enums';

// Services live inside the Creator Shop, so every entry needs both flags. Exits do not: a seller
// who loses the flags must still find their offerings and pause or remove them, or an Active one
// stays requestable while they cannot accept (as the deal router keeps decline and withdraw open).
// Each exit is scoped to the caller's own offerings in SQL.
const servicesProcedure = protectedProcedure
  .use(isFlagProtected('creatorShop'))
  .use(isFlagProtected('creatorServices'));
// Offering text is public and unreviewed, so writing it takes the email/mute/onboarding gate.
// Pause and remove are not on it: a muted seller must still be able to withdraw.
const servicesGuardedProcedure = guardedProcedure
  .use(isFlagProtected('creatorShop'))
  .use(isFlagProtected('creatorServices'));

// The reviews sit on the offering's page, so they take its flags and its viewer rule.
const reviewsProcedure = publicProcedure
  .use(isFlagProtected('creatorShop'))
  .use(isFlagProtected('creatorServices'))
  .use(isFlagProtected('creatorServicesNext'))
  .input(getServiceOfferingReviewsSchema);

async function reviewViewer(
  input: GetServiceOfferingReviewsInput,
  ctx: Parameters<typeof domainServableLevels>[0] & { user?: { id: number; isModerator?: boolean } }
) {
  resolveRequestBrowsingLevels(input, ctx);
  const servable = domainServableLevels(ctx);
  const viewerId = ctx.user?.id;
  await assertServiceOfferingViewable({
    id: input.id,
    browsingLevel: input.browsingLevel,
    servable,
    viewerId,
    isModerator: ctx.user?.isModerator,
  });
  return {
    offeringId: input.id,
    ...(await serviceReviewViewer({ browsingLevel: input.browsingLevel, servable, viewerId })),
  };
}

export const creatorServiceRouter = router({
  getSellEligibility: servicesProcedure.query(({ ctx }) => getServiceSellEligibility(ctx.user.id)),
  getMine: protectedProcedure.query(({ ctx }) =>
    getMyServiceOfferings({ sellerId: ctx.user.id, servable: domainServableLevels(ctx) })
  ),
  upsert: servicesGuardedProcedure
    .input(upsertServiceOfferingSchema)
    .mutation(({ input, ctx }) => upsertServiceOffering({ sellerId: ctx.user.id, input })),
  setStatus: protectedProcedure.input(setServiceOfferingStatusSchema).mutation(({ input, ctx }) => {
    // Publishing is an entry; pausing is the exit.
    if (
      input.status === ServiceOfferingStatus.Active &&
      !(guardFlagEnabled(ctx, 'creatorShop') && guardFlagEnabled(ctx, 'creatorServices'))
    )
      throw new TRPCError({ code: 'FORBIDDEN' });
    return setServiceOfferingStatus({ sellerId: ctx.user.id, input });
  }),
  remove: protectedProcedure
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
  getById: publicProcedure
    .use(isFlagProtected('creatorShop'))
    .use(isFlagProtected('creatorServices'))
    .use(isFlagProtected('creatorServicesNext'))
    .input(getServiceOfferingByIdSchema)
    .query(({ input, ctx }) => {
      resolveRequestBrowsingLevels(input, ctx);
      return getServiceOfferingById({
        ...input,
        servable: domainServableLevels(ctx),
        viewerId: ctx.user?.id,
        isModerator: ctx.user?.isModerator,
      });
    }),
  getFeed: publicProcedure
    .use(isFlagProtected('creatorShop'))
    .use(isFlagProtected('creatorServices'))
    .input(getServiceOfferingFeedSchema)
    .query(({ input, ctx }) => {
      resolveRequestBrowsingLevels(input, ctx);
      return getServiceOfferingFeed({
        ...input,
        sort:
          input.sort === 'happy' && !guardFlagEnabled(ctx, 'creatorServicesNext')
            ? 'newest'
            : input.sort,
        servable: domainServableLevels(ctx),
        viewerId: ctx.user?.id,
      });
    }),
  getReviews: reviewsProcedure.query(async ({ input, ctx }) =>
    getServiceOfferingReviews({ ...(await reviewViewer(input, ctx)), cursor: input.cursor })
  ),
  getReviewWork: reviewsProcedure.query(async ({ input, ctx }) =>
    getServiceOfferingReviewWork({ ...(await reviewViewer(input, ctx)), cursor: input.cursor })
  ),
});
