import * as z from 'zod';

export type VideoUpscalerSchema = z.infer<typeof videoUpscalerSchema>;
export const videoUpscalerSchema = z.object({
  videoUrl: z.string(),
  scaleFactor: z.number(),
  metadata: z.record(z.string(), z.any()).optional(),
});
