import { guardedProcedure, isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import {
  declineServiceDealSchema,
  getServiceDealSchema,
  listMyServiceDealsSchema,
  openServiceDealDisputeSchema,
  requestServiceDealCancellationSchema,
  requestServiceDealRevisionSchema,
  requestServiceDealSchema,
  respondServiceDealCancellationSchema,
  serviceDealActionSchema,
} from '~/server/schema/creator-service-deal.schema';
import {
  acceptServiceDeal,
  acceptServiceDealDelivery,
  assertDealText,
  cancelLateServiceDeal,
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
      requestText: input.requestText,
      disclosureVersion: input.disclosureVersion,
      buyerId: ctx.user.id,
      // From the request's domain, never the input: yellow, or green on the green site.
      buzzType: domainSpendType(ctx.features),
      servableLevels: domainServableLevels(ctx),
      consentLevels: getRequestBrowsingLevel(ctx),
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

  get: protectedProcedure.input(getServiceDealSchema).query(({ input, ctx }) =>
    getServiceDealView({
      dealId: input.id,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
      servicesEnabled: !!ctx.features?.creatorServices,
    })
  ),
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
