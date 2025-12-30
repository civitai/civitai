import { Priority } from '@civitai/client';
import * as z from 'zod';
import { maxUpscaleSize } from '~/server/common/constants';

export const promptSchema = z
  .string()
  // .max(1500, 'Prompt cannot be longer than 1500 characters')
  .default('');

export const negativePromptSchema = z
  .string()
  // .max(1000, 'Prompt cannot be longer than 1000 characters')
  .default('');

export type SourceImageProps = z.input<typeof sourceImageSchema>;
export const sourceImageSchema = z.object({
  url: z
    .string()
    .startsWith('https://orchestration')
    .includes('.civitai.com')
    .or(z.string().includes('image.civitai.com')),
  width: z.number(),
  height: z.number(),
  upscaleWidth: z.number().max(maxUpscaleSize).optional(),
  upscaleHeight: z.number().max(maxUpscaleSize).optional(),
});

export const seedSchema = z.number().nullish();
const prioritySchema = z.enum(Priority).optional().catch('low');

// const baseGenerationSchema = z.object({
//   priority: prioritySchema,
//   /** temporary property to satisfy type constraints */
//   workflow: z.string().optional(),
// });

export type BaseVideoGenerationSchema = typeof baseVideoGenerationSchema;
export const baseVideoGenerationSchema = z.object({
  priority: prioritySchema.optional(),
  /** temporary property to satisfy type constraints */
  workflow: z.string().optional(),
  process: z.enum(['txt2vid', 'img2vid']).default('txt2vid'),
});

export type ResourceInput = z.input<typeof resourceSchema>;
export const resourceSchema = z.object({
  id: z.number(),
  air: z.string(),
  strength: z.number().default(1),
  epochNumber: z.number().optional(),
});
