import type { SeedreamImageGenInput, SeedreamVersion } from '@civitai/client';
import { ImageGenConfig } from '~/shared/orchestrator/ImageGen/ImageGenConfig';

type SeedreamModel = (typeof seedreamModels)[number];
export const seedreamModels: SeedreamVersion[] = ['v3', 'v4'];

export const seedreamModelVersionToModelMap = new Map<number, SeedreamModel>([
  [2208174, 'v3'],
  [2208278, 'v4'],
]);

export function getIsSeedream(modelVersionId?: number) {
  return modelVersionId ? !!seedreamModelVersionToModelMap.get(modelVersionId) : false;
}

export const seedreamConfig = ImageGenConfig({
  metadataFn: (params) => {
    return {
      engine: 'seedream',
      baseModel: params.baseModel,
      process: !params.images?.length ? 'txt2img' : 'img2img',
      prompt: params.prompt,
      quantity: params.quantity,
      images: params.images,
      width: params.width,
      height: params.height,
      cfgScale: params.cfgScale,
      seed: params.seed,
    };
  },
  inputFn: ({ params, resources }): SeedreamImageGenInput => {
    let version: SeedreamVersion = 'v4';
    for (const resource of resources) {
      const match = seedreamModelVersionToModelMap.get(resource.id);
      if (match) version = match;
    }

    return {
      ...params,
      version,
      images: params.images?.map((x) => x.url),
      guidanceScale: params.cfgScale,
      enableSafetyChecker: false,
    } as SeedreamImageGenInput;
  },
});
