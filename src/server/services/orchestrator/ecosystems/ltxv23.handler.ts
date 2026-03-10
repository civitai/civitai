/**
 * LTXV23 Ecosystem Handler
 *
 * Handles LTXV23 video generation workflows using videoGen step type.
 * Supports:
 * - txt2vid → createVideo (ComfyLtx23CreateVideoInput)
 * - img2vid → firstLastFrameToVideo (ComfyLtx23FirstLastFrameToVideoInput)
 * - vid2vid:edit → editVideo (ComfyLtx23EditVideoInput)
 * - vid2vid:extend → extendVideo (ComfyLtx23ExtendVideoInput)
 */

import type {
  ComfyLtx23CreateVideoInput,
  ComfyLtx23EditVideoInput,
  ComfyLtx23ExtendVideoInput,
  ComfyLtx23FirstLastFrameToVideoInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { ltxv23AspectRatiosByResolution } from '~/shared/data-graph/generation/ltxv23-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type LTXV23Ctx = EcosystemGraphOutput & { ecosystem: 'LTXV23' };

type LTXV23Output =
  | ComfyLtx23CreateVideoInput
  | ComfyLtx23FirstLastFrameToVideoInput
  | ComfyLtx23EditVideoInput
  | ComfyLtx23ExtendVideoInput;

/**
 * Creates videoGen input for LTXV23 ecosystem.
 * Routes to the appropriate operation based on workflow.
 */
export const createLTXV23Input = defineHandler<LTXV23Ctx, LTXV23Output>((data, ctx) => {
  switch (data.workflow) {
    case 'img2vid':
      return createFirstLastFrameInput(data, ctx);
    case 'img2vid:ref2vid':
      return createVideoInput(data, ctx);
    case 'vid2vid:edit':
      return createEditVideoInput(data, ctx);
    case 'vid2vid:extend':
      return createExtendVideoInput(data, ctx);
    default:
      return createVideoInput(data, ctx);
  }
});

/** Builds loras record from additional resources */
function buildLoras(data: LTXV23Ctx, ctx: Parameters<Parameters<typeof defineHandler>[0]>[1]) {
  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }
  return Object.keys(loras).length > 0 ? loras : undefined;
}

/** Resolves width/height from the first image by finding the closest supported aspect ratio */
function resolveImageDimensions(data: LTXV23Ctx) {
  const resolution = 'resolution' in data ? (data.resolution as string) : '720p';
  const aspectRatios =
    ltxv23AspectRatiosByResolution[resolution] ?? ltxv23AspectRatiosByResolution['720p'];
  const firstImage = data.images?.[0];
  if (firstImage?.width && firstImage?.height) {
    const match = findClosestAspectRatio(firstImage, aspectRatios);
    if (match) return { width: match.width, height: match.height };
  }
  // Fallback to aspectRatio node if set, or default
  return {
    width: data.aspectRatio?.width ?? aspectRatios[0].width,
    height: data.aspectRatio?.height ?? aspectRatios[0].height,
  };
}

/** LTXV23 distilled model version ID */
const LTXV23_DISTILLED_ID = 2749948;

/** Gets the model string from the version ID */
function getModel(data: LTXV23Ctx): ComfyLtx23CreateVideoInput['model'] {
  const modelId = data.model?.id;
  if (modelId === LTXV23_DISTILLED_ID) return '22b-distilled';
  // Default to dev
  return '22b-dev';
}

/** Check if the model is distilled */
function isDistilled(data: LTXV23Ctx) {
  return data.model?.id === LTXV23_DISTILLED_ID;
}

/** Creates createVideo input for txt2vid and img2vid:ref2vid workflows */
function createVideoInput(
  data: LTXV23Ctx,
  ctx: Parameters<Parameters<typeof defineHandler>[0]>[1]
): ComfyLtx23CreateVideoInput {
  const loras = buildLoras(data, ctx);
  const distilled = isDistilled(data);

  return removeEmpty({
    engine: 'ltx2.3',
    operation: 'createVideo',
    prompt: data.prompt,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    model: getModel(data),
    guidanceScale: distilled ? 1 : 'cfgScale' in data ? data.cfgScale : undefined,
    steps: distilled ? 8 : 'steps' in data ? data.steps : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    seed: data.seed,
    images: data.images?.map((x) => x.url),
    generateAudio: 'generateAudio' in data ? data.generateAudio : undefined,
    loras,
  }) as ComfyLtx23CreateVideoInput;
}

