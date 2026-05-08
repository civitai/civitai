/**
 * LTX Ecosystem Handler (LTXV2 + LTXV23)
 *
 * Consolidated handler for LTX Video 2 and LTX Video 2.3 ecosystems.
 * Routes by `data.ecosystem` and `data.workflow`:
 * - LTXV2 / txt2vid → ltx2 createVideo
 * - LTXV2 / img2vid → ltx2 firstLastFrameToVideo
 * - LTXV23 / txt2vid (and ref2vid) → ltx2.3 createVideo
 * - LTXV23 / img2vid → ltx2.3 firstLastFrameToVideo
 * - LTXV23 / vid2vid:edit → ltx2.3 editVideo
 * - LTXV23 / vid2vid:extend → ltx2.3 extendVideo
 */

import type {
  ComfyLtx23CreateVideoInput,
  ComfyLtx23EditVideoInput,
  ComfyLtx23ExtendVideoInput,
  ComfyLtx23FirstLastFrameToVideoInput,
  ComfyLtx2CreateVideoInput,
  ComfyLtx2FirstLastFrameToVideoInput,
  VideoGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { AspectRatioOption, ResourceData } from '~/shared/data-graph/generation/common';
import {
  ltxv2AspectRatios,
  ltxv23AspectRatiosByResolution,
  LTXV2_DISTILLED_ID,
  LTXV23_DISTILLED_ID,
} from '~/shared/data-graph/generation/ltx-graph';
import { defineHandler } from './handler-factory';
import type { StepInput } from '.';
import { createChainedPromptEnhancementStep } from '~/server/services/orchestrator/promptEnhancement';

// Types derived from generation graph.
// Use Extract (a distributive conditional) rather than `& { ecosystem: ... }`
// so that `data.ecosystem === 'LTXV23'` narrows cleanly to the LTXV23 branch
// (including v23-only fields like `video`, `cannyLowThreshold`, etc.).
type LTXCtx = Extract<GenerationGraphTypes['Ctx'], { ecosystem: 'LTXV2' | 'LTXV23' }>;

type HandlerExtCtx = Parameters<Parameters<typeof defineHandler>[0]>[1];

/** Builds loras record from additional resources */
function buildLoras(data: LTXCtx, ctx: HandlerExtCtx) {
  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }
  return Object.keys(loras).length > 0 ? loras : undefined;
}

/**
 * Resolves width/height from the first uploaded image by snapping to the
 * nearest supported aspect ratio. Falls back to the selected aspectRatio
 * node, then to the first entry in the list.
 */
function resolveImageDimensions(
  firstImage: { width?: number; height?: number } | undefined,
  aspectRatios: AspectRatioOption[],
  fallbackAspectRatio?: { width: number; height: number }
) {
  if (firstImage?.width && firstImage?.height) {
    const match = findClosestAspectRatio(
      { width: firstImage.width, height: firstImage.height },
      aspectRatios
    );
    if (match) return { width: match.width, height: match.height };
  }
  return {
    width: fallbackAspectRatio?.width ?? aspectRatios[0].width,
    height: fallbackAspectRatio?.height ?? aspectRatios[0].height,
  };
}

/**
 * Creates videoGen input for LTX (v2 and v2.3) ecosystems.
 * When `enablePromptEnhancer` is on, prepends a promptEnhancement step and
 * wires its `output.enhancedPrompt` into the videoGen step's `prompt` via $ref.
 * Reference images (img2vid / ref2vid) are passed to the enhancer so the
 * vision-capable LLM can ground the rewrite in the input frames.
 */
