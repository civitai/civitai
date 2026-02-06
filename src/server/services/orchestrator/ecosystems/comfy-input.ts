/**
 * Comfy Workflow Input Creator
 *
 * Shared utility for creating comfy step inputs.
 * Used by stable-diffusion.handler.ts for img2img/face-fix/hires-fix
 * and orchestration-new.service.ts for upscale/remove-background.
 */

import type { ComfyStepTemplate } from '@civitai/client';
import { populateWorkflowDefinition, applyResources } from '../comfy/comfy.utils';
import { samplersToComfySamplers } from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import type { GenerationHandlerCtx } from '.';

export type ComfyInputArgs = {
  /** Comfy workflow key */
  key: string;
  /** Number of images to generate */
  quantity?: number;
  /** Workflow-specific parameters (prompt, seed, dimensions, etc.) */
  params: Record<string, unknown>;
  /** Resources to apply (checkpoint, LoRAs, VAE) - requires handlerCtx */
  resources?: ResourceData[];
};

/**
 * Creates a comfy step input.
 *
 * @param args - Comfy input arguments
 * @param handlerCtx - Handler context with AIR map (required if resources are provided)
 */
export async function createComfyInput(
  args: ComfyInputArgs,
  handlerCtx?: GenerationHandlerCtx
): Promise<ComfyStepTemplate> {
  const { key, quantity = 1, params, resources = [] } = args;

  // Convert sampler to comfy sampler/scheduler if present
  let workflowData: Record<string, unknown> = { ...params };
  if ('sampler' in params && params.sampler) {
    const comfySampler =
      samplersToComfySamplers[
        (params.sampler as keyof typeof samplersToComfySamplers) ?? 'DPM++ 2M Karras'
      ];
    workflowData = {
      ...workflowData,
      sampler: comfySampler.sampler,
      scheduler: comfySampler.scheduler,
    };
  }

  const comfyWorkflow = await populateWorkflowDefinition(key, workflowData);

  // Apply resources (checkpoint, LoRAs, VAE, etc.) to the workflow
  if (resources.length > 0) {
    if (!handlerCtx) {
      throw new Error('handlerCtx is required when resources are provided');
    }
    const resourcesToApply = resources.map((resource) => ({
      air: handlerCtx.airs.getOrThrow(resource.id),
      strength: resource.strength,
    }));
    workflowData = { ...workflowData, resources: resourcesToApply };
    applyResources(comfyWorkflow, resourcesToApply);
  }

  const imageMetadata = JSON.stringify(removeEmpty(workflowData));

  return {
    $type: 'comfy',
    input: {
      quantity,
      comfyWorkflow,
      imageMetadata,
      useSpineComfy: null,
    },
  };
}
