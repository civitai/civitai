import * as z from 'zod';

export type VideoEnhancementSchema = z.infer<typeof videoEnhancementSchema>;
export const videoEnhancementSchema = z.object({
  sourceUrl: z.string(),
  width: z.number(),
  height: z.number(),
  multiplier: z.number().optional(),
  params: z.record(z.string(), z.any()),
});
