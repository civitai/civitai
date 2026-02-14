/**
 * Sora Ecosystem Handler
 *
 * Handles OpenAI Sora 2 video generation workflows using videoGen step type.
 * Supports txt2vid and img2vid workflows.
 */

import type { Sora2TextToVideoInput, Sora2ImageToVideoInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type SoraCtx = EcosystemGraphOutput & { ecosystem: 'Sora2' };

// Return type union
type SoraInput = Sora2TextToVideoInput | Sora2ImageToVideoInput;

/**
 * Creates videoGen input for Sora ecosystem.
 * Supports txt2vid and img2vid with resolution, pro mode, and duration options.
 */
export const createSoraInput = defineHandler<SoraCtx, SoraInput>((data, ctx) => {
  const hasImages = !!data.images?.length;

  const baseInput = {
    engine: 'sora',
    prompt: data.prompt,
    aspectRatio: data.aspectRatio?.value as SoraInput['aspectRatio'],
    resolution: 'resolution' in data ? data.resolution : undefined,
    usePro: 'usePro' in data ? data.usePro : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    operation: 'text-to-video',
  };

  if (hasImages) {
    return removeEmpty({
      ...baseInput,
      images: data.images?.map((x) => x.url),
      operation: 'image-to-video',
    }) as Sora2ImageToVideoInput;
  } else {
    return removeEmpty(baseInput) as Sora2TextToVideoInput;
  }
});
