import z from 'zod';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  imageEnhancementSchema,
  negativePromptSchema,
  seedSchema,
  textEnhancementSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { numberEnum } from '~/utils/zod-helpers';

export const lightricksAspectRatios = ['16:9', '1:1', '9:16'] as const;
export const lightricksDuration = [5, 10] as const;

const lightricksTxt2VidSchema = textEnhancementSchema.extend({
  engine: z.literal('lightricks'),
  workflow: z.string(),
  negativePrompt: negativePromptSchema,
  aspectRatio: z.enum(lightricksAspectRatios).default('1:1').catch('1:1'),
  duration: numberEnum(lightricksDuration).default(5).catch(5),
  cfgScale: z.number().min(0.1).max(1).default(0.5).catch(0.5),
  steps: z.number().min(20).max(30).default(25).catch(25),
  frameRate: z.number().optional(),
  seed: seedSchema,
});

const lightricksTxt2VidConfig = new VideoGenerationConfig({
  subType: 'txt2vid',
  engine: 'lightricks',
  schema: lightricksTxt2VidSchema,
  metadataDisplayProps: ['cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
});

export const lightricksVideoGenerationConfig = [lightricksTxt2VidConfig];

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
