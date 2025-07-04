import type { HunyuanVdeoGenInput } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  baseVideoGenerationSchema,
  promptSchema,
  resourceSchema,
  seedSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { getResolutionsFromAspectRatios } from '~/utils/aspect-ratio-helpers';
import { numberEnum } from '~/utils/zod-helpers';

export const hunyuanAspectRatios = ['16:9', '3:2', '1:1', '2:3', '9:16'] as const;
export const hunyuanDuration = [3, 5] as const;

const aspectRatios = getResolutionsFromAspectRatios(480, [...hunyuanAspectRatios]);

const schema = baseVideoGenerationSchema.extend({
  baseModel: z.string().default('HyV1').catch('HyV1'),
  engine: z.literal('hunyuan').catch('hunyuan'),
  prompt: promptSchema,
  // sourceImage: sourceImageSchema.nullish(),
  cfgScale: z.number().min(1).max(10).default(6).catch(6),
  frameRate: z.literal(24).default(24).catch(24),
  duration: numberEnum(hunyuanDuration).default(5).catch(5),
  seed: seedSchema,
  steps: z.number().default(20),
  model: z.string().optional(),
  aspectRatio: z.enum(hunyuanAspectRatios).default('1:1').catch('1:1'),
  resources: z.array(resourceSchema.passthrough()).nullable().default(null),
});

export const hunyuanGenerationConfig = VideoGenerationConfig2({
  label: 'Hunyuan',
  whatIfProps: ['duration', 'steps', 'aspectRatio', 'cfgScale', 'draft', 'resources'],
  schema,
  metadataDisplayProps: ['process', 'cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
  defaultValues: { aspectRatio: '1:1' },
  processes: ['txt2vid'],
  transformFn: (data) => ({ ...data, process: 'txt2vid' }),
  inputFn: ({ aspectRatio, resources, ...args }): HunyuanVdeoGenInput => {
    const [width, height] = aspectRatios[aspectRatio];
    return {
      ...args,
      width,
      height,
      steps: 20,
      model: 'urn:air:hyv1:checkpoint:civitai:1167575@1314512',
      loras: resources?.map(({ air, strength }) => ({ air, strength })),
    };
  },
});
