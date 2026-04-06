/**
 * Wan Ecosystem Handler
 *
 * Handles Wan generation workflows.
 * Video: txt2vid and img2vid across multiple versions (v2.1, v2.2, v2.2-5b, v2.5).
 * Image: txt2img and img2img:edit for v2.7 via fal provider.
 */

import type {
  Wan21CivitaiVideoGenInput,
  Wan22ComfyVideoGenInput,
  Wan22FalTextToVideoInput,
  Wan22FalImageToVideoInput,
  Wan225bFalTextToVideoInput,
  Wan225bFalImageToVideoInput,
  Wan25FalTextToVideoInput,
  Wan25FalImageToVideoInput,
  Wan27FalTextToImageInput,
  Wan27FalImageEditInput,
  Wan27FalTextToVideoInput,
  Wan27FalImageToVideoInput,
  Wan27FalReferenceToVideoInput,
  Wan27FalEditVideoInput,
  VideoGenStepTemplate,
  VideoInterpolationStepTemplate,
  ImageGenStepTemplate,
} from '@civitai/client';

import { removeEmpty } from '~/utils/object-helpers';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { ecosystemToVersionDef } from '~/shared/data-graph/generation/wan-graph';
import { ecosystemToImageVersionDef } from '~/shared/data-graph/generation/wan-image-graph';
import { defineHandler } from './handler-factory';
import { isFlipt, FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;

// Wan baseModel variants
type WanBaseModel =
  | 'WanVideo'
  | 'WanVideo1_3B_T2V'
  | 'WanVideo14B_T2V'
  | 'WanVideo14B_I2V_480p'
  | 'WanVideo14B_I2V_720p'
  | 'WanVideo-22-TI2V-5B'
  | 'WanVideo-22-I2V-A14B'
  | 'WanVideo-22-T2V-A14B'
  | 'WanVideo-25-T2V'
  | 'WanVideo-25-I2V'
  | 'WanImage27'
  | 'WanVideo27';

type WanCtx = EcosystemGraphOutput & { ecosystem: WanBaseModel };

type WanSteps =
  | [VideoGenStepTemplate]
  | [VideoGenStepTemplate & { metadata: { suppressOutput: true } }, VideoInterpolationStepTemplate]
  | [ImageGenStepTemplate];

// Wan version type
type WanVersion = 'v2.1' | 'v2.2' | 'v2.2-5b' | 'v2.5' | 'v2.7';

// Supported aspect ratios per version (from @civitai/client types)
const v21AspectRatiosByResolution: Record<
  string,
  { value: string; width: number; height: number }[]
> = {
  '480p': [
    { value: '16:9', width: 848, height: 480 },
    { value: '3:2', width: 720, height: 480 },
    { value: '1:1', width: 480, height: 480 },
    { value: '2:3', width: 480, height: 720 },
    { value: '9:16', width: 480, height: 848 },
  ],
  '720p': [
    { value: '16:9', width: 1280, height: 720 },
    { value: '3:2', width: 1080, height: 720 },
    { value: '1:1', width: 720, height: 720 },
    { value: '2:3', width: 720, height: 1080 },
    { value: '9:16', width: 720, height: 1280 },
  ],
};
// Explicit pixel dimensions for v2.2 comfy (resolution + aspect ratio → width/height)
const v22DimensionsByResolutionAndRatio: Record<
  string,
  Record<string, { width: number; height: number }>
> = {
  '480p': {
    '1:1': { width: 480, height: 480 },
    '16:9': { width: 848, height: 480 },
    '9:16': { width: 480, height: 848 },
    '4:3': { width: 640, height: 480 },
    '3:4': { width: 480, height: 640 },
    '4:5': { width: 384, height: 480 },
    '5:4': { width: 608, height: 480 },
  },
  '720p': {
    '1:1': { width: 720, height: 720 },
    '16:9': { width: 1280, height: 720 },
    '9:16': { width: 720, height: 1280 },
    '4:3': { width: 960, height: 720 },
    '3:4': { width: 720, height: 960 },
    '4:5': { width: 576, height: 720 },
    '5:4': { width: 912, height: 720 },
  },
};
const v22AspectRatioEntries = (resolution: string) =>
  Object.entries(
    v22DimensionsByResolutionAndRatio[resolution] ?? v22DimensionsByResolutionAndRatio['480p']
  ).map(([value, dims]) => ({ value, ...dims }));
const v225bAspectRatios = ['1:1', '16:9', '9:16'] as const;
const v25AspectRatios = ['16:9', '9:16', '1:1'] as const;

/** Derive aspect ratio from source image dimensions for img2vid */
function getImageAspectRatio<T extends `${number}:${number}`>(
  images: { width: number; height: number }[] | undefined,
  supportedRatios: readonly T[]
): T | undefined {
  const img = images?.[0];
  if (!img?.width || !img?.height) return undefined;
  return findClosestAspectRatio({ width: img.width, height: img.height }, [...supportedRatios]);
}

/** Wan 2.7 supported aspect ratios for video (used for img2vid aspect ratio derivation) */
const wan27VideoAspectRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'] as const;

/**
 * Creates step(s) for Wan ecosystem.
 * Returns a single videoGen step for most versions, or [videoGen, videoInterpolation] for v2.2.
 * v2.7 returns an imageGen step for image generation workflows.
 * v2.2 uses the comfy provider with a hidden 12fps generation followed by frame interpolation.
 */
export const createWanSteps = defineHandler<WanCtx, WanSteps>(async (data, ctx) => {
  const hasImages = !!data.images?.length;
  // Derive version from ecosystem key (source of truth) with wanVersion as fallback
  // Check both video and image version defs
  const version: WanVersion =
    ecosystemToVersionDef.get(data.ecosystem)?.version ??
    ecosystemToImageVersionDef.get(data.ecosystem)?.version ??
    ('wanVersion' in data ? (data.wanVersion as WanVersion) : 'v2.1');

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
    prompt: data.prompt,
    cfgScale: 'cfgScale' in data ? data.cfgScale : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    loras: loras.length > 0 ? loras : undefined,
    frameRate: 24,
  };

  // Version-specific handling
  switch (version) {
    case 'v2.1': {
      const resolution = 'resolution' in data ? (data.resolution as string) : '480p';
      const ratioEntries =
        v21AspectRatiosByResolution[resolution] ?? v21AspectRatiosByResolution['480p'];
      const dims = hasImages
        ? findClosestAspectRatio(data.images![0], ratioEntries)
        : data.aspectRatio;
      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...baseInput,
            provider: 'civitai' as const,
            width: dims?.width,
            height: dims?.height,
            images: hasImages ? data.images?.map((x) => x.url) : undefined,
          }) as Wan21CivitaiVideoGenInput,
        },
      ];
    }

    case 'v2.2': {
      // Use multi-step if the user toggled it on AND the flipt kill-switch allows it
      const useMultiStep =
        'multiStep' in data &&
        data.multiStep === true &&
        (await isFlipt(FLIPT_FEATURE_FLAGS.WAN22_MULTI_STEP));

      if (useMultiStep) {
        // Multi-step comfy workflow: 12fps videoGen + VFIMamba fr
        // ame interpolation
        const resolution = 'resolution' in data ? (data.resolution as string) : '480p';
        const ratioEntries = v22AspectRatioEntries(resolution);
        const dims = hasImages
          ? findClosestAspectRatio(data.images![0], ratioEntries)
          : ratioEntries.find((e) => e.value === data.aspectRatio?.value) ?? ratioEntries[0];
        const videoGenStep: VideoGenStepTemplate & { metadata: { suppressOutput: true } } = {
          $type: 'videoGen',
          input: removeEmpty({
            ...baseInput,
            provider: 'comfy' as const,
            frameRate: 12,
            width: dims?.width,
            height: dims?.height,
            duration: 'duration' in data ? data.duration : 5,
            steps: 'steps' in data ? data.steps : 20,
            negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
            shift: 'shift' in data ? data.shift : undefined,
            images: hasImages ? data.images?.map((x) => x.url) : undefined,
          }) as Wan22ComfyVideoGenInput,
          metadata: { suppressOutput: true },
        };
        const videoInterpolationStep: VideoInterpolationStepTemplate = {
          $type: 'videoInterpolation',
          input: {
            video: { $ref: '$0', path: 'output.video.url' } as unknown as string,
            interpolationFactor: 2,
            model: 'VFIMamba',
          },
        };
        return [videoGenStep, videoInterpolationStep];
      }

      // Legacy single-step fal workflow
      const operation = hasImages ? 'image-to-video' : 'text-to-video';
      const input = {
        ...baseInput,
        provider: 'fal' as const,
        operation,
        negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
        resolution: 'resolution' in data ? data.resolution : undefined,
        aspectRatio: (hasImages
          ? getImageAspectRatio(data.images, v225bAspectRatios)
          : data.aspectRatio?.value) as Wan22FalTextToVideoInput['aspectRatio'],
        enablePromptExpansion: false,
        shift: 'shift' in data ? data.shift : undefined,
        interpolatorModel: 'interpolatorModel' in data ? data.interpolatorModel : undefined,
        useTurbo: 'draft' in data ? data.draft : undefined,
      };

      if (hasImages) {
        return [
          {
            $type: 'videoGen',
            input: removeEmpty({
              ...input,
              images: data.images?.map((x) => x.url),
            }) as Wan22FalImageToVideoInput,
          },
        ];
      }
      return [
        {
          $type: 'videoGen',
          input: removeEmpty(input) as Wan22FalTextToVideoInput,
        },
      ];
    }

    case 'v2.2-5b': {
      const operation = hasImages ? 'image-to-video' : 'text-to-video';
      const input = {
        ...baseInput,
        provider: 'fal' as const,
        operation,
        negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
        resolution: 'resolution' in data ? data.resolution : undefined,
        aspectRatio: (hasImages
          ? getImageAspectRatio(data.images, v225bAspectRatios)
          : data.aspectRatio?.value) as Wan225bFalTextToVideoInput['aspectRatio'],
        enablePromptExpansion: false,
        shift: 'shift' in data ? data.shift : undefined,
        numInferenceSteps: 'steps' in data ? data.steps : undefined,
        interpolatorModel: 'interpolatorModel' in data ? data.interpolatorModel : undefined,
      };
      return [
        {
          $type: 'videoGen',
          input: removeEmpty(
            hasImages ? { ...input, images: data.images?.map((x) => x.url) } : input
          ) as Wan225bFalTextToVideoInput | Wan225bFalImageToVideoInput,
        },
      ];
    }

    case 'v2.5': {
      const operation = hasImages ? 'image-to-video' : 'text-to-video';
      const input = {
        ...baseInput,
        provider: 'fal' as const,
        operation,
        negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
        resolution: 'resolution' in data ? data.resolution : undefined,
        aspectRatio: (hasImages
          ? getImageAspectRatio(data.images, v25AspectRatios)
          : data.aspectRatio?.value) as Wan25FalTextToVideoInput['aspectRatio'],
        enablePromptExpansion: false,
      };
      return [
        {
          $type: 'videoGen',
          input: removeEmpty(
            hasImages ? { ...input, images: data.images?.map((x) => x.url) } : input
          ) as Wan25FalTextToVideoInput | Wan25FalImageToVideoInput,
        },
      ];
    }

    // v2.7: Image generation (WanImage27) or Video generation (WanVideo27)
    // Per fal spec: cfgScale, steps, frameRate, loras are NOT supported for v2.7
    case 'v2.7': {
      const isVideo = data.ecosystem === 'WanVideo27';

      if (isVideo) {
        // Shared video fields (per Wan27FalVideoGenInput base)
        const v27Base = {
          engine: 'wan' as const,
          version: 'v2.7' as const,
          provider: 'fal' as const,
          seed: data.seed,
          resolution: 'resolution' in data ? data.resolution : undefined,
        };
        const negativePrompt = 'negativePrompt' in data ? data.negativePrompt : undefined;
        const duration = 'duration' in data ? data.duration : undefined;
        const aspectRatio = data.aspectRatio?.value as
          | Wan27FalTextToVideoInput['aspectRatio']
          | undefined;

        // vid2vid:edit → edit-video
        if (data.workflow === 'vid2vid:edit') {
          const video = 'video' in data ? (data.video as { url: string } | undefined) : undefined;
          return [
            {
              $type: 'videoGen',
              input: removeEmpty({
                ...v27Base,
                operation: 'edit-video',
                prompt: data.prompt,
                videoUrl: video?.url,
                aspectRatio,
                duration,
                audioSetting: 'auto',
              }) as Wan27FalEditVideoInput,
            },
          ];
        }

        // img2vid:ref2vid → reference-to-video
        if (data.workflow === 'img2vid:ref2vid') {
          return [
            {
              $type: 'videoGen',
              input: removeEmpty({
                ...v27Base,
                operation: 'reference-to-video',
                prompt: data.prompt,
                referenceImages: hasImages ? data.images!.map((x) => x.url) : undefined,
                aspectRatio,
                duration,
                negativePrompt,
              }) as Wan27FalReferenceToVideoInput,
            },
          ];
        }

        // img2vid → image-to-video (first slot = startImage, second slot = endImage)
        if (hasImages) {
          const startImage = data.images![0]?.url;
          const endImage = data.images![1]?.url;
          return [
            {
              $type: 'videoGen',
              input: removeEmpty({
                ...v27Base,
                operation: 'image-to-video',
                prompt: data.prompt || undefined,
                startImage,
                endImage,
                duration,
                negativePrompt,
                enablePromptExpansion:
                  'enablePromptEnhancer' in data ? data.enablePromptEnhancer : undefined,
              }) as Wan27FalImageToVideoInput,
            },
          ];
        }

        // txt2vid → text-to-video
        return [
          {
            $type: 'videoGen',
            input: removeEmpty({
              ...v27Base,
              operation: 'text-to-video',
              prompt: data.prompt,
              aspectRatio,
              duration,
              negativePrompt,
              enablePromptExpansion:
                'enablePromptEnhancer' in data ? data.enablePromptEnhancer : undefined,
            }) as Wan27FalTextToVideoInput,
          },
        ];
      }

      // Image generation (createImage / editImage)
      return [
        {
          $type: 'imageGen',
          input: removeEmpty({
            engine: 'wan' as const,
            version: 'v2.7' as const,
            provider: 'fal' as const,
            prompt: data.prompt,
            negativePrompt: 'negativePrompt' in data ? data.negativePrompt : undefined,
            guidanceScale: 'cfgScale' in data ? data.cfgScale : undefined,
            seed: data.seed,
            quantity: data.quantity ?? 1,
            aspectRatio: data.aspectRatio?.value,
            enablePromptExpansion:
              'enablePromptEnhancer' in data ? data.enablePromptEnhancer : undefined,
            ...(hasImages
              ? { operation: 'editImage', images: data.images!.map((x) => x.url) }
              : { operation: 'createImage' }),
          }) as Wan27FalTextToImageInput | Wan27FalImageEditInput,
        },
      ];
    }

    default:
      return [
        {
          $type: 'videoGen',
          input: removeEmpty({
            ...baseInput,
            provider: 'civitai' as const,
          }) as Wan21CivitaiVideoGenInput,
        },
      ];
  }
});

/**
 * Checks if an ecosystem is a Wan variant.
 */
export function isWanEcosystem(ecosystem: string): ecosystem is WanBaseModel {
  return (
    ecosystem.startsWith('WanVideo') || ecosystem.startsWith('WanImage') || ecosystem === 'WanVideo'
  );
}
