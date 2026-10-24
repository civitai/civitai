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
import { guardedProcedure, middleware, protectedProcedure, router } from '~/server/trpc';
import { domainSpendType } from '~/server/utils/buzz-helpers';
import { assertPromotionsEnabled } from '~/server/utils/promotion-gate';

// On the procedure rather than in each resolver, so a procedure added here is
// gated by construction.
const promotionsEnabled = middleware(({ ctx, next }) => {
  assertPromotionsEnabled(ctx);
  return next();
});
const promotionProcedure = protectedProcedure.use(promotionsEnabled);
const guardedPromotionProcedure = guardedProcedure.use(promotionsEnabled);

export const promotionRouter = router({
  createGalleryPromotion: guardedPromotionProcedure
    .input(createGalleryPromotionSchema)
    .mutation(({ input, ctx }) =>
      // `...input` first, so no client value can survive the session's id.
      createGalleryPromotion({
        ...input,
        placerId: ctx.user.id,
        spendType: domainSpendType(ctx.features),
      })
    ),

  createModelPromotion: guardedPromotionProcedure
    .input(createModelPromotionSchema)
    .mutation(({ input, ctx }) =>
      createModelPromotion({
        ...input,
        placerId: ctx.user.id,
        spendType: domainSpendType(ctx.features),
      })
    ),

  act: promotionProcedure
    .input(actOnPromotionSchema)
    .mutation(({ input, ctx }) => actOnPromotion({ ...input, userId: ctx.user.id })),

  getHostsForPost: promotionProcedure
    .input(getPromotionHostsForPostSchema)
    .query(({ input, ctx }) => getPromotionHostsForPost({ ...input, placerId: ctx.user.id })),

  getModelOffer: promotionProcedure
    .input(getModelPromotionOfferSchema)
    .query(({ input, ctx }) => getModelPromotionOffer({ ...input, placerId: ctx.user.id })),

  getPending: promotionProcedure
    .input(getPromotionQueueSchema)
    .query(({ input, ctx }) => getPendingPromotions({ ...input, ownerId: ctx.user.id })),

  getMine: promotionProcedure
    .input(getPromotionQueueSchema)
    .query(({ input, ctx }) => getMyPromotions({ ...input, placerId: ctx.user.id })),
});
