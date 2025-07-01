import type { CivitaiWanVideoGenInput, FALWanVideoGenInput } from '@civitai/client';
import z from 'zod';
import { VideoGenerationConfig2 } from '~/server/orchestrator/infrastructure/GenerationConfig';
import {
  seedSchema,
  promptSchema,
  resourceSchema,
  baseVideoGenerationSchema,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import {
  findClosestAspectRatio,
  getResolutionsFromAspectRatiosMap,
} from '~/utils/aspect-ratio-helpers';
import { numberEnum, zodEnumFromObjKeys } from '~/utils/zod-helpers';

export const wanAspectRatios = ['16:9', '3:2', '1:1', '2:3', '9:16'] as const;
const wanFalAspectRatios = ['4:3', '16:9', '9:16'] as const;
export const wanDuration = [3, 5] as const;
export const wanResolution = [480, 720] as const;

const resolutionMap = getResolutionsFromAspectRatiosMap([...wanResolution], [...wanAspectRatios]);

export const wanBaseModelMap = {
  // WanVideo1_3B_T2V: {
  //   process: 'txt2vid',
  //   label: 'Wan Video 1.3B t2v',
  //   model: 'urn:air:wanvideo1_3b_t2v:checkpoint:civitai:1329096@1500646',
  //   default: false,
  // },
  WanVideo14B_T2V: {
    process: 'txt2vid',
    label: '480p',
    model: 'urn:air:wanvideo14b_t2v:checkpoint:civitai:1329096@1707796',
    default: true,
    resolution: 480,
    provider: 'civitai',
  },
  WanVideo14B_I2V_480p: {
    process: 'img2vid',
    label: '480p',
    model: 'urn:air:wanvideo14b_i2v_480p:checkpoint:civitai:1329096@1501125',
    default: false,
    resolution: 480,
    provider: 'civitai',
  },
  WanVideo14B_I2V_720p: {
    process: 'img2vid',
    label: '720p',
    model: 'urn:air:wanvideo14b_i2v_720p:checkpoint:civitai:1329096@1501344',
    default: true,
    resolution: 720,
    provider: 'fal',
  },
};

const schema = baseVideoGenerationSchema.extend({
  engine: z.literal('wan').catch('wan'),
  baseModel: zodEnumFromObjKeys(wanBaseModelMap),
  sourceImage: sourceImageSchema.nullish(),
  prompt: promptSchema,
  aspectRatio: z.enum(wanAspectRatios).optional().catch('1:1'),
  cfgScale: z.number().min(1).max(10).optional().catch(4),
  frameRate: z.literal(16).optional().catch(16),
  duration: numberEnum(wanDuration).optional().catch(5),
  seed: seedSchema,
  resources: z.array(resourceSchema.passthrough()).nullable().default(null),
});

export const wanGenerationConfig = VideoGenerationConfig2({
  label: 'Wan',
  whatIfProps: [
    'process',
    'duration',
    'steps',
    'aspectRatio',
    'cfgScale',
    'draft',
    'resources',
    'sourceImage',
    'baseModel',
  ],
  metadataDisplayProps: ['process', 'cfgScale', 'steps', 'aspectRatio', 'duration', 'seed'],
  schema,
  defaultValues: {
    process: 'txt2vid',
    baseModel: 'WanVideo14B_T2V',
    aspectRatio: '1:1',
    duration: 5,
    cfgScale: 4,
    frameRate: 16,
  },
  processes: ['txt2vid', 'img2vid'],
  transformFn: (data) => {
    if (!data.process) {
      if (data.baseModel?.includes('i2v')) {
        data.process = 'img2vid';
      } else if (data.baseModel?.includes('t2v')) {
        data.process = 'txt2vid';
      }
    }

    if (data.process === 'txt2vid') {
      delete data.sourceImage;
    } else if (data.process === 'img2vid') {
      delete data.aspectRatio;
    }
    return { ...data, steps: 20 };
  },
  superRefine: (data, ctx) => {
    if (data.process === 'img2vid' && !data.sourceImage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Image is required',
        path: ['sourceImage'],
      });
    }

    if (!data.sourceImage && !data.prompt?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Prompt is required',
        path: ['prompt'],
      });
    }
  },
  inputFn: ({
    sourceImage,
    resources,
    baseModel,
    ...args
  }): CivitaiWanVideoGenInput | FALWanVideoGenInput => {
    const config = wanBaseModelMap[baseModel!];

    const values = {
      ...args,
      loras: resources?.map(({ air, strength }) => ({ air, strength })),
    };

    if (config.provider === 'fal') {
      const imageOrAspectRatio = sourceImage ?? args.aspectRatio;
      const aspectRatio = imageOrAspectRatio
        ? findClosestAspectRatio(imageOrAspectRatio, [...wanFalAspectRatios])
        : undefined;
      return { ...values, provider: 'fal', aspectRatio, enablePromptExpansion: false };
    } else {
      const aspectRatios = resolutionMap.get(config.resolution)!;
      const aspectRatio = sourceImage
        ? findClosestAspectRatio(sourceImage, [...wanAspectRatios])
        : args.aspectRatio ?? '1:1';
      const [width, height] = aspectRatios[aspectRatio];
      const model = config.model;
      return {
        ...values,
        provider: 'civitai',
        width,
        height,
        sourceImage: sourceImage?.url,
        model,
      };
    }
  },
  // legacyMapFn: (args) => {
  //   return {
  //     ...args,
  //   };
  // },
});
