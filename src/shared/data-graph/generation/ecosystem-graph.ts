/**
 * Ecosystem Graph
 *
 * Subgraph for ecosystem-dependent nodes (ecosystem, model, modelFamily).
 * Only included when the workflow has ecosystem support.
 *
 * This graph expects `workflow`, `output`, and `input` to be available in the parent context.
 *
 * Architecture:
 * - ecosystem and model nodes are defined at this level (shared across all model families)
 * - modelFamily discriminator selects family-specific nodes (SD vs Flux)
 * - Family subgraphs only contain nodes specific to that family (no model node)
 */

import { z } from 'zod';
import { ecosystemById, ecosystemByKey } from '~/shared/constants/basemodel.constants';
import {
  EXPERIMENTAL_MODE_SUPPORTED_MODELS,
  SDCPP_SUPPORTED_ECOSYSTEMS,
  fluxUltraAirId,
} from '~/shared/constants/generation.constants';
import {
  getEcosystemsForWorkflow,
  getWorkflowsForEcosystem,
  isWorkflowAvailable,
  getDefaultEcosystemForWorkflow,
  workflowConfigByKey,
  workflowGroups,
} from './config';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { quantityNode, promptNode, enhancedCompatibilityNode } from './common';
import { fluxGraph } from './flux-graph';
import { stableDiffusionGraph } from './stable-diffusion-graph';
import { qwenGraph } from './qwen-graph';
import { nanoBananaGraph } from './nano-banana-graph';
import { seedreamGraph } from './seedream-graph';
import { imagen4Graph } from './imagen4-graph';
import { flux2Graph } from './flux2-graph';
import { flux2KleinGraph } from './flux2-klein-graph';
import { fluxKontextGraph } from './flux-kontext-graph';
import { zImageGraph } from './z-image-graph';
import { chromaGraph } from './chroma-graph';
import { hiDreamGraph } from './hi-dream-graph';
import { ponyV7Graph } from './pony-v7-graph';
import { viduGraph } from './vidu-graph';
import { openaiGraph } from './openai-graph';
import { klingGraph, klingVersionIds } from './kling-graph';
import { wanGraph } from './wan-graph';
import { wanImageGraph } from './wan-image-graph';
import { hunyuanGraph } from './hunyuan-graph';
import { ltxGraph } from './ltx-graph';
import { mochiGraph } from './mochi-graph';
import { soraGraph } from './sora-graph';
import { veo3Graph } from './veo3-graph';
import { animaGraph } from './anima-graph';
import { grokGraph } from './grok-graph';
import { ernieGraph } from './ernie-graph';
import { seedanceGraph } from './seedance-graph';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Whether the given ecosystem/model pair surfaces the `enhancedCompatibility` toggle.
 */
function supportsEnhancedCompatibility(ecosystem: string, modelId?: number): boolean {
  return EXPERIMENTAL_MODE_SUPPORTED_MODELS.includes(ecosystem) && modelId !== fluxUltraAirId;
}

/**
 * Whether the given ecosystem/model pair runs through sdcpp and qualifies for
 * the 2-for-1 quantity bonus. Superset of `supportsEnhancedCompatibility` —
 * includes ecosystems without the `enhancedCompatibility` toggle.
 */
