import { MiniMaxVideoGenInput, MiniMaxVideoGenModel } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  imageEnhancementSchema,
  promptSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';

const baseMinimaxSchema = z.object({
  engine: z.literal('minimax'),
  workflow: z.string(),
  model: z
    .nativeEnum(MiniMaxVideoGenModel)
    .default(MiniMaxVideoGenModel.HAILOU)
    .catch(MiniMaxVideoGenModel.HAILOU),
});

const minRatio = 2 / 5;
const maxRatio = 5 / 2;
const minSize = 300;

const minimaxTxt2VidSchema = textEnhancementSchema.merge(baseMinimaxSchema);
const minimaxImg2VidSchema = imageEnhancementSchema
  .merge(baseMinimaxSchema)
  .extend({ prompt: promptSchema });

const minimaxTxt2ImgConfig = new VideoGenerationConfig({
  subType: 'txt2vid',
  engine: 'minimax',
  schema: minimaxTxt2VidSchema,
  metadataDisplayProps: [],
});

const minimaxImg2VidConfig = new VideoGenerationConfig({
  subType: 'img2vid',
  engine: 'minimax',
  schema: minimaxImg2VidSchema,
  metadataDisplayProps: [],
});

export const minimaxVideoGenerationConfig = [minimaxTxt2ImgConfig, minimaxImg2VidConfig];

export function MinimaxInput(
  args: z.infer<(typeof minimaxVideoGenerationConfig)[number]['schema']>
): MiniMaxVideoGenInput {
  const sourceImage = 'sourceImage' in args ? args.sourceImage.url : undefined;
  return { ...args, sourceImage };
}
