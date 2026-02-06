/**
 * Vidu Ecosystem Handler
 *
 * Handles Vidu Q1 video generation workflows using videoGen step type.
 * Supports txt2vid, img2vid (with first/last frame), and ref2vid workflows.
 */

import type { ViduVideoGenInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type ViduCtx = EcosystemGraphOutput & { ecosystem: 'Vidu' };

/**
 * Creates videoGen input for Vidu ecosystem.
 * Supports txt2vid, img2vid, img2vid:first-last-frame, and img2vid:ref2vid workflows.
 */
export const createViduInput = defineHandler<ViduCtx, ViduVideoGenInput>((data, ctx) => {
  const hasImages = !!data.images?.length;

  return removeEmpty({
    engine: 'vidu',
    prompt: data.prompt,
    aspectRatio: data.aspectRatio?.value as ViduVideoGenInput['aspectRatio'],
    style: 'style' in data ? data.style : undefined,
    movementAmplitude: 'movementAmplitude' in data ? data.movementAmplitude : undefined,
    images: hasImages ? data.images?.map((x) => x.url) : undefined,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    enablePromptEnhancer: 'enablePromptEnhancer' in data ? data.enablePromptEnhancer : undefined,
  }) as ViduVideoGenInput;
});
