import { z } from 'zod';
import { imageSchema } from '~/server/schema/image.schema';

export const reviewUpsertSchema = z.object({
  id: z.number().optional(),
  modelId: z.number(),
  modelVersionId: z.number(),
  rating: z.number(),
  text: z.string().optional(),
  nsfw: z.boolean().optional(),
  images: z.array(imageSchema).optional(),
});

export type ReviewUpsertProps = z.infer<typeof reviewUpsertSchema>;
