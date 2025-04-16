import z from 'zod';

export type VideoEnhancementSchema = z.infer<typeof videoEnhancementSchema>;
export const videoEnhancementSchema = z.object({
  sourceUrl: z.string(),
  multiplier: z.number(),
  params: z.record(z.any()),
});
