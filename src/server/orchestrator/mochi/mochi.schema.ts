import { MochiVideoGenInput } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  seedSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';

const mochiTxt2VidSchema = textEnhancementSchema.extend({
  engine: z.literal('mochi'),
  workflow: z.string(),
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

export function MochiInput(
  args: z.infer<(typeof mochiVideoGenerationConfig)[number]['schema']>
): MochiVideoGenInput {
  return { ...args };
}