export const createLTXInput = defineHandler<LTXCtx, StepInput[]>((data, ctx) => {
  const loras = buildLoras(data, ctx);

  const steps: StepInput[] = [];
  let prompt: string = data.prompt;
  if (data.enablePromptEnhancer) {
    // Pull image URLs off `data.images` when present (img2vid + ref2vid carry
    // them; vid2vid uses `data.video` and has no images).
    const enhancerImages =
      'images' in data
        ? data.images?.map((img) => img.url).filter((u): u is string => !!u)
        : undefined;

    const { step, prompt: promptRef } = createChainedPromptEnhancementStep(
      {
        ecosystem: data.ecosystem.toLowerCase(),
        prompt: data.prompt,
        preserveTriggerWords: data.triggerWords,
        images: enhancerImages?.length ? enhancerImages : undefined,
      },
      { stepIndex: steps.length, suppressOutput: true }
    );
    steps.push(step);
    prompt = promptRef;
  }

  if (data.ltxVersion === 'v23') {
    const distilled = data.model?.id === LTXV23_DISTILLED_ID;
    const model = distilled ? '22b-distilled' : '22b-dev';
    const resolution = data.resolution ?? '720p';
    const aspectRatios =
      ltxv23AspectRatiosByResolution[resolution] ?? ltxv23AspectRatiosByResolution['720p'];
    const guidanceScale = distilled ? 1 : data.cfgScale;
    const stepCount = distilled ? 8 : data.steps;

    let videoStep: VideoGenStepTemplate;
    switch (data.workflow) {
      case 'img2vid': {
        const images = data.images;
        const { width, height } = resolveImageDimensions(
          images?.[0],
          aspectRatios,
          data.aspectRatio
        );
        videoStep = {
          $type: 'videoGen',
          input: removeEmpty({
            engine: 'ltx2.3',
            operation: 'firstLastFrameToVideo',
            prompt,
            width,
            height,
            model,
            guidanceScale,
            steps: stepCount,
            duration: data.duration,
            firstFrame: images?.[0]?.url,
            lastFrame: images && images.length > 1 ? images[1]?.url : undefined,
            frameGuideStrength: data.frameGuideStrength,
            seed: data.seed,
            generateAudio: data.generateAudio,
            loras,
          }) as ComfyLtx23FirstLastFrameToVideoInput,
        };
        break;
      }

      case 'vid2vid:edit': {
        videoStep = {
          $type: 'videoGen',
          input: removeEmpty({
            engine: 'ltx2.3',
            operation: 'editVideo',
            prompt,
            width: 'video' in data ? data.video?.metadata?.width : undefined,
            height: 'video' in data ? data.video?.metadata?.height : undefined,
            model,
            guidanceScale,
            steps: stepCount,
            duration: data.duration,
            sourceVideo: 'video' in data ? data.video?.url : undefined,
            cannyLowThreshold: data.cannyLowThreshold,
            cannyHighThreshold: data.cannyHighThreshold,
            guideStrength: data.guideStrength,
            seed: data.seed,
            generateAudio: data.generateAudio,
            loras,
          }) as ComfyLtx23EditVideoInput,
        };
        break;
      }

      case 'vid2vid:extend': {
        videoStep = {
          $type: 'videoGen',
          input: removeEmpty({
            engine: 'ltx2.3',
            operation: 'extendVideo',
            prompt,
            width: data.video?.metadata?.width,
            height: data.video?.metadata?.height,
            model,
            guidanceScale,
            steps: stepCount,
            sourceVideo: data.video?.url,
            numFrames: data.numFrames,
            seed: data.seed,
            generateAudio: data.generateAudio,
            loras,
          }) as ComfyLtx23ExtendVideoInput,
        };
        break;
      }

      // txt2vid and img2vid:ref2vid both use createVideo
      default: {
        videoStep = {
          $type: 'videoGen',
          input: removeEmpty({
            engine: 'ltx2.3',
            operation: 'createVideo',
            prompt,
            width: data.aspectRatio?.width,
            height: data.aspectRatio?.height,
            model,
            guidanceScale,
            steps: stepCount,
            duration: data.duration,
            seed: data.seed,
            images: data.images?.map((x) => x.url),
            generateAudio: data.generateAudio,
            loras,
          }) as ComfyLtx23CreateVideoInput,
        };
      }
    }

    steps.push(videoStep);
    return steps;
  }

  // LTXV2
  const distilled = data.model?.id === LTXV2_DISTILLED_ID;
  const guidanceScale = distilled ? 1 : data.cfgScale;
  const stepCount = distilled ? 8 : data.steps;

  let videoStep: VideoGenStepTemplate;
  if (data.workflow === 'img2vid') {
    const images = data.images;
    const { width, height } = resolveImageDimensions(
      images?.[0],
      ltxv2AspectRatios,
      data.aspectRatio
    );
    videoStep = {
      $type: 'videoGen',
      input: removeEmpty({
        engine: 'ltx2',
        operation: 'firstLastFrameToVideo',
        prompt,
        width,
        height,
        guidanceScale,
        steps: stepCount,
        duration: data.duration,
        firstFrame: images?.[0]?.url,
        lastFrame: images && images.length > 1 ? images[1]?.url : undefined,
        frameGuideStrength: data.frameGuideStrength,
        quantity: data.quantity ?? 1,
        seed: data.seed,
        loras,
      }) as ComfyLtx2FirstLastFrameToVideoInput,
    };
  } else {
    videoStep = {
      $type: 'videoGen',
      input: removeEmpty({
        engine: 'ltx2',
        operation: 'createVideo',
        prompt,
        width: data.aspectRatio?.width,
        height: data.aspectRatio?.height,
        guidanceScale,
        steps: stepCount,
        duration: data.duration,
        quantity: data.quantity ?? 1,
        seed: data.seed,
        images: data.images?.map((x) => x.url),
        loras,
      }) as ComfyLtx2CreateVideoInput,
    };
  }

  steps.push(videoStep);
  return steps;
});
