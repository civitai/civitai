/**
 * Ecosystem Graph
 *
 * Subgraph for ecosystem-dependent nodes (baseModel, model, modelFamily).
 * Only included when the workflow has ecosystem support.
 *
 * This graph expects `workflow`, `output`, and `input` to be available in the parent context.
 *
 * Architecture:
 * - baseModel and model nodes are defined at this level (shared across all model families)
 * - modelFamily discriminator selects family-specific nodes (SD vs Flux)
 * - Family subgraphs only contain nodes specific to that family (no model node)
 */

import { z } from 'zod';
import {
  ecosystemById,
  ecosystemByKey,
  getEcosystemsForWorkflow,
} from '~/shared/constants/basemodel.constants';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { textInputGraph, imageInputGraph, quantityNode } from './common';
import { fluxGraph } from './flux-graph';
import { stableDiffusionGraph } from './stable-diffusion-graph';
import { qwenGraph } from './qwen-graph';
import { nanoBananaGraph } from './nano-banana-graph';
import { seedreamGraph } from './seedream-graph';
import { imagen4Graph } from './imagen4-graph';
import { flux2Graph } from './flux2-graph';
import { fluxKontextGraph } from './flux-kontext-graph';
import { zImageTurboGraph } from './z-image-turbo-graph';
import { chromaGraph } from './chroma-graph';
import { hiDreamGraph } from './hi-dream-graph';
import { ponyV7Graph } from './pony-v7-graph';
import {
  isWorkflowAvailable,
  getDefaultEcosystemForWorkflow,
} from './workflows';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get valid ecosystem key for the given workflow.
 * If the current value supports the workflow, keep it; otherwise return the default ecosystem.
 */
function getValidEcosystemForWorkflow(workflowId: string, currentValue?: string): string {
  if (currentValue) {
    const ecosystem = ecosystemByKey.get(currentValue);
    if (ecosystem && isWorkflowAvailable(workflowId, ecosystem.id)) {
      return currentValue;
    }
  }
  const defaultEcoId = getDefaultEcosystemForWorkflow(workflowId);
  if (defaultEcoId) {
    const eco = ecosystemById.get(defaultEcoId);
    if (eco) return eco.key;
  }
  return 'SDXL'; // Ultimate fallback
}

// =============================================================================
// Ecosystem Graph
// =============================================================================

export const ecosystemGraph = new DataGraph<
  { workflow: string; output: 'image' | 'video'; input: 'text' | 'image' | 'video' },
  GenerationCtx
>()
  // baseModel depends on workflow to filter compatible ecosystems
  .node(
    'baseModel',
    (ctx) => {
      // Get ecosystems compatible with the selected workflow
      const compatibleEcosystems = getEcosystemsForWorkflow(ctx.workflow);
      // Default to first compatible ecosystem, or SDXL as fallback
      const defaultValue = compatibleEcosystems[0] ?? 'SDXL';

      return {
        input: z.string().optional(),
        output: z.string(),
        defaultValue,
        meta: {
          compatibleEcosystems,
          mediaType: ctx.output, // 'image' or 'video'
        },
      };
    },
    ['workflow', 'output']
  )
  // When workflow changes, update baseModel if incompatible
  .effect(
    (ctx, _ext, set) => {
      const ecosystem = ctx.baseModel ? ecosystemByKey.get(ctx.baseModel) : undefined;
      if (!ecosystem) return;

      // If current baseModel supports the workflow, nothing to do
      if (isWorkflowAvailable(ctx.workflow, ecosystem.id)) {
        return;
      }

      // Find a compatible ecosystem for this workflow
      const validEcosystem = getValidEcosystemForWorkflow(ctx.workflow, ctx.baseModel);
      if (validEcosystem !== ctx.baseModel) {
        set('baseModel', validEcosystem);
      }
    },
    ['workflow']
  )
  // When baseModel changes, check if current workflow is still supported
  .effect(
    (ctx, _ext, set) => {
      const ecosystem = ctx.baseModel ? ecosystemByKey.get(ctx.baseModel) : undefined;
      if (!ecosystem) return;

      // If current workflow is supported by the new baseModel, nothing to do
      if (isWorkflowAvailable(ctx.workflow, ecosystem.id)) {
        return;
      }

      // Workflow not supported - switch to 'txt2img' which is universal
      set('workflow', 'txt2img');
    },
    ['baseModel']
  )
  // Quantity node - workflow-dependent (draft uses step=4)
  .node(
    'quantity',
    (ctx, ext) => {
      const isDraft = ctx.workflow === 'draft';
      return quantityNode({ min: isDraft ? 4 : 1, step: isDraft ? 4 : 1 })(ctx, ext);
    },
    ['workflow']
  )
  .discriminator('input', {
    text: textInputGraph,
    image: imageInputGraph,
    // Video input workflows use their own video node in the workflow discriminator
    // This empty graph prevents cleanup when input='video'
    video: new DataGraph<Record<never, never>, GenerationCtx>(),
  })
  // Compute model family from baseModel to determine which subgraph to use
  .computed(
    'modelFamily',
    (ctx) => {
      // These are ecosystem keys, not base model names
      const sdFamilyEcosystems = ['SD1', 'SD2', 'SDXL', 'Pony', 'Illustrious', 'NoobAI'];
      const fluxFamilyEcosystems = ['Flux1', 'FluxKrea'];
      const baseModel = ctx.baseModel ?? '';

      if (sdFamilyEcosystems.includes(baseModel)) return 'stable-diffusion';
      if (fluxFamilyEcosystems.includes(baseModel)) return 'flux';
      if (ctx.baseModel === 'Qwen') return 'qwen';
      if (ctx.baseModel === 'NanoBanana') return 'nano-banana';
      if (ctx.baseModel === 'Seedream') return 'seedream';
      if (ctx.baseModel === 'Imagen4') return 'imagen4';
      if (ctx.baseModel === 'Flux2') return 'flux2';
      if (ctx.baseModel === 'Flux1Kontext') return 'flux-kontext';
      if (ctx.baseModel === 'ZImageTurbo') return 'z-image-turbo';
      if (ctx.baseModel === 'Chroma') return 'chroma';
      if (ctx.baseModel === 'HiDream') return 'hi-dream';
      if (ctx.baseModel === 'PonyV7') return 'pony-v7';
      return undefined;
    },
    ['baseModel']
  )

  .discriminator('modelFamily', {
    'stable-diffusion': stableDiffusionGraph,
    flux: fluxGraph,
    qwen: qwenGraph,
    'nano-banana': nanoBananaGraph,
    seedream: seedreamGraph,
    imagen4: imagen4Graph,
    flux2: flux2Graph,
    'flux-kontext': fluxKontextGraph,
    'z-image-turbo': zImageTurboGraph,
    chroma: chromaGraph,
    'hi-dream': hiDreamGraph,
    'pony-v7': ponyV7Graph,
  });
