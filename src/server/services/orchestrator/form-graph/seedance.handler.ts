/**
 * Seedance handler for the form-graph lane. txt2vid and img2vid via the
 * `seedance` videoGen engine; the model version comes from the checkpoint id.
 */

import type { SeedanceVideoGenInput, VideoGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { seedanceVersionIds } from '~/shared/form-graph/generation/video/seedance.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import type { EcosystemData } from './types';

const versionIdToModel = new Map<number, SeedanceVideoGenInput['model']>(
  Object.entries(seedanceVersionIds).map(([model, id]) => [
    id,
    model as SeedanceVideoGenInput['model'],
  ])
);

export const createSeedanceInput = defineHandler<EcosystemData<'Seedance'>, [VideoGenStepTemplate]>(
  (data) => {
    const images = data.images?.map((x) => x.url);
    const model = (data.model && versionIdToModel.get(data.model.id)) ?? 'v2';

    return [
      {
        $type: 'videoGen',
        input: removeEmpty({
          engine: 'seedance',
          model,
          prompt: data.prompt,
          aspectRatio: data.aspectRatio?.value as SeedanceVideoGenInput['aspectRatio'],
          duration: data.duration as SeedanceVideoGenInput['duration'],
          resolution: data.resolution as SeedanceVideoGenInput['resolution'],
          generateAudio: data.generateAudio,
          seed: data.seed,
          images,
        }) as SeedanceVideoGenInput,
      },
    ];
  }
);
