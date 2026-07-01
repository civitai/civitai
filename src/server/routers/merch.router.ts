import { TRPCError } from '@trpc/server';
import { claimMerchByKeySchema } from '~/server/schema/merch.schema';
import { claimMerchOrderByKey } from '~/server/services/merch.service';
import { protectedProcedure, router } from '~/server/trpc';

const toTRPCError = (error: unknown) =>
  new TRPCError({
    code: 'BAD_REQUEST',
    message: error instanceof Error ? error.message : 'Something went wrong.',
  });

export const merchRouter = router({
  claimByKey: protectedProcedure.input(claimMerchByKeySchema).mutation(async ({ input, ctx }) => {
    try {
      return await claimMerchOrderByKey({ userId: ctx.user.id, key: input.key });
    } catch (error) {
      throw toTRPCError(error);
    }
  }),
});
