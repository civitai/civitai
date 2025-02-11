import z from 'zod';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  imageEnhancementSchema,
  negativePromptSchema,
  seedSchema,
  textEnhancementSchema,
  promptSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const lightricksAspectRatios = ['16:9', '3:2', '1:1', '2:3'] as const;
export const lightricksDuration = [5, 10] as const;

const sharedSchema = z.object({
  engine: z.literal('lightricks'),
  model: z.string().default('urn:air:ltxv:checkpoint:civitai:982559@1182093'),
  workflow: z.string(),
  negativePrompt: negativePromptSchema,
  duration: numberEnum(lightricksDuration).default(5).catch(5),
  cfgScale: z.number().min(3).max(3.5).default(3).catch(3),
  steps: z.number().min(20).max(30).default(25).catch(25),
  frameRate: z.number().optional(),
  seed: seedSchema,
});

const lightricksTxt2VidSchema = textEnhancementSchema.merge(sharedSchema).extend({
  aspectRatio: z.enum(lightricksAspectRatios).default('3:2').catch('3:2'),
});

const lightricksImg2VidSchema = imageEnhancementSchema.merge(sharedSchema).extend({
  prompt: promptSchema,
});

const lightricksTxt2VidConfig = new VideoGenerationConfig({
  subType: 'txt2vid',
  engine: 'lightricks',
  schema: lightricksTxt2VidSchema,
  metadataDisplayProps: ['cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
});

const lightricksImg2VidConfig = new VideoGenerationConfig({
  subType: 'img2vid',
  engine: 'lightricks',
  schema: lightricksImg2VidSchema,
  metadataDisplayProps: ['cfgScale', 'steps', 'duration', 'seed'],
});

export const lightricksVideoGenerationConfig = [lightricksTxt2VidConfig, lightricksImg2VidConfig];

// type Test = Prettify<LightricksVideoGenInput>;

// const test = {
//   tags: [],
//   steps: [
//     {
//       $type: 'videoGen',
//       input: {
//         engine: 'lightricks',
//         prompt: '',
//         negativePrompt: '',
//         cfgScale: 0.5,
//         aspectRatio: '1:1',
//         duration: 5,
//         seed: 13541234,
//         steps: 25,
//       },
//     },
//   ],
// };
