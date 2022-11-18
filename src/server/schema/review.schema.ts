import { z } from 'zod';
import { ReviewFilter, ReviewSort } from '~/server/common/enums';
import { imageSchema } from '~/server/schema/image.schema';

export type ReviewUpsertProps = z.infer<typeof reviewUpsertSchema>;
export const reviewUpsertSchema = z.object({
  id: z.number().optional(),
  modelId: z.number(),
  modelVersionId: z.number(),
  rating: z.number(),
  text: z.string().optional(),
  nsfw: z.boolean().optional(),
  images: z.array(imageSchema).optional(),
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
