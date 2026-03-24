/**
 * Mochi Ecosystem Handler
 *
 * Handles Mochi video generation workflows using videoGen step type.
 * Mochi 1 preview by Genmo - state-of-the-art open video generation.
 * Supports txt2vid workflow only.
 */

import type { MochiVideoGenInput, VideoGenStepTemplate } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type MochiCtx = EcosystemGraphOutput & { ecosystem: 'Mochi' };

/**
 * Creates videoGen input for Mochi ecosystem.
 * Txt2vid only with minimal configuration.
 */
export const createMochiInput = defineHandler<MochiCtx, [VideoGenStepTemplate]>((data, ctx) => {
  return [
    {
      $type: 'videoGen',
      input: removeEmpty({
        engine: 'mochi',
        prompt: data.prompt,
        quantity: data.quantity ?? 1,
        seed: data.seed,
        enablePromptEnhancer:
          'enablePromptEnhancer' in data ? data.enablePromptEnhancer : undefined,
      }) as MochiVideoGenInput,
    },
  ];
});
