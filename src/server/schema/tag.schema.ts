import { z } from 'zod';
import { getAllQuerySchema } from '~/server/schema/base.schema';

export const tagSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  color: z.string().nullish(),
});

export const getTagsInput = getAllQuerySchema.extend({ page: z.number() }).partial();
export type GetTagsInput = z.infer<typeof getTagsInput>;
