/**
 * Mochi Ecosystem Handler
 *
 * Handles Mochi video generation workflows using videoGen step type.
 * Mochi 1 preview by Genmo - state-of-the-art open video generation.
 * Supports txt2vid workflow only.
 */

import type { MochiVideoGenInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type MochiCtx = EcosystemGraphOutput & { baseModel: 'Mochi' };

/**
 * Creates videoGen input for Mochi ecosystem.
 * Txt2vid only with minimal configuration.
 */
export async function createMochiInput(data: MochiCtx): Promise<MochiVideoGenInput> {
  return removeEmpty({
    engine: 'mochi',
    prompt: data.prompt,
    seed: data.seed,
    enablePromptEnhancer: 'enablePromptEnhancer' in data ? data.enablePromptEnhancer : undefined,
  }) as MochiVideoGenInput;
}
