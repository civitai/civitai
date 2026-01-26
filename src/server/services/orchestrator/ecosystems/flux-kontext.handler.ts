/**
 * Flux Kontext Ecosystem Handler
 *
 * Handles Flux1Kontext workflows using imageGen step type.
 * Primarily an img2img model that requires a source image.
 */

import type { Flux1KontextMaxImageGenInput, Flux1KontextProImageGenInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import {
  fluxKontextVersionIds,
  type FluxKontextMode,
} from '~/shared/data-graph/generation/flux-kontext-graph';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type FluxKontextCtx = EcosystemGraphOutput & { baseModel: 'Flux1Kontext' };

// Return type union
type FluxKontextInput = Flux1KontextProImageGenInput | Flux1KontextMaxImageGenInput;

// Create reverse map from version ID to mode
const versionIdToMode = new Map<number, FluxKontextMode>(
  Object.entries(fluxKontextVersionIds).map(([mode, id]) => [id, mode as FluxKontextMode])
);

/**
 * Creates imageGen input for Flux Kontext ecosystem.
 * This is an img2img model that transforms source images based on prompts.
 */
export async function createFluxKontextInput(data: FluxKontextCtx): Promise<FluxKontextInput> {
  const quantity = data.quantity ?? 1;

  // Determine model from model version
  let model: FluxKontextMode = 'pro';
  if (data.model) {
    const match = versionIdToMode.get(data.model.id);
    if (match) model = match;
  }

  return removeEmpty({
    engine: 'flux1-kontext',
    model,
    prompt: data.prompt,
    images: data.images?.map((x) => x.url),
    aspectRatio: data.aspectRatio?.value,
    quantity,
    guidanceScale: 'cfgScale' in data ? data.cfgScale : undefined,
    seed: data.seed,
  }) as FluxKontextInput;
}
