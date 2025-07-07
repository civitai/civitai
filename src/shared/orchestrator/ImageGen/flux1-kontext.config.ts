import { z } from 'zod';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';

export const flux1KontextAspectRatios = [
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
type Flux1Model = (typeof flux1KontextModels)[number];
export const flux1KontextModels = ['dev', 'pro', 'max'] as const;
const engine = 'flux1-kontext';

export const fluxKontextModelVersionToModelMap = new Map<number, Flux1Model>([
  [1945998, 'dev'],
  [1892509, 'pro'],
  [1892523, 'max'],
]);

export function getIsFluxKontext(modelVersionId?: number) {
  return modelVersionId ? !!fluxKontextModelVersionToModelMap.get(modelVersionId) : false;
}

export function getIsFluxContextFromEngine(value?: string) {
  return value === engine;
}

export const flux1ModelModeOptions = [
  { label: 'Dev', value: '1945998' },
  { label: 'Pro', value: '1892509' },
  { label: 'Max', value: '1892523' },
];

const schema = z.object({
  engine: z.literal(engine).catch(engine),
  model: z.enum(flux1KontextModels),
  prompt: z.string(),
  images: z.string().array(),
  aspectRatio: z.enum(flux1KontextAspectRatios).optional(),
  quantity: z.number().optional(),
  guidanceScale: z.number().optional(),
  seed: z.number().nullish(),
});

export const flux1KontextConfig = ImageGenConfig({
  metadataFn: (params) => {
    if (params.sourceImage) {
      params.aspectRatio = findClosestAspectRatio(params.sourceImage, [
        ...flux1KontextAspectRatios,
      ]);
    }

    return {
      engine,
      process: 'img2img',
      baseModel: params.baseModel,
      prompt: params.prompt,
      sourceImage: params.sourceImage,
      aspectRatio: params.aspectRatio,
      cfgScale: params.cfgScale,
      quantity: params.quantity,
      seed: params.seed,
    };
  },
  inputFn: ({ params, resources, whatIf }) => {
    let model = 'pro';
    for (const resource of resources) {
      const match = fluxKontextModelVersionToModelMap.get(resource.id);
      if (match) model = match;
    }

    let imageUrl = params.sourceImage?.url;
    let aspectRatio = params.aspectRatio;
    if (whatIf && !imageUrl) {
      imageUrl =
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/3fdba611-f34d-4a68-8bf8-3805629652d3/4a0f3c58d8c6a370bc926efe3279cbad.jpeg';
      aspectRatio = '1:1';
    }

    return schema.parse({
      engine: params.engine,
      model,
      prompt: params.prompt,
      images: [imageUrl],
      aspectRatio,
      quantity: params.quantity,
      guidanceScale: params.cfgScale,
      seed: params.seed,
    });
  },
});
