import { ReviewReactions } from '@prisma/client';
import { z } from 'zod';

import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import { imageSchema } from '~/server/schema/image.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';

export type ReviewUpsertInput = z.infer<typeof reviewUpsertSchema>;
export const reviewUpsertSchema = z.object({
  id: z.number().optional(),
  modelId: z.number(),
  modelVersionId: z.number(),
  rating: z.number(),
  text: getSanitizedStringSchema({
    allowedTags: ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br'],
  }).nullish(),
  nsfw: z.boolean().optional(),
  images: z.array(imageSchema).max(10, 'You can only upload up to 10 images').optional(),
});

export type GetAllReviewsInput = z.infer<typeof getAllReviewSchema>;
export const getAllReviewSchema = z
  .object({
    limit: z.number().min(1).max(100),
    page: z.number(),
    cursor: z.number(),
    modelId: z.number(),
    modelVersionId: z.number(),
    userId: z.number(),
    filterBy: z.array(z.nativeEnum(ReviewFilter)),
    sort: z.nativeEnum(ReviewSort).default(ReviewSort.Newest),
  })
  .partial();

export type GetReviewReactionsInput = z.infer<typeof getReviewReactionsSchema>;
export const getReviewReactionsSchema = z.object({ reviewId: z.number() });

export type ToggleReactionInput = z.infer<typeof toggleReactionInput>;
export const toggleReactionInput = z.object({
  id: z.number(),
  reaction: z.nativeEnum(ReviewReactions),
});
