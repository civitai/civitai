import * as z from 'zod';
import { sourceImageSchema } from '~/server/orchestrator/infrastructure/base.schema';

export type ImageUpscalerSchema = z.infer<typeof imageUpscalerSchema>;
export const imageUpscalerSchema = z.object({
  sourceImage: sourceImageSchema,
  metadata: z.record(z.string(), z.any()).optional(),
});
