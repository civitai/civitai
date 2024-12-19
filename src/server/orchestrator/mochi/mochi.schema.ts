import z from 'zod';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  promptSchema,
  seedSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';

const mochiTxt2VidSchema = textEnhancementSchema.extend({
  engine: z.literal('mochi'),
  workflow: z.string(),
  prompt: promptSchema,
  seed: seedSchema,
  enablePromptEnhancer: z.boolean().default(true),
});

const mochiTxt2ImgConfig = new VideoGenerationConfig({
  subType: 'txt2vid',
  engine: 'mochi',
  schema: mochiTxt2VidSchema,
  metadataDisplayProps: [],
});

export const mochiVideoGenerationConfig = [mochiTxt2ImgConfig];
