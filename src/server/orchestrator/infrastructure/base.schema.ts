import { Priority } from '@civitai/client';
import z from 'zod';

export const promptSchema = z
  .string()
  .max(1500, 'Prompt cannot be longer than 1500 characters')
  .default('');

export const negativePromptSchema = z
  .string()
  .max(1000, 'Prompt cannot be longer than 1000 characters')
  .default('');

export type SourceImageProps = z.input<typeof sourceImageSchema>;
export const sourceImageSchema = z.object({
  url: z.string().startsWith('https://orchestration').includes('.civitai.com'),
  width: z.number(),
  height: z.number(),
  upscaleWidth: z.number().optional(),
  upscaleHeight: z.number().optional(),
});

export const seedSchema = z.number().optional();
const prioritySchema = z.nativeEnum(Priority).default('low').catch('low');

const baseGenerationSchema = z.object({
  priority: prioritySchema,
  /** temporary property to satisfy type constraints */
  workflow: z.string().optional(),
});

export const baseVideoGenerationSchema = baseGenerationSchema.extend({
  process: z.enum(['txt2vid', 'img2vid']).default('txt2vid'),
});

export type ResourceInput = z.input<typeof resourceSchema>;
export const resourceSchema = z.object({
  air: z.string(),
  strength: z.number().default(1),
});
