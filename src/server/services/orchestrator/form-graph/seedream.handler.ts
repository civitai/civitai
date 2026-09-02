/** Seedream handler for the form-graph lane — one seedream-engine imageGen step. */

import type { ImageGenStepTemplate, SeedreamImageGenInput, SeedreamVersion } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { seedreamVersionIds } from '~/shared/form-graph/generation/image/seedream.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import type { LooseGenerationData } from './types';

const versionIdToVersion = new Map<number, SeedreamVersion>(
  Object.entries(seedreamVersionIds).map(([version, id]) => [id, version as SeedreamVersion])
);

export const createSeedreamInput = defineHandler<LooseGenerationData, [ImageGenStepTemplate]>(
  (data) => {
    const version: SeedreamVersion =
      (data.model?.id != null ? versionIdToVersion.get(data.model.id) : undefined) ?? 'v5.0-pro';

    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'seedream',
          prompt: data.prompt,
          width: data.aspectRatio?.width,
          height: data.aspectRatio?.height,
          version,
          images: data.images?.map((x) => x.url),
          guidanceScale: data.cfgScale,
          enableSafetyChecker: false,
          seed: data.seed,
          quantity: data.quantity ?? 1,
        }) as SeedreamImageGenInput,
      },
    ];
  }
);
