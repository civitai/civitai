/**
 * Imagen4 Ecosystem Handler
 *
 * Handles Imagen4 workflows using imageGen step type.
 * Uses Google's Imagen4 model for text-to-image generation.
 */

import type { Imagen4ImageGenInput } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type Imagen4Ctx = EcosystemGraphOutput & { baseModel: 'Imagen4' };

// Supported aspect ratios for Imagen4
type Imagen4AspectRatio = '16:9' | '4:3' | '1:1' | '3:4' | '9:16';

/**
 * Creates imageGen input for Imagen4 ecosystem.
 * Imagen4 only supports text-to-image generation.
 */
export async function createImagen4Input(data: Imagen4Ctx): Promise<Imagen4ImageGenInput> {
  const seed = data.seed ?? Math.floor(Math.random() * maxRandomSeed);
  const quantity = data.quantity ?? 1;

  return removeEmpty({
    engine: 'google',
    model: 'imagen4',
    prompt: data.prompt,
    negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
    aspectRatio: data.aspectRatio?.value as Imagen4AspectRatio | undefined,
    numImages: quantity,
    seed,
  }) as Imagen4ImageGenInput;
}
