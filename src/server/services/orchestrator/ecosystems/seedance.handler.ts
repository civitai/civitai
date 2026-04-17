/**
 * Seedance Ecosystem Handler
 *
 * Handles Seedance video generation workflows using videoGen step type.
 * Supports v2 model with txt2vid and img2vid.
 */

import type { SeedanceVideoGenInput, VideoGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type SeedanceCtx = EcosystemGraphOutput & { ecosystem: 'Seedance' };

/**
 * Creates videoGen input for Seedance ecosystem.
 */
export const createSeedanceInput = defineHandler<SeedanceCtx, [VideoGenStepTemplate]>(
  (data) => {
    const images = data.images?.map((x) => x.url);

    return [
      {
        $type: 'videoGen',
        input: removeEmpty({
          engine: 'seedance',
          model: 'v2',
          prompt: data.prompt,
          aspectRatio: data.aspectRatio?.value as SeedanceVideoGenInput['aspectRatio'],
          duration: data.duration as SeedanceVideoGenInput['duration'],
          resolution:
            'resolution' in data
              ? (data.resolution as SeedanceVideoGenInput['resolution'])
              : undefined,
          generateAudio: 'generateAudio' in data ? data.generateAudio : undefined,
          seed: data.seed,
          images,
        }) as SeedanceVideoGenInput,
      },
    ];
  }
);
