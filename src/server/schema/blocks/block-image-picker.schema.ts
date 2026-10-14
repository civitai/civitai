import * as z from 'zod';

export const getBlockPickablePostedImagesSchema = z.object({
  limit: z.number().int().min(1).max(100).default(40),
  cursor: z.number().int().positive().optional(),
});
export type GetBlockPickablePostedImagesInput = z.infer<typeof getBlockPickablePostedImagesSchema>;
