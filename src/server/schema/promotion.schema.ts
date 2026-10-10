import { z } from 'zod';
import { PROMOTION_RUN_DAYS } from '~/shared/utils/promotion';

const id = z.number().int().positive();
const runDays = z.union(
  PROMOTION_RUN_DAYS.map((days) => z.literal(days)) as unknown as [
    z.ZodLiteral<1>,
    z.ZodLiteral<3>,
    z.ZodLiteral<7>
  ]
);

/**
 * 🔴 No `placerId` here, ever: the router takes it from the session. Every check
 * downstream is about that id, so a client-supplied one would spend someone
 * else's Buzz.
 */
export const createGalleryPromotionSchema = z.object({
  modelId: id,
  postId: id,
  days: runDays,
  expectedPrice: z.number().int().min(0).optional(),
  expectedDeclineFeePercent: z.number().int().min(0).max(100),
});
export type CreateGalleryPromotionInput = z.infer<typeof createGalleryPromotionSchema>;

export const createModelPromotionSchema = z.object({
  modelId: id,
  promotedModelId: id,
  days: runDays,
  expectedPrice: z.number().int().min(0).optional(),
  expectedDeclineFeePercent: z.number().int().min(0).max(100),
});
export type CreateModelPromotionInput = z.infer<typeof createModelPromotionSchema>;

export const actOnPromotionSchema = z.object({
  placementId: id,
  action: z.enum(['approve', 'decline']),
});

export const getPromotionHostsForPostSchema = z.object({ postId: id });

export const getModelPromotionOfferSchema = z.object({ modelId: id });

export const getPromotionQueueSchema = z.object({
  surface: z.enum(['galleryPromotion', 'modelPromotion']),
});
