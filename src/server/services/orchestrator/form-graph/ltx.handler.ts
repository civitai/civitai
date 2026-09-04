/**
 * LTX handler for the form-graph lane (LTXV2 + LTXV23 + LTXV25). Converts
 * `generationHub.parse().data` into @civitai/client steps — same routing as
 * the data-graph handler it mirrors:
 * - LTXV2 / txt2vid → ltx2 createVideo; img2vid → firstLastFrameToVideo
 * - LTXV23 / txt2vid (+ ref2vid) → ltx2.3 createVideo; img2vid →
 *   firstLastFrameToVideo; vid2vid:edit → editVideo; vid2vid:extend → extendVideo
 * - LTXV25 / txt2vid (+ ref2vid) → ltx2.5 createVideo; img2vid → firstLastFrameToVideo
 */

import type {
  ComfyLtx23CreateVideoInput,
  ComfyLtx23EditVideoInput,
  ComfyLtx23ExtendVideoInput,
  ComfyLtx23FirstLastFrameToVideoInput,
  ComfyLtx25CreateVideoInput,
  ComfyLtx25FirstLastFrameToVideoInput,
  ComfyLtx2CreateVideoInput,
  ComfyLtx2FirstLastFrameToVideoInput,
  VideoGenStepTemplate,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import { resolveImageDimensions } from '~/utils/aspect-ratio-helpers';
import {
  ltxv2AspectRatios,
  ltxv23AspectRatiosByResolution,
  ltxv25AspectRatiosByResolution,
  LTXV2_DISTILLED_ID,
  DISTILLED_IDS,
  SULPHUR2_IDS,
} from '~/shared/form-graph/generation/video/ltx.graph';
import { defineHandler } from '../ecosystems/handler-factory';
import type { GenerationHandlerCtx, StepInput } from '../ecosystems';
import { createChainedPromptEnhancementStep } from '~/server/services/orchestrator/promptEnhancement';
import { resourcesToLoras } from './types';
import type { EcosystemData } from './types';

type LtxData = EcosystemData<'LTXV2' | 'LTXV23' | 'LTXV25'>;

function buildLoras(data: LtxData, ctx: GenerationHandlerCtx) {
  const loras = resourcesToLoras(data.resources, ctx.airs);
  return loras;
}

export const createLTXInput = defineHandler<LtxData, StepInput[]>((data, ctx) => {
  const loras = buildLoras(data, ctx);

  const steps: StepInput[] = [];
  let prompt = data.prompt ?? '';
  let negativePrompt: string | undefined = data.negativePrompt || undefined;
  // No LTX arm declares enablePromptEnhancer, so the enhancer step never runs today.
  const enablePromptEnhancer = (data as { enablePromptEnhancer?: boolean }).enablePromptEnhancer;
  if (enablePromptEnhancer) {
    const enhancerImages = data.images?.map((img) => img.url).filter((u): u is string => !!u);
    const audioEnabled = 'generateAudio' in data && !!data.generateAudio;
    const instruction = audioEnabled
      ? "Audio generation is enabled. Preserve any audio descriptions the user already wrote in the prompt (music, voices, dialogue, sound effects, ambient sounds) — do not remove, replace, or contradict them. If the user's prompt has little or no audio detail, add appropriate audio cues that fit the scene."
      : undefined;

    const {
      step,
      prompt: promptRef,
      negativePrompt: negativePromptRef,
    } = createChainedPromptEnhancementStep(
      {
        ecosystem: data.ecosystem ?? '',
        prompt,
        negativePrompt,
        preserveTriggerWords: data.triggerWords,
        images: enhancerImages?.length ? enhancerImages : undefined,
        instruction,
      },
      { stepIndex: steps.length, suppressOutput: true }
    );
    steps.push(step);
    prompt = promptRef;
    if (negativePrompt) negativePrompt = negativePromptRef;
  }

  if (data.ltxVersion === 'v25') {
    const distilled = DISTILLED_IDS.has(data.model?.id ?? -1);
    const model = distilled ? '22b-distilled' : '22b-dev';
    const resolution = data.resolution ?? '720p';
    const aspectRatios =
      ltxv25AspectRatiosByResolution[resolution] ?? ltxv25AspectRatiosByResolution['720p'];
    const guidanceScale = distilled ? 1 : data.cfgScale;
    const stepCount = distilled ? 8 : data.steps;

    let videoStep: VideoGenStepTemplate;
    if (data.workflow === 'img2vid') {
      const images = data.images;
      const { width, height } = resolveImageDimensions(images?.[0], aspectRatios, data.aspectRatio);
      videoStep = {
        $type: 'videoGen',
        input: removeEmpty({
          engine: 'ltx2.5',
          operation: 'firstLastFrameToVideo',
          prompt,
          negativePrompt,
          width,
          height,
          model,
          guidanceScale,
          steps: stepCount,
          duration: data.duration,
          firstFrame: images?.[0]?.url,
          lastFrame: images && images.length > 1 ? images[1]?.url : undefined,
          frameGuideStrength: data.frameGuideStrength,
          quantity: data.quantity,
          seed: data.seed,
          generateAudio: data.generateAudio,
          loras,
        }) as ComfyLtx25FirstLastFrameToVideoInput,
      };
    } else {
      videoStep = {
        $type: 'videoGen',
        input: removeEmpty({
          engine: 'ltx2.5',
          operation: 'createVideo',
          prompt,
          negativePrompt,
          width: data.aspectRatio?.width,
          height: data.aspectRatio?.height,
          model,
          guidanceScale,
          steps: stepCount,
          duration: data.duration,
          quantity: data.quantity,
          seed: data.seed,
          images: data.images?.map((x) => x.url),
          generateAudio: data.generateAudio,
          loras,
        }) as ComfyLtx25CreateVideoInput,
      };
    }

    steps.push(videoStep);
    return steps;
  }

  if (data.ltxVersion === 'v23') {
    const distilled = DISTILLED_IDS.has(data.model?.id ?? -1);
    const model = distilled ? '22b-distilled' : '22b-dev';
    const resolution = data.resolution ?? '720p';
    const aspectRatios =
      ltxv23AspectRatiosByResolution[resolution] ?? ltxv23AspectRatiosByResolution['720p'];
    const guidanceScale = distilled ? 1 : data.cfgScale;
    const stepCount = distilled ? 8 : data.steps;
    // Sulphur 2 is a community LTXV23 fine-tune — its AIR rides `diffusionModel`
    // to override the transformer while leaving CLIPs/VAEs/upscale-LoRA intact.
    const diffusionModel =
      data.model && SULPHUR2_IDS.has(data.model.id)
        ? ctx.airs.getOrThrow(data.model.id)
        : undefined;

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
            negativePrompt,
            width,
            height,
            model,
            diffusionModel,
            guidanceScale,
            steps: stepCount,
            duration: data.duration,
            firstFrame: images?.[0]?.url,
            lastFrame: images && images.length > 1 ? images[1]?.url : undefined,
            frameGuideStrength: data.frameGuideStrength,
            quantity: data.quantity,
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
            negativePrompt,
            width: data.video?.metadata?.width,
            height: data.video?.metadata?.height,
            model,
            diffusionModel,
            guidanceScale,
            steps: stepCount,
            duration: data.duration,
            sourceVideo: data.video?.url,
            cannyLowThreshold: data.cannyLowThreshold,
            cannyHighThreshold: data.cannyHighThreshold,
            guideStrength: data.guideStrength,
            quantity: data.quantity,
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
            negativePrompt,
            width: data.video?.metadata?.width,
            height: data.video?.metadata?.height,
            model,
            diffusionModel,
            guidanceScale,
            steps: stepCount,
            sourceVideo: data.video?.url,
            numFrames: data.numFrames,
            quantity: data.quantity,
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
            negativePrompt,
            width: data.aspectRatio?.width,
            height: data.aspectRatio?.height,
            model,
            diffusionModel,
            guidanceScale,
            steps: stepCount,
            duration: data.duration,
            quantity: data.quantity,
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
        negativePrompt,
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
        negativePrompt,
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
