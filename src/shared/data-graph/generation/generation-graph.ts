/**
 * Generation Graph V2
 *
 * Uses the DataGraph v2 class with Controller pattern.
 * Meta only contains dynamic props (options, min/max from context, etc.)
 * Static props (label, buttonLabel, placeholder, etc.) are defined in components.
 *
 * Workflow-First Architecture:
 * - Users select a workflow (Create Image, Draft, Face Fix, etc.)
 * - Workflow determines input type (text/image), output type (image/video), and available ecosystems
 * - Ecosystem picker shows compatible ecosystems for the selected workflow
 * - Recent ecosystems are tracked in localStorage (limit 3)
 *
 * Ecosystem Support Discriminator:
 * - Some workflows (like vid2vid:upscale) have no ecosystem support
 * - For these workflows, baseModel/model nodes are not rendered
 * - The `hasEcosystemSupport` computed node acts as a discriminator
 */

import { z } from 'zod';
import {
  ecosystemById,
  ecosystemByKey,
  getEcosystemsForWorkflow,
} from '~/shared/constants/basemodel.constants';
import { DataGraph, type InferDataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { textInputGraph, imageInputGraph } from './common';
import { fluxGraph } from './flux-graph';
import { stableDiffusionGraph } from './stable-diffusion-graph';
import { videoInterpolationGraph } from './video-interpolation-graph';
import { videoUpscaleGraph } from './video-upscale-graph';
import {
  getDefaultEcosystemForWorkflow,
  getInputTypeForWorkflow,
  getOutputTypeForWorkflow,
  isWorkflowAvailable,
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
// Ecosystem Subgraph
// =============================================================================

/**
 * Subgraph for ecosystem-dependent nodes (baseModel, model, modelFamily).
 * Only included when the workflow has ecosystem support.
 *
 * This graph expects `workflow` and `output` to be available in the parent context.
 *
 * Architecture:
 * - baseModel and model nodes are defined at this level (shared across all model families)
 * - modelFamily discriminator selects family-specific nodes (SD vs Flux)
 * - Family subgraphs only contain nodes specific to that family (no model node)
 */
const ecosystemGraph = new DataGraph<
  { workflow: string; output: 'image' | 'video' },
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
  // Compute model family from baseModel to determine which subgraph to use
  .computed(
    'modelFamily',
    (ctx) => {
      // These are ecosystem keys, not base model names
      const sdFamilyEcosystems = ['SD1', 'SD2', 'SDXL', 'Pony', 'Illustrious', 'NoobAI'];
      const fluxFamilyEcosystems = ['Flux1', 'FluxKrea', 'Flux1Kontext', 'Flux2'];
      if (sdFamilyEcosystems.includes(ctx.baseModel)) return 'stable-diffusion';
      if (fluxFamilyEcosystems.includes(ctx.baseModel)) return 'flux';
      return undefined;
    },
    ['baseModel']
  )
  // Model family discriminator - selects family-specific nodes
  // Note: model node is NOT in the discriminator subgraphs to avoid cleanup issues
  .discriminator('modelFamily', {
    'stable-diffusion': stableDiffusionGraph,
    flux: fluxGraph,
  });

// =============================================================================
// Generation Graph V2
// =============================================================================

/**
 * Generation graph v2 definition.
 *
 * Workflow-First Architecture:
 * - The `workflow` node is the primary selector (Create Image, Draft, Face Fix, etc.)
 * - `output` and `input` are computed from the selected workflow
 * - `hasEcosystemSupport` determines if baseModel/model nodes should be shown
 * - `baseModel` picker shows ecosystems compatible with the workflow, plus recent selections
 * - When ecosystem changes, workflow compatibility is checked and may switch to 'txt2img'
 *
 * @example
 * ```tsx
 * <Controller
 *   graph={graph}
 *   name="workflow"
 *   render={({ value, meta, onChange }) => (
 *     <WorkflowSelect
 *       value={value}
 *       onChange={onChange}
 *       options={meta.options}
 *     />
 *   )}
 * />
 * ```
 */
export const generationGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  // Workflow is the primary selector - determines input type, output type, and available ecosystems
  // Workflow values are workflow keys (e.g., 'txt2img', 'draft', 'img2img:face-fix')
  .node(
    'workflow',
    () => {
      return {
        input: z.string().optional(),
        output: z.string(),
        defaultValue: 'txt2img',
        meta: {
          // All workflows are shown - compatibility is handled by baseModel filtering
        },
      };
    },
    []
  )
  // Output is computed from workflow
  .computed(
    'output',
    (ctx) => {
      return getOutputTypeForWorkflow(ctx.workflow);
    },
    ['workflow']
  )
  // Input is computed from workflow
  .computed(
    'input',
    (ctx) => {
      return getInputTypeForWorkflow(ctx.workflow);
    },
    ['workflow']
  )
  // Quantity node - must be before discriminators to access full workflow type
  .node(
    'quantity',
    (ctx, ext) => {
      const isDraft = ctx.workflow === 'draft';
      const step = isDraft ? 4 : 1;
      const min = isDraft ? 4 : 1;
      const max = ext.limits.maxQuantity;

      return {
        input: z.coerce
          .number()
          .optional()
          .transform((val) => {
            if (val === undefined) return undefined;
            // Snap to step multiples (round up to nearest step) and clamp to max
            return Math.min(Math.ceil(val / step) * step, max);
          }),
        output: z.number().min(min).max(max),
        defaultValue: min,
        meta: {
          min,
          max,
          step,
        },
      };
    },
    ['workflow']
  )
  // Discriminator: include ecosystem-dependent nodes only for workflows with ecosystem support
  // Workflows without ecosystem support (vid2vid:*) use their own specialized graphs
  .discriminator('workflow', {
    // Text to image workflows
    txt2img: ecosystemGraph,
    draft: ecosystemGraph,
    'txt2img:face-fix': ecosystemGraph,
    'txt2img:hires-fix': ecosystemGraph,
    // Image to image workflows
    img2img: ecosystemGraph,
    'img2img:face-fix': ecosystemGraph,
    'img2img:hires-fix': ecosystemGraph,
    'image-edit': ecosystemGraph,
    // Video workflows with ecosystem support
    txt2vid: ecosystemGraph,
    img2vid: ecosystemGraph,
    // Video enhancement workflows (no ecosystem support)
    'vid2vid:interpolate': videoInterpolationGraph,
    'vid2vid:upscale': videoUpscaleGraph,
  })
  .discriminator('input', {
    text: textInputGraph,
    image: imageInputGraph,
    // Video input workflows use their own video node in the workflow discriminator
    // This empty graph prevents cleanup when input='video'
    video: new DataGraph<Record<never, never>, GenerationCtx>(),
  });

/** Type helper for the generation graph context */
export type GenerationGraphCtx = ReturnType<typeof generationGraph.init>;

/** Inferred types for use with Controller and useGraph hooks */
export type GenerationGraphTypes = InferDataGraph<typeof generationGraph>;
