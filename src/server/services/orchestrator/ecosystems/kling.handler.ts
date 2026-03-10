/**
 * Kling Ecosystem Handler
 *
 * Handles Kling video generation workflows using videoGen step type.
 * Supports legacy (V1.6/V2/V2.5) and V3 workflows.
 *
 * Legacy versions use engine 'kling' with model version mapping.
 * V3 uses engine 'kling-v3' with operation-based inputs.
 */

import type { KlingVideoGenInput, KlingV3VideoGenInput, KlingModel } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { klingVersionIds } from '~/shared/data-graph/generation/kling-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type KlingCtx = EcosystemGraphOutput & { ecosystem: 'Kling' };

// Map from version ID to model version string (legacy versions)
const versionIdToModel = new Map<number, KlingModel>([
  [klingVersionIds.v1_6, 'v1.6'],
  [klingVersionIds.v2, 'v2'],
  [klingVersionIds.v2_5_turbo, 'v2.5-turbo'],
]);

/**
 * Creates videoGen input for Kling ecosystem.
 * Routes to legacy or V3 handler based on klingVersion discriminator.
 */
export const createKlingInput = defineHandler<KlingCtx, KlingVideoGenInput | KlingV3VideoGenInput>(
  (data, ctx) => {
    // Route V3 to its own handler
    if ('klingVersion' in data && data.klingVersion === 'v3') {
      return createV3Input(data);
    }
    return createLegacyInput(data);
  }
);

/** Legacy handler for V1.6, V2, V2.5 Turbo */
function createLegacyInput(data: KlingCtx): KlingVideoGenInput {
  const hasImages = !!data.images?.length;

  // Determine model version
  let model: KlingModel = 'v1.6';
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
    sourceImage: hasImages ? data.images?.[0]?.url : undefined,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    enablePromptEnhancer: 'enablePromptEnhancer' in data ? data.enablePromptEnhancer : undefined,
  }) as KlingVideoGenInput;
}

/** V3 handler using kling-v3 engine with operation-based inputs */
function createV3Input(data: KlingCtx): KlingV3VideoGenInput {
  const hasImages = !!data.images?.length;
  const isRef2Vid = 'operation' in data && data.operation === 'reference-to-video';

  // klingElements: split into elements[] (media segments) and multiPrompt[] (all segments).
  // Only segments with media appear in elements[]. Each such segment gets an @ElementN reference
  // prepended to its multiPrompt entry so the model knows which media to use for that segment.
  const klingElements =
    'klingElements' in data
      ? (data.klingElements as Array<{
          frontalImage?: { url: string };
          referenceImages?: Array<{ url: string }>;
          videoUrl?: { url: string } | null;
          prompt?: string;
        }>)
      : undefined;
  const hasKlingElements = !!klingElements?.length;

  let elementsArray: ReturnType<typeof removeEmpty>[] | undefined;
  let multiPromptArray: { prompt: string }[] | undefined;

  if (hasKlingElements) {
    elementsArray = [];
    multiPromptArray = [];
    let elementCounter = 0;

    for (const el of klingElements!) {
      const hasMedia = el.frontalImage || el.referenceImages?.length || el.videoUrl;

      if (hasMedia) {
        elementCounter++;
        elementsArray.push(
          removeEmpty({
            frontalImage: el.frontalImage?.url ?? null,
            referenceImages: el.referenceImages?.map((img) => img.url),
            videoUrl: el.videoUrl?.url ?? null,
          })
        );
        // Prefix prompt with @ElementN so the model references the correct media segment
        const prefix = `@Element${elementCounter}`;
        const promptText = el.prompt?.trim() ?? '';
        multiPromptArray.push({ prompt: promptText ? `${prefix} ${promptText}` : prefix });
      } else {
        // Prompt-only segment — no media reference needed
        multiPromptArray.push({ prompt: el.prompt ?? '' });
      }
    }

    if (!elementsArray.length) elementsArray = undefined;
  }

  return removeEmpty({
    engine: 'kling-v3' as const,
    // prompt is hidden (when: !multiShot) so it won't be in data when multiShot is active
    prompt: data.prompt,
    operation: 'operation' in data ? data.operation : undefined,
    mode: 'mode' in data ? data.mode : undefined,
    duration: 'duration' in data ? Number(data.duration) : undefined,
    aspectRatio: data.aspectRatio?.value as KlingV3VideoGenInput['aspectRatio'],
    // ref2vid sends images as an array; img2vid uses sourceImage/endImage slots
    sourceImage: !isRef2Vid && hasImages ? data.images?.[0]?.url : undefined,
    endImage: !isRef2Vid && hasImages && data.images?.[1]?.url ? data.images[1].url : undefined,
    images: isRef2Vid && hasImages ? data.images?.map((img) => img.url) : undefined,
    elements: elementsArray,
    multiPrompt: multiPromptArray,
    generateAudio: 'generateAudio' in data ? data.generateAudio : undefined,
    keepAudio: 'keepAudio' in data ? data.keepAudio : undefined,
    quantity: data.quantity ?? 1,
    seed: data.seed,
  }) as KlingV3VideoGenInput;
}
