import * as z from 'zod';

export const promptEnhancementSchema = z.object({
  ecosystem: z.string(),
  prompt: z.string().min(1).max(6000),
  negativePrompt: z.string().nullish(),
  temperature: z.number().min(0).max(1).nullish(),
  instruction: z.string().nullish(),
  preserveTriggerWords: z.string().array().nullish(),
  segmentPrompt: z.boolean().nullish(),
});

export type PromptEnhancementSchema = z.infer<typeof promptEnhancementSchema>;
