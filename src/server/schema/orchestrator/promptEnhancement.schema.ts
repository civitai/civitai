import * as z from 'zod';

export const promptEnhancementSchema = z.object({
  ecosystem: z.string(),
  prompt: z.string().min(1).max(6000),
  negativePrompt: z.string().nullish(),
  temperature: z.number().min(0).max(1).nullish(),
  instruction: z.string().nullish(),
  preserveTriggerWords: z.string().array().nullish(),
  segmentPrompt: z.boolean().nullish(),
  /**
   * Optional reference images. Forwarded to the orchestrator's prompt-enhancement
   * step where a vision-capable LLM (configured per-ecosystem) uses them as visual
   * context when rewriting the prompt. Non-VLM ecosystems silently ignore them.
   * Accepts URLs, data URIs, raw base64, or AIR strings.
   */
  images: z.string().array().nullish(),
});

export type PromptEnhancementSchema = z.infer<typeof promptEnhancementSchema>;
