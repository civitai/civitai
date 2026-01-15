import type { ComfyLtx2CreateVideoInput, LightricksVideoGenInput } from '@civitai/client';
import * as z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  negativePromptSchema,
  seedSchema,
  promptSchema,
  baseVideoGenerationSchema,
  sourceImageSchema,
  resourceSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import {
  findClosestAspectRatio,
  getResolutionsFromAspectRatios,
} from '~/utils/aspect-ratio-helpers';
import { numberEnum } from '~/utils/zod-helpers';

export const lightricksAspectRatios = ['16:9', '9:16'] as const;
export const lightricksDuration = [5] as const;
export const ltx2AspectRatios = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;
export const ltx2Duration = [3, 5] as const;
export const ltx2Models = ['19b-dev', '19b-distilled'] as const;

// Model version ID to model name mapping
export const ltx2ModelVersionMap: Record<number, (typeof ltx2Models)[number]> = {
  2578325: '19b-dev',
  2600562: '19b-distilled',
};

// Reverse mapping: model name to version ID
export const ltx2ModelToVersionMap: Record<(typeof ltx2Models)[number], number> = {
  '19b-dev': 2578325,
  '19b-distilled': 2600562,
};

const ltxv2AirModelVersionMap = new Map([
  [2578325, 'urn:air:ltxv:checkpoint:civitai:2291192@2578325'],
  [2600562, 'urn:air:ltxv:checkpoint:civitai:2291192@2600562'],
]);

const ltx2Resolutions = getResolutionsFromAspectRatios(480, [...ltx2AspectRatios]);

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('lightricks').default('lightricks').catch('lightricks'),
  sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema,
  aspectRatio: z.enum(lightricksAspectRatios).optional().catch('16:9'),
  duration: numberEnum(lightricksDuration).default(5).catch(5),
  cfgScale: z.number().min(3).max(3.5).default(3).catch(3),
  steps: z.number().min(20).max(30).default(25).catch(25),
  frameRate: z.number().optional(),
  seed: seedSchema,
});

export const lightricksGenerationConfig = VideoGenerationConfig2({
  label: 'Lightricks',
  whatIfProps: ['duration', 'cfgScale', 'steps', 'process'],
  metadataDisplayProps: ['process', 'cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
  schema,
  defaultValues: { aspectRatio: '16:9' },
  processes: ['txt2vid', 'img2vid'],
  transformFn: (data) => {
    if (data.process === 'txt2vid') {
      delete data.sourceImage;
    }

    if (data.sourceImage) {
      data.aspectRatio = findClosestAspectRatio(data.sourceImage, [...lightricksAspectRatios]);
    }
    return data;
  },
  superRefine: (data, ctx) => {
    if (data.process === 'img2vid' && !data.sourceImage) {
      ctx.addIssue({
        code: 'custom',
        message: 'Image is required',
        path: ['sourceImage'],
      });
    }
    if (data.process === 'txt2vid' && !data.prompt?.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Prompt is required',
        path: ['prompt'],
      });
    }
  },
  inputFn: ({ sourceImage, ...args }): LightricksVideoGenInput => {
    return {
      ...args,
      expandPrompt: false,
      sourceImage: sourceImage?.url,
    };
  },
});

// LTXV2 Schema
const ltx2Schema = baseVideoGenerationSchema.extend({
  engine: z.literal('ltx2').default('ltx2').catch('ltx2'),
  modelVersionId: z
    .number()
    .default(ltx2ModelToVersionMap['19b-dev'])
    .catch(ltx2ModelToVersionMap['19b-dev']),
  images: sourceImageSchema.array().nullish(),
  prompt: promptSchema,
  negativePrompt: negativePromptSchema,
  aspectRatio: z.enum(ltx2AspectRatios).default('16:9').catch('16:9'),
  duration: numberEnum(ltx2Duration).default(5).catch(5),
  cfgScale: z.number().min(1).max(10).default(3).catch(3),
  steps: z.number().min(20).max(50).default(30).catch(30),
  generateAudio: z.boolean().default(false).catch(false),
  seed: seedSchema,
  resources: resourceSchema.array().nullish(),
});

export const ltx2GenerationConfig = VideoGenerationConfig2({
  label: 'LTX Video 2',
  whatIfProps: ['duration', 'cfgScale', 'steps', 'process', 'modelVersionId'],
  metadataDisplayProps: [
    'process',
    'cfgScale',
    'steps',
    'aspectRatio',
    'duration',
    'seed',
    'modelVersionId',
  ],
  schema: ltx2Schema,
  defaultValues: {
    aspectRatio: '16:9',
    duration: 5,
    modelVersionId: ltx2ModelToVersionMap['19b-dev'],
  },
  processes: ['txt2vid', 'img2vid'],
  transformFn: (data) => {
    if (data.process === 'txt2vid') {
      delete data.images;
    }

    if (data.images?.[0]) {
      data.aspectRatio = findClosestAspectRatio(data.images[0], [...ltx2AspectRatios]);
    }
    return {
      ...data,
      baseModel: 'LTXV2',
      resources: [
        {
          id: data.modelVersionId,
          air: ltxv2AirModelVersionMap.get(data.modelVersionId) as string,
          strength: 1,
        },
        ...(data.resources ?? []),
      ],
    };
  },
  superRefine: (data, ctx) => {
    if (data.process === 'img2vid' && (!data.images || data.images.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one image is required',
        path: ['images'],
      });
    }
    if (data.process === 'txt2vid' && !data.prompt?.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Prompt is required',
        path: ['prompt'],
      });
    }
  },
  inputFn: ({
    images,
    resources,
    aspectRatio,
    cfgScale,
    steps,
    modelVersionId,
    ...args
  }): ComfyLtx2CreateVideoInput => {
    // Convert resources array to loras record { [air]: strength }
    const loras = resources
      ?.filter((x) => !ltxv2AirModelVersionMap.get(x.id))
      ?.reduce((acc, { air, strength }) => {
        acc[air] = strength;
        return acc;
      }, {} as Record<string, number>);
    const [width, height] = ltx2Resolutions[aspectRatio];
    const model = ltx2ModelVersionMap[modelVersionId] ?? '19b-dev';
    return {
      ...args,
      operation: 'createVideo',
      width,
      height,
      model,
      guidanceScale: cfgScale,
      numInferenceSteps: steps,
      images: images?.map((img) => img.url),
      loras: loras && Object.keys(loras).length > 0 ? loras : undefined,
    };
  },
});
