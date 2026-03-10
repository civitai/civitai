import {
  consumeRedeemableCodeSchema,
  createRedeemableCodeSchema,
  deleteRedeemableCodeSchema,
  getCodeByOrderIdSchema,
  upsertGiftNoticeSchema,
  deleteGiftNoticeSchema,
} from '~/server/schema/redeemableCode.schema';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import {
  consumeRedeemableCode,
  createRedeemableCodes,
  deleteRedeemableCode,
  getCodeByOrderId,
  getAllGiftNotices,
  getMyPurchasedCodes,
  upsertGiftNotice,
  deleteGiftNotice,
} from '~/server/services/redeemableCode.service';
import { cachedCounter } from '~/server/utils/cache-helpers';
import { REDIS_KEYS } from '~/server/redis/client';

const redemptionCounter = cachedCounter(REDIS_KEYS.COUNTERS.REDEMPTION_ATTEMPTS);

export const redeemableCodeRouter = router({
  getMyPurchasedCodes: protectedProcedure.query(({ ctx }) =>
    getMyPurchasedCodes({ userId: ctx.user.id })
  ),
  getCodeByOrderId: protectedProcedure
    .input(getCodeByOrderIdSchema)
    .query(({ input, ctx }) => getCodeByOrderId({ ...input, userId: ctx.user.id })),
  create: moderatorProcedure.input(createRedeemableCodeSchema).mutation(async ({ input, ctx }) => {
    const codes = await createRedeemableCodes(input);
    await ctx.track.redeemableCode('create', { quantity: codes.length });
    return codes;
  }),
  delete: moderatorProcedure.input(deleteRedeemableCodeSchema).mutation(async ({ input, ctx }) => {
    await deleteRedeemableCode(input);
    await ctx.track.redeemableCode('delete', { code: input.code });
  }),
  consume: protectedProcedure
    .input(consumeRedeemableCodeSchema)
    .mutation(async ({ input, ctx }) => {
      const attempts = await redemptionCounter.incrementBy(ctx.user.id);
      if (attempts > 20) throw new Error('Too many failed redemption attempts');

      const consumedCode = await consumeRedeemableCode({ ...input, userId: ctx.user.id });
      await ctx.track.redeemableCode('consume', { code: input.code });
      await redemptionCounter.clear(ctx.user.id);

      return consumedCode;
    }),
  getAllGiftNotices: moderatorProcedure.query(async () => {
    return await getAllGiftNotices();
  }),
  upsertGiftNotice: moderatorProcedure.input(upsertGiftNoticeSchema).mutation(async ({ input }) => {
    await upsertGiftNotice(input);
  }),
  deleteGiftNotice: moderatorProcedure.input(deleteGiftNoticeSchema).mutation(async ({ input }) => {
    await deleteGiftNotice(input);
  }),
});
