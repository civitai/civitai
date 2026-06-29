import { TRPCError } from '@trpc/server';
import {
  confirmMerchClaimSchema,
  merchOrderIdSchema,
  requestMerchClaimConfirmationSchema,
} from '~/server/schema/merch.schema';
import {
  claimMerchOrder,
  confirmMerchClaim,
  getClaimableMerchOrder,
  requestMerchClaimConfirmation,
} from '~/server/services/merch.service';
import { protectedProcedure, router } from '~/server/trpc';

const toTRPCError = (error: unknown) =>
  new TRPCError({
    code: 'BAD_REQUEST',
    message: error instanceof Error ? error.message : 'Something went wrong.',
  });

export const merchRouter = router({
  getClaimableOrder: protectedProcedure
    .input(merchOrderIdSchema)
    .query(({ input, ctx }) =>
      getClaimableMerchOrder({ shopifyOrderId: input.shopifyOrderId, userId: ctx.user.id })
    ),
  claim: protectedProcedure.input(merchOrderIdSchema).mutation(async ({ input, ctx }) => {
    try {
      return await claimMerchOrder({ userId: ctx.user.id, shopifyOrderId: input.shopifyOrderId });
    } catch (error) {
      throw toTRPCError(error);
    }
  }),
  requestEmailConfirmation: protectedProcedure
    .input(requestMerchClaimConfirmationSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await requestMerchClaimConfirmation({
          userId: ctx.user.id,
          username: ctx.user.username ?? 'there',
          shopifyOrderId: input.shopifyOrderId,
          providedEmail: input.email,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),
  confirmClaim: protectedProcedure
    .input(confirmMerchClaimSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await confirmMerchClaim({ userId: ctx.user.id, token: input.token });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),
});
