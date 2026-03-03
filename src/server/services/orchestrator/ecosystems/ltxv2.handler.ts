/**
 * LTXV2 Ecosystem Handler
 *
 * Handles LTXV2 video generation workflows using videoGen step type.
 * Supports txt2vid/img2vid (createVideo) and ref2vid (firstLastFrameToVideo) workflows.
 */

import type {
  ComfyLtx2CreateVideoInput,
  ComfyLtx2FirstLastFrameToVideoInput,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type LTXV2Ctx = EcosystemGraphOutput & { ecosystem: 'LTXV2' };

/**
 * Creates videoGen input for LTXV2 ecosystem.
 * Routes to createVideo or firstLastFrameToVideo based on workflow.
 */
export const createLTXV2Input = defineHandler<
  LTXV2Ctx,
  ComfyLtx2CreateVideoInput | ComfyLtx2FirstLastFrameToVideoInput
>((data, ctx) => {
  if (data.workflow === 'img2vid:ref2vid') {
    return createFirstLastFrameInput(data, ctx);
  }
  return createVideoInput(data, ctx);
});

/** Builds loras record from additional resources */
function buildLoras(data: LTXV2Ctx, ctx: Parameters<Parameters<typeof defineHandler>[0]>[1]) {
  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }
  return Object.keys(loras).length > 0 ? loras : undefined;
}

/** Creates createVideo input for txt2vid/img2vid workflows */
function createVideoInput(
  data: LTXV2Ctx,
  ctx: Parameters<Parameters<typeof defineHandler>[0]>[1]
): ComfyLtx2CreateVideoInput {
  const loras = buildLoras(data, ctx);

  return removeEmpty({
    engine: 'ltx2',
    operation: 'createVideo',
    prompt: data.prompt,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    guidanceScale: 'cfgScale' in data ? data.cfgScale : undefined,
    steps: 'steps' in data ? data.steps : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    images: data.images?.map((x) => x.url),
    loras,
  }) as ComfyLtx2CreateVideoInput;
}

/** Creates firstLastFrameToVideo input for ref2vid workflow */
function createFirstLastFrameInput(
  data: LTXV2Ctx,
  ctx: Parameters<Parameters<typeof defineHandler>[0]>[1]
): ComfyLtx2FirstLastFrameToVideoInput {
  const loras = buildLoras(data, ctx);
  const images = data.images;

  return removeEmpty({
    engine: 'ltx2',
    operation: 'firstLastFrameToVideo',
    prompt: data.prompt,
    width: data.aspectRatio?.width,
    height: data.aspectRatio?.height,
    guidanceScale: 'cfgScale' in data ? data.cfgScale : undefined,
    steps: 'steps' in data ? data.steps : undefined,
    duration: 'duration' in data ? data.duration : undefined,
    firstFrame: images?.[0]?.url,
    lastFrame: images && images.length > 1 ? images[1]?.url : undefined,
    frameGuideStrength:
      'frameGuideStrength' in data ? (data.frameGuideStrength as number) : undefined,
    quantity: data.quantity ?? 1,
    seed: data.seed,
    loras,
  }) as ComfyLtx2FirstLastFrameToVideoInput;
}
