/**
 * Veo3 Ecosystem Handler
 *
 * Handles Google Veo 3 video generation workflows using videoGen step type.
 * Supports txt2vid and img2vid workflows with model version selection (fast/standard).
 */

import type { Veo3VideoGenInput } from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { veo3VersionIds } from '~/shared/data-graph/generation/veo3-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type Veo3Ctx = EcosystemGraphOutput & { ecosystem: 'Veo3' };

// Map from version ID to mode (fast/standard)
type Veo3Mode = 'fast' | 'standard';
const versionIdToMode = new Map<number, Veo3Mode>([
  [veo3VersionIds.txt2vid_fast, 'fast'],
  [veo3VersionIds.txt2vid_standard, 'standard'],
  [veo3VersionIds.img2vid_fast, 'fast'],
  [veo3VersionIds.img2vid_standard, 'standard'],
]);

/**
 * Creates videoGen input for Veo3 ecosystem.
 * Supports txt2vid and img2vid with model versions, duration, audio generation, and LoRAs.
 */
export const createVeo3Input = defineHandler<Veo3Ctx, Veo3VideoGenInput>((data, ctx) => {
  const hasImages = !!data.images?.length;

  // Determine mode from model version
  let mode: Veo3Mode = 'fast';
  if (data.model) {
    const match = versionIdToMode.get(data.model.id);
    if (match) mode = match;
  }

  // Build loras from additional resources
  const loras: { air: string; strength: number }[] = [];
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras.push({
        air: ctx.airs.getOrThrow(resource.id),
        strength: resource.strength ?? 1,
      });
    }
  }

  return removeEmpty({
    engine: 'veo3',
    mode,
    prompt: data.prompt,
    negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
    aspectRatio: data.aspectRatio?.value as Veo3VideoGenInput['aspectRatio'],
    duration: 'duration' in data ? data.duration : undefined,
    version: 'version' in data ? data.version : undefined,
    generateAudio: 'generateAudio' in data ? data.generateAudio : undefined,
    images: hasImages ? data.images?.map((x) => x.url) : undefined,
    seed: data.seed,
    enablePromptEnhancer: 'enablePromptEnhancer' in data ? data.enablePromptEnhancer : undefined,
    loras: loras.length > 0 ? loras : undefined,
  }) as Veo3VideoGenInput;
});
