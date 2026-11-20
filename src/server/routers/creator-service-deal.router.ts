import {
  guardedProcedure,
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  router,
} from '~/server/trpc';
import {
  declineServiceDealSchema,
  getServiceDealSchema,
  listMyServiceDealsSchema,
  openServiceDealDisputeSchema,
  requestServiceDealCancellationSchema,
  requestServiceDealRevisionSchema,
  requestServiceDealSchema,
  respondServiceDealCancellationSchema,
  reviewServiceDealSchema,
  editServiceDealReviewSchema,
  replyServiceDealReviewSchema,
  hideServiceDealReviewSchema,
  attachServiceDealReviewImageSchema,
  serviceDealActionSchema,
} from '~/server/schema/creator-service-deal.schema';
import {
  acceptServiceDeal,
  acceptServiceDealDelivery,
  assertDealText,
  cancelLateServiceDeal,
  cancelServiceDealSellerUnavailable,
  declineServiceDeal,
  getServiceDealView,
  listMyServiceDeals,
  openServiceDealDispute,
  requestServiceDeal,
  requestServiceDealCancellation,
  requestServiceDealRevision,
  respondServiceDealCancellation,
  withdrawServiceDeal,
} from '~/server/services/creator-service-deal.service';
import {
  attachFinalToReview,
  listReviewAttachableFinals,
} from '~/server/services/creator-service-deal-review-images';
import {
  editServiceDealReview,
  getDealReviewView,
  replyToServiceDealReview,
  reviewServiceDeal,
  setServiceDealReviewHidden,
} from '~/server/services/creator-service-deal-review.service';
import { rateLimit } from '~/server/middleware.trpc';
import { domainServableLevels, getRequestBrowsingLevel } from '~/server/utils/browsing-level';
import { domainSpendType } from '~/server/utils/buzz-helpers';

/**
 * Entries into a deal are behind `creatorServices`, and so is a revision request, which needs a
 * seller upload. Exits are NOT: turning the flag off must not trap a buyer's held Buzz or a
 * seller's open deal, so viewing a deal, withdrawing, declining, accepting a delivery, cancelling,
 * the cancellation exchange and disputes stay open to the parties. Every transition checks the
 * acting party in SQL, so none of these trusts an id from the input beyond the deal's own.
 */
const gated = guardedProcedure.use(isFlagProtected('creatorServices'));

const done = async (id: number, run: Promise<unknown>) => {
  await run;
  return { id };
};

