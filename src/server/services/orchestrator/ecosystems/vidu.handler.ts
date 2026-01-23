/**
 * Vidu Ecosystem Handler
 *
 * Handles Vidu Q1 video generation workflows using videoGen step type.
 * Supports txt2vid, img2vid (with first/last frame), and ref2vid workflows.
 */

import type { ViduVideoGenInput } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type ViduCtx = EcosystemGraphOutput & { baseModel: 'Vidu' };

/**
 * Creates videoGen input for Vidu ecosystem.
 * Supports txt2vid, img2vid, img2vid:first-last-frame, and img2vid:ref2vid workflows.
 */
export async function createViduInput(data: ViduCtx): Promise<ViduVideoGenInput> {
  const seed = data.seed ?? Math.floor(Math.random() * maxRandomSeed);
  const hasImages = !!data.images?.length;

  return removeEmpty({
    engine: 'vidu',
    prompt: data.prompt,
    aspectRatio: data.aspectRatio?.value as ViduVideoGenInput['aspectRatio'],
    style: 'style' in data ? data.style : undefined,
    movementAmplitude: 'movementAmplitude' in data ? data.movementAmplitude : undefined,
    images: hasImages ? data.images?.map((x) => x.url) : undefined,
    seed,
    enablePromptEnhancer: 'enablePromptEnhancer' in data ? data.enablePromptEnhancer : undefined,
  }) as ViduVideoGenInput;
}
