import { TRPCError } from '@trpc/server';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import {
  createMembershipGiftCheckoutSchema,
  getRecipientGiftabilitySchema,
} from '~/server/schema/membership-gift.schema';
import {
  createMembershipGiftCheckout,
  getMyMembershipGifts,
  getRecipientGiftability,
  keepGiftMembership,
} from '~/server/services/membership-gift.service';
import { protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const giftProcedure = protectedProcedure
  .meta({ requiredScope: TokenScope.Full })
  .use(({ ctx, next }) => {
    if (!ctx.features.giftMemberships) throw new TRPCError({ code: 'FORBIDDEN' });
    return next();
  });

export const membershipGiftRouter = router({
  getRecipientGiftability: giftProcedure
    .input(getRecipientGiftabilitySchema)
    .query(({ input }) => getRecipientGiftability(input)),
  createCheckout: giftProcedure
    .input(createMembershipGiftCheckoutSchema)
    .mutation(({ input, ctx }) => {
      if (!ctx.user.email) throw throwAuthorizationError('email required');
      return createMembershipGiftCheckout({
        ...input,
        gifterId: ctx.user.id,
        gifterEmail: ctx.user.email,
      });
    }),
  getMyGifts: giftProcedure.query(({ ctx }) => getMyMembershipGifts({ userId: ctx.user.id })),
  keepMembership: giftProcedure.mutation(({ ctx }) => keepGiftMembership({ userId: ctx.user.id })),
});
