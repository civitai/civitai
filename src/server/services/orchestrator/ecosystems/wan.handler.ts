/**
 * Wan Ecosystem Handler
 *
 * Handles Wan video generation workflows using videoGen step type.
 * Supports txt2vid and img2vid workflows across multiple versions (v2.1, v2.2, v2.2-5b, v2.5).
 */

import type {
  Wan21FalVideoGenInput,
  Wan22FalTextToVideoInput,
  Wan22FalImageToVideoInput,
  Wan225bFalTextToVideoInput,
  Wan225bFalImageToVideoInput,
  Wan25FalTextToVideoInput,
  Wan25FalImageToVideoInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { baseModel: string }>;

// Wan baseModel variants
type WanBaseModel =
  | 'WanVideo'
  | 'WanVideo1_3B_T2V'
  | 'WanVideo14B_T2V'
  | 'WanVideo14B_I2V_480p'
  | 'WanVideo14B_I2V_720p'
  | 'WanVideo22_TI2V_5B'
  | 'WanVideo22_I2V_A14B'
  | 'WanVideo22_T2V_A14B'
  | 'WanVideo25_T2V'
  | 'WanVideo25_I2V';

type WanCtx = EcosystemGraphOutput & { baseModel: WanBaseModel };

// Return type union
type WanInput =
  | Wan21FalVideoGenInput
  | Wan22FalTextToVideoInput
  | Wan22FalImageToVideoInput
  | Wan225bFalTextToVideoInput
  | Wan225bFalImageToVideoInput
  | Wan25FalTextToVideoInput
  | Wan25FalImageToVideoInput;

// Wan version type
type WanVersion = 'v2.1' | 'v2.2' | 'v2.2-5b' | 'v2.5';

/**
 * Creates videoGen input for Wan ecosystem.
 * Handles multiple versions with version-specific parameters.
 */
export const createWanInput = defineHandler<WanCtx, WanInput>((data, ctx) => {
  const hasImages = !!data.images?.length;
  const version: WanVersion = 'version' in data ? (data.version as WanVersion) : 'v2.1';

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

  // Common fields across all versions
  const baseInput = {
    engine: 'wan',
    version,
    provider: 'fal' as const,
    prompt: data.prompt,
    cfgScale: 'cfgScale' in data ? data.cfgScale : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    seed: data.seed,
    loras: loras.length > 0 ? loras : undefined,
  };

  // Version-specific handling
  switch (version) {
    case 'v2.1': {
      return removeEmpty({
        ...baseInput,
        aspectRatio: data.aspectRatio?.value as Wan21FalVideoGenInput['aspectRatio'],
        enablePromptExpansion: false,
        images: hasImages ? data.images?.map((x) => x.url) : undefined,
      }) as Wan21FalVideoGenInput;
    }

    case 'v2.2': {
      const operation = hasImages ? 'image-to-video' : 'text-to-video';
      const input = {
        ...baseInput,
        operation,
        negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
        resolution: 'resolution' in data ? data.resolution : undefined,
        aspectRatio: data.aspectRatio?.value as Wan22FalTextToVideoInput['aspectRatio'],
        enablePromptExpansion: false,
        shift: 'shift' in data ? data.shift : undefined,
        interpolatorModel: 'interpolatorModel' in data ? data.interpolatorModel : undefined,
        useTurbo: 'useTurbo' in data ? data.useTurbo : undefined,
      };

      if (hasImages) {
        return removeEmpty({
          ...input,
          images: data.images?.map((x) => x.url),
        }) as Wan22FalImageToVideoInput;
      }
      return removeEmpty(input) as Wan22FalTextToVideoInput;
    }

    case 'v2.2-5b': {
      const operation = hasImages ? 'image-to-video' : 'text-to-video';
      const input = {
        ...baseInput,
        operation,
        negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
        resolution: 'resolution' in data ? data.resolution : undefined,
        aspectRatio: data.aspectRatio?.value as Wan225bFalTextToVideoInput['aspectRatio'],
        enablePromptExpansion: false,
        shift: 'shift' in data ? data.shift : undefined,
        numInferenceSteps: 'steps' in data ? data.steps : undefined,
      };

      if (hasImages) {
        return removeEmpty({
          ...input,
          images: data.images?.map((x) => x.url),
        }) as Wan225bFalImageToVideoInput;
      }
      return removeEmpty(input) as Wan225bFalTextToVideoInput;
    }

    case 'v2.5': {
      const operation = hasImages ? 'image-to-video' : 'text-to-video';
      const input = {
        ...baseInput,
        operation,
        negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
        resolution: 'resolution' in data ? data.resolution : undefined,
        aspectRatio: data.aspectRatio?.value as Wan25FalTextToVideoInput['aspectRatio'],
        enablePromptExpansion: false,
      };

      if (hasImages) {
        return removeEmpty({
          ...input,
          images: data.images?.map((x) => x.url),
        }) as Wan25FalImageToVideoInput;
      }
      return removeEmpty(input) as Wan25FalTextToVideoInput;
    }

    default:
      return removeEmpty(baseInput) as WanInput;
  }
});

/**
 * Checks if a baseModel is a Wan variant.
 */
export function isWanEcosystem(baseModel: string): baseModel is WanBaseModel {
  return baseModel.startsWith('WanVideo') || baseModel === 'WanVideo';
}
