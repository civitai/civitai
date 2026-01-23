/**
 * Sora Ecosystem Handler
 *
 * Handles OpenAI Sora 2 video generation workflows using videoGen step type.
 * Supports txt2vid and img2vid workflows.
 */

import type { Sora2TextToVideoInput, Sora2ImageToVideoInput } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type SoraCtx = EcosystemGraphOutput & { baseModel: 'Sora2' };

// Return type union
type SoraInput = Sora2TextToVideoInput | Sora2ImageToVideoInput;

/**
 * Creates videoGen input for Sora ecosystem.
 * Supports txt2vid and img2vid with resolution, pro mode, and duration options.
 */
export async function createSoraInput(data: SoraCtx): Promise<SoraInput> {
  const seed = data.seed ?? Math.floor(Math.random() * maxRandomSeed);
  const hasImages = !!data.images?.length;

  const baseInput = {
    engine: 'sora',
    prompt: data.prompt,
    aspectRatio: data.aspectRatio?.value as SoraInput['aspectRatio'],
    resolution: 'resolution' in data ? data.resolution : undefined,
    usePro: 'usePro' in data ? data.usePro : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    seed,
  };

  if (hasImages) {
    return removeEmpty({
      ...baseInput,
      images: data.images?.map((x) => x.url),
    }) as Sora2ImageToVideoInput;
  } else {
    return removeEmpty(baseInput) as Sora2TextToVideoInput;
  }
}
