/**
 * NanoBanana Ecosystem Handler
 *
 * Handles NanoBanana workflows using imageGen step type.
 * NanoBanana uses the gemini engine with two model variants:
 * - Standard (2.5-flash)
 * - Pro (nano-banana-pro)
 */

import type {
  Gemini25FlashCreateImageGenInput,
  Gemini25FlashEditImageGenInput,
  NanoBananaProImageGenInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { nanoBananaVersionIds, type NanoBananaMode } from '~/shared/data-graph/generation/nano-banana-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;
type NanoBananaCtx = EcosystemGraphOutput & { baseModel: 'NanoBanana' };

// Return type union
type NanoBananaInput =
  | Gemini25FlashCreateImageGenInput
  | Gemini25FlashEditImageGenInput
  | NanoBananaProImageGenInput;

// Create reverse map from version ID to mode
const versionIdToMode = new Map<number, NanoBananaMode>(
  Object.entries(nanoBananaVersionIds).map(([mode, id]) => [id, mode as NanoBananaMode])
);

/**
 * Creates imageGen input for NanoBanana ecosystem.
 * Handles both standard (2.5-flash) and pro (nano-banana-pro) models.
 */
export const createNanoBananaInput = defineHandler<NanoBananaCtx, NanoBananaInput>((data, ctx) => {
  // Determine which model variant to use
  let model: NanoBananaMode = 'standard';
  if (data.model) {
    const match = versionIdToMode.get(data.model.id);
    if (match) model = match;
  }

  const quantity = data.quantity ?? 1;

  // aspectRatio only exists in "pro" mode
  const aspectRatio = 'aspectRatio' in data ? data.aspectRatio : undefined;

  if (model === 'standard') {
    // Standard model (2.5-flash)
    const hasImages = !!data.images?.length;
    if (hasImages) {
      return removeEmpty({
        engine: 'gemini',
        model: '2.5-flash',
        operation: 'editImage',
        prompt: data.prompt,
        quantity,
        images: data.images?.map((x) => x.url) ?? [],
        seed: data.seed,
      }) as Gemini25FlashEditImageGenInput;
    } else {
      return removeEmpty({
        engine: 'gemini',
        model: '2.5-flash',
        operation: 'createImage',
        prompt: data.prompt,
        quantity,
        seed: data.seed,
      }) as Gemini25FlashCreateImageGenInput;
    }
  } else {
    // Pro model (nano-banana-pro)
    return removeEmpty({
      engine: 'google',
      model: 'nano-banana-pro',
      prompt: data.prompt,
      negativePrompt: undefined,
      width: aspectRatio?.width,
      height: aspectRatio?.height,
      aspectRatio: aspectRatio?.value,
      resolution: 'resolution' in data ? data.resolution : undefined,
      outputFormat: 'outputFormat' in data ? data.outputFormat : undefined,
      images: data.images?.map((x) => x.url),
      numImages: quantity,
      seed: data.seed,
    }) as NanoBananaProImageGenInput;
  }
});
