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
export const flux1SafetyTolerance = ['1', '2', '3', '4', '5', '6'] as const;
type Flux1Model = (typeof flux1Models)[number];
export const flux1Models = ['pro-kontext', 'max-kontext'] as const;

export const fluxKontextModelVersionToModelMap = new Map<number, Flux1Model>([
  [1892509, 'pro-kontext'],
  [1892523, 'max-kontext'],
]);

export function getIsFluxKontext(modelVersionId?: number) {
  return modelVersionId ? !!fluxKontextModelVersionToModelMap.get(modelVersionId) : false;
}

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
  inputFn: ({ params, resources, whatIf }) => {
    let model = 'pro-kontext';
    for (const resource of resources) {
      const match = fluxKontextModelVersionToModelMap.get(resource.id);
      if (match) model = match;
    }

    let imageUrl = params.sourceImage?.url;
    if (whatIf && !params.sourceImage)
      imageUrl =
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/3fdba611-f34d-4a68-8bf8-3805629652d3/4a0f3c58d8c6a370bc926efe3279cbad.jpeg';

    return schema.parse({
      engine: params.engine,
      model,
      prompt: params.prompt,
      imageUrl,
      aspectRatio: params.aspectRatio,
      numImages: params.quantity,
      safetyTolerance: params.safetyTolerance,
      guidanceScale: params.cfgScale,
      seed: params.seed,
    });
  },
});
