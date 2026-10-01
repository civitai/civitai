import {
  actOnPromotionSchema,
  createGalleryPromotionSchema,
  createModelPromotionSchema,
  getModelPromotionOfferSchema,
  getPromotionHostsForPostSchema,
  getPromotionQueueSchema,
} from '~/server/schema/promotion.schema';
import {
  actOnPromotion,
  createGalleryPromotion,
  createModelPromotion,
  getModelPromotionOffer,
  getMyPromotions,
  getPendingPromotions,
  getPromotionHostsForPost,
} from '~/server/services/promotion.service';
import { guardedProcedure, protectedProcedure, router } from '~/server/trpc';
import { domainSpendType } from '~/server/utils/buzz-helpers';
import { assertPromotionsEnabled } from '~/server/utils/promotion-gate';

export const promotionRouter = router({
  createGalleryPromotion: guardedProcedure
    .input(createGalleryPromotionSchema)
    .mutation(({ input, ctx }) => {
      assertPromotionsEnabled(ctx);
      // `...input` first, so no client value can survive the session's id.
      return createGalleryPromotion({
        ...input,
        placerId: ctx.user.id,
        spendType: domainSpendType(ctx.features),
      });
    }),

  createModelPromotion: guardedProcedure
    .input(createModelPromotionSchema)
    .mutation(({ input, ctx }) => {
      assertPromotionsEnabled(ctx);
      return createModelPromotion({
        ...input,
        placerId: ctx.user.id,
        spendType: domainSpendType(ctx.features),
      });
    }),

  act: protectedProcedure.input(actOnPromotionSchema).mutation(({ input, ctx }) => {
    assertPromotionsEnabled(ctx);
    return actOnPromotion({ ...input, userId: ctx.user.id });
  }),

  getHostsForPost: protectedProcedure
    .input(getPromotionHostsForPostSchema)
    .query(({ input, ctx }) => {
      assertPromotionsEnabled(ctx);
      return getPromotionHostsForPost({ ...input, placerId: ctx.user.id });
    }),

  getModelOffer: protectedProcedure.input(getModelPromotionOfferSchema).query(({ input, ctx }) => {
    assertPromotionsEnabled(ctx);
    return getModelPromotionOffer({ ...input, placerId: ctx.user.id });
  }),

  getPending: protectedProcedure.input(getPromotionQueueSchema).query(({ input, ctx }) => {
    assertPromotionsEnabled(ctx);
    return getPendingPromotions({ ...input, ownerId: ctx.user.id });
  }),

  getMine: protectedProcedure.input(getPromotionQueueSchema).query(({ input, ctx }) => {
    assertPromotionsEnabled(ctx);
    return getMyPromotions({ ...input, placerId: ctx.user.id });
  }),
});
