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
import { domainSpendType } from '~/server/utils/buzz-helpers';

/**
 * Entries into a deal are behind `creatorServices`. Exits are NOT: turning the flag off must not
 * trap a buyer's held Buzz or a seller's open deal, so viewing a deal, withdrawing, declining,
 * cancelling and the cancellation exchange stay open to the parties. Every transition checks the
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
      buyerId: ctx.user.id,
      // From the request's domain, never the input: yellow, or green on the green site.
      buzzType: domainSpendType(ctx.features),
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
    })
  ),

  get: protectedProcedure.input(getServiceDealSchema).query(({ input, ctx }) =>
    getServiceDealView({
      dealId: input.id,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    })
  ),
  withdraw: protectedProcedure
    .input(serviceDealActionSchema)
    .mutation(({ input, ctx }) =>
      done(input.id, withdrawServiceDeal({ dealId: input.id, userId: ctx.user.id }))
    ),
  decline: protectedProcedure.input(declineServiceDealSchema).mutation(async ({ input, ctx }) => {
    await assertDealText(input.reason);
    return done(
      input.id,
      declineServiceDeal({ dealId: input.id, userId: ctx.user.id, reason: input.reason })
    );
  }),
  requestRevision: protectedProcedure
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
    .mutation(async ({ input, ctx }) => {
      await assertDealText(input.reason);
      return done(
        input.id,
        requestServiceDealCancellation({
          dealId: input.id,
          userId: ctx.user.id,
          reason: input.reason,
        })
      );
    }),
  respondCancellation: protectedProcedure
    .input(respondServiceDealCancellationSchema)
    .mutation(async ({ input, ctx }) => {
      await assertDealText(input.comment);
      return done(
        input.id,
        respondServiceDealCancellation({
          dealId: input.id,
          userId: ctx.user.id,
          agree: input.agree,
          comment: input.comment,
        })
      );
    }),
  openDispute: protectedProcedure
    .input(openServiceDealDisputeSchema)
    .mutation(async ({ input, ctx }) => {
      await assertDealText(input.reason);
      return done(
        input.id,
        openServiceDealDispute({ dealId: input.id, userId: ctx.user.id, reason: input.reason })
      );
    }),
});
