/**
 * Anima Ecosystem Handler
 *
 * Handles Anima workflows using imageGen step type.
 * Uses the sdcpp engine with AnimaCreateImageGenInput.
 */

import type {
  AnimaCreateImageGenInput,
  ImageGenStepTemplate,
  SdCppSampleMethod,
  SdCppSchedule,
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { defineHandler } from './handler-factory';

// Types derived from generation graph
type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type AnimaCtx = EcosystemGraphOutput & { ecosystem: 'Anima' };

/**
 * Creates imageGen input for Anima ecosystem.
 */
export const createAnimaInput = defineHandler<AnimaCtx, [ImageGenStepTemplate]>(
  (data) => {
    return [
      {
        $type: 'imageGen',
        input: removeEmpty({
          engine: 'sdcpp',
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
        }) as AnimaCreateImageGenInput,
      },
    ];
  }
);
