import { z } from 'zod';
import { VideoGenerationSchema } from '~/server/orchestrator/generation/generation.config';

const baseGenerationSchema = z.object({
  civitaiTip: z.number().default(0),
  creatorTip: z.number().default(0),
  tags: z.string().array().optional(),
});

export type GenerationSchema = z.infer<typeof generationSchema>;
export const generationSchema = z.discriminatedUnion('type', [
  baseGenerationSchema.extend({
    type: z.literal('video'),
    data: z.record(z.any()).transform((data) => data as VideoGenerationSchema),
  }),
  baseGenerationSchema.extend({
    type: z.literal('image'),
    data: z.record(z.any()),
  }),
]);

export const requestPrioritySchema = z
  .object({
    type: z.enum(['default', 'kling', 'minimax', 'vidu']).default('default'),
  })
  .default({});
