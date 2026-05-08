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
  // Allow any Civitai-controlled host — orchestrator subdomain, the image
  // CDN, and the apex domains across every TLD (`civitai.com`, `.red`,
  // `.green`, etc). The apex branch is needed for static assets served by
  // Next from the apex domain (e.g. comic layout PNGs at
  // `/images/comics/layouts/...`).
  url: z
    .string()
    .startsWith('https://orchestration')
    .includes('.civitai.com')
    .or(z.string().includes('.civitai.red'))
    .or(z.string().includes('image.civitai.red'))
    .or(z.string().includes('image.civitai.com'))
    .or(z.string().startsWith('https://civitai.')),
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
