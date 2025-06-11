import { z } from 'zod';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

export const flux1AspectRatios = [
  '21:9',
  '16:9',
  '4:3',
  '3:2',
  '1:1',
  '2:3',
  '3:4',
  '9:16',
  '9:21',
] as const;
type Flux1Model = (typeof flux1Models)[number];
export const flux1Models = ['pro-kontext', 'max-kontext'] as const;

const modelVersionToModelMap = new Map<number, Flux1Model>([
  [1892509, 'pro-kontext'],
  [1892523, 'max-kontext'],
]);

const schema = z.object({
  engine: z.literal('flux1').catch('flux1'),
  model: z.enum(flux1Models),
  prompt: z.string(),
  imageUrl: z.string(),
  aspectRatio: z.enum(flux1AspectRatios).optional(),
  numImages: z.number().optional(),
  safetyTolerance: z.string().optional(),
  guidanceScale: z.number().optional(),
  seed: z.number().nullish(),
});

export const flux1Config = ImageGenConfig({
  metadataFn: (params) => ({
    engine: 'flux1',
    process: 'img2img',
    prompt: params.prompt,
    sourceImage: params.sourceImage,
    aspectRatio: params.aspectRatio,
    quantity: params.quantity,
    cfgScale: params.cfgScale,
    safetyTolerance: params.safetyTolerance,
    seed: params.seed,
  }),
  inputFn: ({ params, resources }) => {
    let model = 'pro-kontext';
    for (const resource of resources) {
      const match = modelVersionToModelMap.get(resource.id);
      if (match) model = match;
    }

    return schema.parse({
      engine: params.engine,
      model,
      prompt: params.prompt,
      imageUrl: params.sourceImage?.url,
      aspectRatio: params.aspectRatio ? flux1AspectRatios[Number(params.aspectRatio)] : undefined,
      numImages: params.quantity,
      safetyTolerance: params.safetyTolerance,
      guidanceScale: params.cfgScale,
      seed: params.seed,
    });
  },
});
