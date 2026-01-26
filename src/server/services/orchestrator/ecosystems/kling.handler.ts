/**
 * Kling Ecosystem Handler
 *
 * Handles Kling video generation workflows using videoGen step type.
 * Supports txt2vid and img2vid workflows with multiple model versions.
 */

import type { KlingVideoGenInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { klingVersionIds } from '~/shared/data-graph/generation/kling-graph';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type KlingCtx = EcosystemGraphOutput & { baseModel: 'Kling' };

// Map from version ID to model version string
type KlingModel = 'v1_6' | 'v2' | 'v2_5_turbo';
const versionIdToModel = new Map<number, KlingModel>([
  [klingVersionIds.v1_6, 'v1_6'],
  [klingVersionIds.v2, 'v2'],
  [klingVersionIds.v2_5_turbo, 'v2_5_turbo'],
]);

/**
 * Creates videoGen input for Kling ecosystem.
 * Supports txt2vid and img2vid with model versions, modes, and duration options.
 */
export async function createKlingInput(data: KlingCtx): Promise<KlingVideoGenInput> {
  const hasImages = !!data.images?.length;

  // Determine model version
  let model: KlingModel = 'v1_6';
  if (data.model) {
    const match = versionIdToModel.get(data.model.id);
    if (match) model = match;
  }

  return removeEmpty({
    engine: 'kling',
    model,
    prompt: data.prompt,
    negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
    aspectRatio: data.aspectRatio?.value as KlingVideoGenInput['aspectRatio'],
    mode: 'mode' in data ? data.mode : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    cfgScale: 'cfgScale' in data ? data.cfgScale : undefined,
    images: hasImages ? data.images?.map((x) => x.url) : undefined,
    seed: data.seed,
    enablePromptEnhancer: 'enablePromptEnhancer' in data ? data.enablePromptEnhancer : undefined,
  }) as KlingVideoGenInput;
}
