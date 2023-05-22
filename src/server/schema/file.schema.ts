import { z } from 'zod';

export const baseFileSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  url: z.string().url().min(1, 'You must select a file'),
  sizeKB: z.number(),
  metadata: z.object({}).optional(),
});
export type BaseFileSchema = z.infer<typeof baseFileSchema>;
