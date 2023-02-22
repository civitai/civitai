import { tagSchema } from './tag.schema';
import { z } from 'zod';
import { imageSchema } from '~/server/schema/image.schema';

export type PostUpsertInput = z.infer<typeof postUpsertSchema>;
export const postUpsertSchema = z.object({
  id: z.number().optional(),
  nsfw: z.boolean().default(false),
  title: z.string().optional(),
  detail: z.string().optional(),
  images: z.array(imageSchema),
  tags: z.array(tagSchema),
  // resources
});
