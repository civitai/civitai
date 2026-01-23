/**
 * MiniMax Ecosystem Handler
 *
 * Handles MiniMax (Hailuo) video generation workflows using videoGen step type.
 * Supports txt2vid and img2vid workflows with minimal configuration.
 */

import type { MiniMaxVideoGenInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type MiniMaxCtx = EcosystemGraphOutput & { baseModel: 'MiniMax' };

/**
 * Creates videoGen input for MiniMax ecosystem.
 * Minimal configuration - the model handles most parameters automatically.
 */
export async function createMiniMaxInput(data: MiniMaxCtx): Promise<MiniMaxVideoGenInput> {
  const hasImages = !!data.images?.length;

  return removeEmpty({
    engine: 'minimax',
    prompt: data.prompt,
    images: hasImages ? data.images?.map((x) => x.url) : undefined,
    enablePromptEnhancer: 'enablePromptEnhancer' in data ? data.enablePromptEnhancer : undefined,
  }) as MiniMaxVideoGenInput;
}