/** Creates firstLastFrameToVideo input for img2vid workflow */
function createFirstLastFrameInput(
  data: LTXV23Ctx,
  ctx: Parameters<Parameters<typeof defineHandler>[0]>[1]
): ComfyLtx23FirstLastFrameToVideoInput {
  const loras = buildLoras(data, ctx);
  const images = data.images;
  const { width, height } = resolveImageDimensions(data);
  const distilled = isDistilled(data);

  return removeEmpty({
    engine: 'ltx2.3',
    operation: 'firstLastFrameToVideo',
    prompt: data.prompt,
    width,
    height,
    model: getModel(data),
    guidanceScale: distilled ? 1 : 'cfgScale' in data ? data.cfgScale : undefined,
    steps: distilled ? 8 : 'steps' in data ? data.steps : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    firstFrame: images?.[0]?.url,
    lastFrame: images && images.length > 1 ? images[1]?.url : undefined,
    frameGuideStrength:
      'frameGuideStrength' in data ? (data.frameGuideStrength as number) : undefined,
    seed: data.seed,
    generateAudio: 'generateAudio' in data ? data.generateAudio : undefined,
    loras,
  }) as ComfyLtx23FirstLastFrameToVideoInput;
}

/** Creates editVideo input for vid2vid:edit workflow */
function createEditVideoInput(
  data: LTXV23Ctx,
  ctx: Parameters<Parameters<typeof defineHandler>[0]>[1]
): ComfyLtx23EditVideoInput {
  const loras = buildLoras(data, ctx);
  const distilled = isDistilled(data);

  return removeEmpty({
    engine: 'ltx2.3',
    operation: 'editVideo',
    prompt: data.prompt,
    width: data.video?.metadata?.width,
    height: data.video?.metadata?.height,
    model: getModel(data),
    guidanceScale: distilled ? 1 : 'cfgScale' in data ? data.cfgScale : undefined,
    steps: distilled ? 8 : 'steps' in data ? data.steps : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    sourceVideo: data.video?.url,
    cannyLowThreshold: 'cannyLowThreshold' in data ? (data.cannyLowThreshold as number) : undefined,
    cannyHighThreshold:
      'cannyHighThreshold' in data ? (data.cannyHighThreshold as number) : undefined,
    guideStrength: 'guideStrength' in data ? (data.guideStrength as number) : undefined,
    seed: data.seed,
    generateAudio: 'generateAudio' in data ? data.generateAudio : undefined,
    loras,
  }) as ComfyLtx23EditVideoInput;
}

/** Creates extendVideo input for vid2vid:extend workflow */
function createExtendVideoInput(
  data: LTXV23Ctx,
  ctx: Parameters<Parameters<typeof defineHandler>[0]>[1]
): ComfyLtx23ExtendVideoInput {
  const loras = buildLoras(data, ctx);
  const distilled = isDistilled(data);

  return removeEmpty({
    engine: 'ltx2.3',
    operation: 'extendVideo',
    prompt: data.prompt,
    width: data.video?.metadata?.width,
    height: data.video?.metadata?.height,
    model: getModel(data),
    guidanceScale: distilled ? 1 : 'cfgScale' in data ? data.cfgScale : undefined,
    steps: distilled ? 8 : 'steps' in data ? data.steps : undefined,
    sourceVideo: data.video?.url,
    numFrames: 'numFrames' in data ? (data.numFrames as number) : undefined,
    seed: data.seed,
    generateAudio: 'generateAudio' in data ? data.generateAudio : undefined,
    loras,
  }) as ComfyLtx23ExtendVideoInput;
}
