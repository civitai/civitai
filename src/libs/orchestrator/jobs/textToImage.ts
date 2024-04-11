import { z } from 'zod';
import { eventSchema } from './schemas';

const paramsSchema = z.object({
  whatIf: z.boolean().optional(),
  charge: z.boolean().optional(),
  wait: z.boolean().optional(),
  detailed: z.boolean().optional(),
});

const bodySchema = z.object({
  model: z.string(),
  params: z.object({
    prompt: z.string(),
    negativePrompt: z.string().optional(),
    width: z.number(),
    height: z.number(),
    scheduler: z.string(),
    steps: z.number(),
    cfgScale: z.number(),
    seed: z.number().optional(),
    clipSkip: z.number(),
    baseModel: z.string().optional(),
  }),
  additionalNetworks: z.record(
    z.object({
      type: z.string(),
      strength: z.number().optional(),
      triggerWord: z.string().optional(),
    })
  ),
  quantity: z.number(),
  properties: z.object({ userId: z.number().optional() }).optional(),
  priority: z.object({ min: z.number(), max: z.number() }).optional(),
  baseModel: z.string().optional(),
  callbackUrl: z.string().optional(),
});

export type TextToImageEvent = z.infer<typeof textToImageEventSchema>;
export const textToImageEventSchema = eventSchema.extend({
  jobProperties: z.object({ userId: z.number().optional() }),
});