function supportsSdcpp(ecosystem: string, modelId?: number): boolean {
  return SDCPP_SUPPORTED_ECOSYSTEMS.includes(ecosystem) && modelId !== fluxUltraAirId;
}

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
  // ecosystem depends on workflow to filter compatible ecosystems
  .node(
    'ecosystem',
    (ctx) => {
      // Get ecosystems compatible with the selected workflow (as IDs, convert to keys)
      const compatibleEcosystemIds = getEcosystemsForWorkflow(ctx.workflow);
      const compatibleEcosystems = compatibleEcosystemIds
        .map((id) => ecosystemById.get(id)?.key)
        .filter((key): key is string => !!key);
      // Default ecosystem by output type: ZImageTurbo for image, Kling for video
      const outputDefault = ctx.output === 'video' ? 'Kling' : 'ZImageTurbo';
      const defaultValue = compatibleEcosystems.includes(outputDefault)
        ? outputDefault
        : compatibleEcosystems[0] ?? 'SDXL';

      return {
        input: z
          .string()
          .optional()
          .transform((v) => (v ? v : undefined)),
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
  // When workflow changes, update ecosystem if incompatible
  .effect(
    (ctx, _ext, set) => {
      const ecosystem = ctx.ecosystem ? ecosystemByKey.get(ctx.ecosystem) : undefined;
      if (!ecosystem) return;

      // If current ecosystem supports the workflow, nothing to do
      if (isWorkflowAvailable(ctx.workflow, ecosystem.id)) {
        return;
      }

      // If there's a workflow group override for this ecosystem that includes the workflow,
      // let the subgraph handle it (e.g., Wan I2V ecosystems switching T2V↔I2V internally)
      const group = workflowGroups.find((g) => g.workflows.includes(ctx.workflow));
      if (group) {
        const override = group.overrides?.find((o) => o.ecosystemIds.includes(ecosystem.id));
        if (override?.workflows.includes(ctx.workflow)) {
          return;
        }
      }

      // Find a compatible ecosystem for this workflow
      const validEcosystem = getValidEcosystemForWorkflow(ctx.workflow, ctx.ecosystem);
      if (validEcosystem !== ctx.ecosystem) {
        set('ecosystem', validEcosystem);
      }
    },
    ['workflow']
  )
  // When ecosystem changes, check if current workflow is still supported
  .effect(
    (ctx, _ext, set) => {
      const ecosystem = ctx.ecosystem ? ecosystemByKey.get(ctx.ecosystem) : undefined;
      if (!ecosystem) return;

      // If current workflow is supported by the new ecosystem, nothing to do
      if (isWorkflowAvailable(ctx.workflow, ecosystem.id)) {
        return;
      }

      // Workflow not supported - find a compatible workflow.
      // Prefer workflows in the same category (image/video) as the current workflow,
      // and exclude enhancement and noSubmit (utility) workflows.
      const currentCategory = workflowConfigByKey.get(ctx.workflow)?.category;
      const allWorkflows = getWorkflowsForEcosystem(ecosystem.id);
      let compatibleWorkflows = allWorkflows.filter((w) => {
        if (w.enhancement) return false;
        const config = workflowConfigByKey.get(w.graphKey);
        if (config?.noSubmit) return false;
        return true;
      });
      // If all workflows are enhancement (e.g. Upscaler ecosystem), allow them
      if (compatibleWorkflows.length === 0) {
        compatibleWorkflows = allWorkflows.filter((w) => {
          const config = workflowConfigByKey.get(w.graphKey);
          return !config?.noSubmit;
        });
      }
      const sameCategory = currentCategory
        ? compatibleWorkflows.filter((w) => w.category === currentCategory)
        : [];
      const fallback = sameCategory[0] ?? compatibleWorkflows[0];
      if (fallback) {
        set('workflow', fallback.graphKey);
      } else {
        set('workflow', 'txt2img');
      }
    },
    ['ecosystem']
  )
  // Use groupedDiscriminator to reduce TypeScript type complexity:
  // - Multiple ecosystem values that share the same graph are grouped into ONE type branch
  // - This reduces union type bloat from O(ecosystems) to O(families)
  .groupedDiscriminator('ecosystem', [
    // Image ecosystems - Stable Diffusion family (ONE type branch)
    {
      values: ['SD1', 'SD2', 'SDXL', 'Pony', 'Illustrious', 'NoobAI'] as const,
      graph: stableDiffusionGraph,
    },
    // Image ecosystems - Flux family (ONE type branch)
    {
      values: ['Flux1', 'FluxKrea'] as const,
      graph: fluxGraph,
    },
    // Image ecosystems - individual families
    { values: ['Qwen', 'Qwen2'] as const, graph: qwenGraph },
    { values: ['NanoBanana'] as const, graph: nanoBananaGraph },
    { values: ['Seedream'] as const, graph: seedreamGraph },
    { values: ['Imagen4'] as const, graph: imagen4Graph },
    { values: ['Flux2'] as const, graph: flux2Graph },
    {
      values: [
        'Flux2Klein_9B',
        'Flux2Klein_9B_base',
        'Flux2Klein_4B',
        'Flux2Klein_4B_base',
      ] as const,
      graph: flux2KleinGraph,
    },
    { values: ['Flux1Kontext'] as const, graph: fluxKontextGraph },
    { values: ['ZImageTurbo', 'ZImageBase'] as const, graph: zImageGraph },
    { values: ['Chroma'] as const, graph: chromaGraph },
    { values: ['HiDream'] as const, graph: hiDreamGraph },
    { values: ['PonyV7'] as const, graph: ponyV7Graph },
    { values: ['Anima'] as const, graph: animaGraph },
    { values: ['Ernie'] as const, graph: ernieGraph },
    { values: ['OpenAI'] as const, graph: openaiGraph },
    // Video ecosystems - Wan family (ONE type branch for all Wan variants)
    {
      values: [
        'WanVideo',
        'WanVideo1_3B_T2V',
        'WanVideo14B_T2V',
        'WanVideo14B_I2V_480p',
        'WanVideo14B_I2V_720p',
        'WanVideo-22-TI2V-5B',
        'WanVideo-22-I2V-A14B',
        'WanVideo-22-T2V-A14B',
        'WanVideo-25-T2V',
        'WanVideo-25-I2V',
        'WanVideo27',
      ] as const,
      graph: wanGraph,
    },
    // Image ecosystems - Wan Image family
    { values: ['WanImage27'] as const, graph: wanImageGraph },
    // Video ecosystems - individual families
    { values: ['Vidu'] as const, graph: viduGraph },
    { values: ['Kling'] as const, graph: klingGraph },
    { values: ['HyV1'] as const, graph: hunyuanGraph },
    { values: ['LTXV2', 'LTXV23'] as const, graph: ltxGraph },
    { values: ['Mochi'] as const, graph: mochiGraph },
    { values: ['Sora2'] as const, graph: soraGraph },
    { values: ['Veo3'] as const, graph: veo3Graph },
    { values: ['Grok'] as const, graph: grokGraph },
    { values: ['Seedance'] as const, graph: seedanceGraph },
  ])
  // Enhanced compatibility mode - only for supported ecosystems, hidden for Flux Ultra
  .node(
    'enhancedCompatibility',
    (ctx) => {
      const modelId = 'model' in ctx ? ctx.model?.id : undefined;
      return {
        ...enhancedCompatibilityNode(),
        when: supportsEnhancedCompatibility(ctx.ecosystem, modelId),
      };
    },
    ['ecosystem', 'model']
  )
  // Quantity node - image output only.
  // Step: draft=4, BOGO-enabled w/ enhancedCompatibility off=2, else=1.
  // The step=2 path is gated by the `enhancedCompatibilitySdcpp` feature flag.
  // Ecosystems without an `enhancedCompatibility` node get BOGO unconditionally
  // (ctx.enhancedCompatibility is undefined, which satisfies `!== true`).
  .node(
    'quantity',
    (ctx, ext) => {
      const isDraft = ctx.workflow === 'txt2img:draft';
      const modelId = 'model' in ctx ? ctx.model?.id : undefined;
      const bogoActive =
        !!ext.flags?.enhancedCompatibilitySdcpp &&
        supportsSdcpp(ctx.ecosystem, modelId) &&
        ctx.enhancedCompatibility !== true;
      const step = isDraft ? 4 : bogoActive ? 2 : 1;
      return {
        ...quantityNode({ step })(ctx, ext),
        when: ctx.output === 'image',
      };
    },
    ['workflow', 'output', 'ecosystem', 'model', 'enhancedCompatibility']
  )
  .node(
    'prompt',
    (ctx) => {
      const images = 'images' in ctx ? (ctx.images as unknown[]) : undefined;
      // const multiShot = 'multiShot' in ctx ? (ctx.multiShot as boolean) : false;
      const isKlingV3 = ctx.ecosystem === 'Kling' && ctx.model?.id === klingVersionIds.v3;
      const isGrok = ctx.ecosystem === 'Grok';
      return { ...promptNode({ required: !images?.length || isKlingV3 || isGrok }) };
    },
    ['images', 'multiShot']
  )
  .computed(
    'triggerWords',
    (ctx) => {
      const resources = ('resources' in ctx ? ctx.resources : undefined) ?? [];
      const model = 'model' in ctx ? ctx.model : undefined;
      const allResources = model ? [model, ...resources] : resources;
      return allResources.flatMap((r) => r.trainedWords ?? []);
    },
    ['model', 'resources']
  );