export const creatorServiceDealRouter = router({
  request: gated.input(requestServiceDealSchema).mutation(({ input, ctx }) =>
    requestServiceDeal({
      offeringId: input.offeringId,
      expectedPrice: input.expectedPrice,
      expectedRevisionsIncluded: input.expectedRevisionsIncluded,
      expectedDeliveryDays: input.expectedDeliveryDays,
      expectedLicense: input.expectedLicense,
      licenseAgreed: input.licenseAgreed,
      requestText: input.requestText,
      disclosureVersion: input.disclosureVersion,
      buyerId: ctx.user.id,
      // From the request's domain, never the input: yellow, or green on the green site.
      buzzType: domainSpendType(ctx.features),
      servableLevels: domainServableLevels(ctx),
      consentLevels: getRequestBrowsingLevel(ctx),
      reviewEnabled: !!ctx.features.creatorServicesNext,
    })
  ),
  // Behind the live review flag inside the service, so the brake stops new reviews at once.
  review: gated.input(reviewServiceDealSchema).mutation(({ input, ctx }) =>
    reviewServiceDeal({
      dealId: input.id,
      userId: ctx.user.id,
      verdict: input.verdict,
      comment: input.comment,
      reviewFlag: !!ctx.features.creatorServicesNext,
    })
  ),
  // Each edit is a fresh paid scan and a recount.
  editReview: gated
    .use(rateLimit({ limit: 10, period: 3600, errorMessage: 'Too many edits. Try again later.' }))
    .input(editServiceDealReviewSchema)
    .mutation(({ input, ctx }) =>
      editServiceDealReview({
        dealId: input.id,
        userId: ctx.user.id,
        comment: input.comment,
        reviewFlag: !!ctx.features.creatorServicesNext,
      })
    ),
  replyToReview: gated.input(replyServiceDealReviewSchema).mutation(({ input, ctx }) =>
    replyToServiceDealReview({
      dealId: input.id,
      userId: ctx.user.id,
      reply: input.reply,
      reviewFlag: !!ctx.features.creatorServicesNext,
    })
  ),
  reviewAttachableFinals: gated
    .input(serviceDealActionSchema)
    .query(({ input, ctx }) =>
      listReviewAttachableFinals({ dealId: input.id, userId: ctx.user.id })
    ),
  attachReviewImage: gated
    .use(rateLimit({ limit: 20, period: 3600, errorMessage: 'Too many images. Try again later.' }))
    .input(attachServiceDealReviewImageSchema)
    .mutation(({ input, ctx }) =>
      attachFinalToReview({
        dealId: input.id,
        userId: ctx.user.id,
        fileId: input.fileId,
        reviewFlag: !!ctx.features.creatorServicesNext,
      })
    ),
  // Not behind the flag: moderation of what was published must outlast a brake.
  hideReview: moderatorProcedure.input(hideServiceDealReviewSchema).mutation(({ input, ctx }) =>
    setServiceDealReviewHidden({
      reviewId: input.reviewId,
      moderatorId: ctx.user.id,
      hidden: input.hidden,
    })
  ),
  accept: gated
    .input(serviceDealActionSchema)
    .mutation(({ input, ctx }) =>
      done(input.id, acceptServiceDeal({ dealId: input.id, userId: ctx.user.id }))
    ),
  // An exit too: with the flag off a party must still find their open deals to leave them, so
  // only the closed history is gated.
  listMine: protectedProcedure.input(listMyServiceDealsSchema).query(({ input, ctx }) =>
    listMyServiceDeals({
      ...input,
      status: ctx.features?.creatorServices ? input.status : 'open',
      userId: ctx.user.id,
      servicesEnabled: !!ctx.features?.creatorServices,
      servableLevels: domainServableLevels(ctx),
    })
  ),

  get: protectedProcedure.input(getServiceDealSchema).query(async ({ input, ctx }) => {
    const view = await getServiceDealView({
      dealId: input.id,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
      servicesEnabled: !!ctx.features?.creatorServices,
    });
    const review = await getDealReviewView({
      dealId: view.id,
      viewerRole: view.viewerRole,
      servableLevels: domainServableLevels(ctx),
    });
    return { ...view, review };
  }),
  withdraw: protectedProcedure
    .input(serviceDealActionSchema)
    .mutation(({ input, ctx }) =>
      done(input.id, withdrawServiceDeal({ dealId: input.id, userId: ctx.user.id }))
    ),
  // The services scan a reason's text, unless the party is muted: then they drop it unscanned.
  decline: protectedProcedure.input(declineServiceDealSchema).mutation(({ input, ctx }) =>
    done(
      input.id,
      declineServiceDeal({
        dealId: input.id,
        userId: ctx.user.id,
        reason: input.reason,
        reasonCode: input.reasonCode,
      })
    )
  ),
  requestRevision: gated
    .input(requestServiceDealRevisionSchema)
    .mutation(async ({ input, ctx }) => {
      await assertDealText(input.comment);
      return done(
        input.id,
        requestServiceDealRevision({
          dealId: input.id,
          userId: ctx.user.id,
          comment: input.comment,
        })
      );
    }),
  acceptDelivery: protectedProcedure
    .input(serviceDealActionSchema)
    .mutation(({ input, ctx }) =>
      done(input.id, acceptServiceDealDelivery({ dealId: input.id, userId: ctx.user.id }))
    ),
  cancelLate: protectedProcedure
    .input(serviceDealActionSchema)
    .mutation(({ input, ctx }) =>
      done(input.id, cancelLateServiceDeal({ dealId: input.id, userId: ctx.user.id }))
    ),
  cancelAndRefund: protectedProcedure
    .input(serviceDealActionSchema)
    .mutation(({ input, ctx }) =>
      done(input.id, cancelServiceDealSellerUnavailable({ dealId: input.id, userId: ctx.user.id }))
    ),
  requestCancellation: protectedProcedure
    .input(requestServiceDealCancellationSchema)
    .mutation(({ input, ctx }) =>
      done(
        input.id,
        requestServiceDealCancellation({
          dealId: input.id,
          userId: ctx.user.id,
          reason: input.reason,
          reasonCode: input.reasonCode,
        })
      )
    ),
  respondCancellation: protectedProcedure
    .input(respondServiceDealCancellationSchema)
    .mutation(({ input, ctx }) =>
      done(
        input.id,
        respondServiceDealCancellation({
          dealId: input.id,
          userId: ctx.user.id,
          agree: input.agree,
          comment: input.comment,
        })
      )
    ),
  openDispute: protectedProcedure.input(openServiceDealDisputeSchema).mutation(({ input, ctx }) =>
    done(
      input.id,
      openServiceDealDispute({
        dealId: input.id,
        userId: ctx.user.id,
        reason: input.reason,
        reasonCode: input.reasonCode,
      })
    )
  ),
});
