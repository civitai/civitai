import { KlingModel, MiniMaxVideoGenModel } from '@civitai/client';
import { z } from 'zod';

const baseVideoSchema = z.object({
  workflow: z.string(),
  engine: z.string(),
  prompt: z.string().max(1500, 'Prompt cannot be longer than 1500 characters').default(''),
  seed: z.number().min(0).max(4294967295).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const haiperVideoGenerationSchema = baseVideoSchema.extend({
  engine: z.literal('haiper'),
  model: z.string().default('v2'),
  negativePrompt: z.string().max(1000, 'Prompt cannot be longer than 1000 characters').optional(),
  image: z.string().optional(),
  // cameraMovement: z.string().optional(),
  duration: z.coerce.number().optional(),
  aspectRatio: z.string().optional(),
  sourceImageUrl: z.string().optional(),
  resolution: z.number().default(1080),
  enablePromptEnhancer: z.boolean().optional(),
});

export const klingVideoGenerationSchema = baseVideoSchema.extend({
  engine: z.literal('kling'),
  model: z.string().default(KlingModel.V1_5),
  negativePrompt: z.string().max(1000, 'Prompt cannot be longer than 1000 characters').optional(),
  cfgScale: z.number().min(0).max(1).optional(),
  mode: z.string().optional(),
  duration: z.coerce.number().optional(),
  seed: z.number().optional(),
  aspectRatio: z.string().optional(),
  sourceImageUrl: z.string().optional(),
});

export const minimaxVideoGenerationSchema = baseVideoSchema.extend({
  engine: z.literal('minimax'),
  model: z.string().default(MiniMaxVideoGenModel.HAILOU),
  enablePromptEnhancer: z.boolean().optional(),
  sourceImageUrl: z.string().optional(),
});

export const mochiVideoGenerationSchema = baseVideoSchema.extend({
  engine: z.literal('mochi'),
  width: z.number().default(848),
  height: z.number().default(480),
  enablePromptEnhancer: z.boolean().optional(),
});

export type VideoGenerationInput = z.input<typeof videoGenerationSchema>;
export type VideoGenerationSchema = z.infer<typeof videoGenerationSchema>;
export const videoGenerationSchema = z.discriminatedUnion('engine', [
  haiperVideoGenerationSchema,
  klingVideoGenerationSchema,
  mochiVideoGenerationSchema,
  minimaxVideoGenerationSchema,
]);

const baseGenerationSchema = z.object({
  civitaiTip: z.number().default(0),
  creatorTip: z.number().default(0),
  tags: z.string().array().optional(),
});

export type GenerationSchema = z.infer<typeof generationSchema>;
export const generationSchema = z.discriminatedUnion('type', [
  baseGenerationSchema.extend({ type: z.literal('video'), data: videoGenerationSchema }),
  baseGenerationSchema.extend({ type: z.literal('image'), data: z.object({}) }),
]);
