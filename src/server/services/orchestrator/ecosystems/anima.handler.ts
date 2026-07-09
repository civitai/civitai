/**
 * Anima Ecosystem Handler
 *
 * Handles Anima workflows using imageGen step type.
 * Uses the sdcpp engine with AnimaCreateImageGenInput.
 */

import type {
  AnimaCreateImageGenInput,
  ImageGenStepTemplate,
  PreprocessImageStepTemplate,
  SdCppSampleMethod,
  SdCppSchedule,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import type { ControlNetsNodeValue, ResourceData } from '~/shared/data-graph/generation/common';
import { defineHandler } from './handler-factory';
import { buildControlNetSteps } from './controlnets.helper';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type AnimaCtx = EcosystemGraphOutput & { ecosystem: 'Anima' };

/**
 * Creates imageGen input for Anima ecosystem.
 */
export const createAnimaInput = defineHandler<
  AnimaCtx,
  (ImageGenStepTemplate | PreprocessImageStepTemplate)[]
>((data, ctx) => {
  const loras: Record<string, number> = {};
  if ('resources' in data && Array.isArray(data.resources)) {
    for (const resource of data.resources as ResourceData[]) {
      loras[ctx.airs.getOrThrow(resource.id)] = resource.strength ?? 1;
    }
  }

  const diffuserModel = data.model ? ctx.airs.getOrThrow(data.model.id) : undefined;

  const { preprocessSteps, controlNets } = buildControlNetSteps(
    (data as { controlNets?: ControlNetsNodeValue }).controlNets,
    ctx.baseStepIndex
  );

  const genStep: ImageGenStepTemplate = {
    $type: 'imageGen',
    input: removeEmpty({
      engine: 'comfy',
      ecosystem: 'anima',
      operation: 'createImage',
      prompt: data.prompt,
      negativePrompt: data.negativePrompt,
      width: data.aspectRatio?.width,
      height: data.aspectRatio?.height,
      cfgScale: data.cfgScale,
      steps: data.steps,
      sampleMethod: data.sampler as SdCppSampleMethod,
      schedule: data.scheduler as SdCppSchedule,
      seed: data.seed,
      quantity: data.quantity ?? 1,
      outputFormat: data.outputFormat,
      loras: Object.keys(loras).length > 0 ? loras : undefined,
      diffuserModel,
      ...(controlNets.length ? { controlNets } : {}),
      // `as any`: (1) published AnimaCreateImageGenInput still declares engine
      // 'sdcpp' (upstream switched to 'comfy'); (2) controlNets isn't declared on
      // the type yet but is accepted by the orchestrator for the anima ecosystem.
    }) as any as AnimaCreateImageGenInput,
  };

  return [...preprocessSteps, genStep];
});
