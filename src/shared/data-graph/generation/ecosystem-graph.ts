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
import { quantityNode, imagesNode, promptNode, type ImageSlotConfig } from './common';
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
import { viduGraph } from './vidu-graph';
import { openaiGraph } from './openai-graph';
import { klingGraph } from './kling-graph';
import { wanGraph } from './wan-graph';
import { hunyuanGraph } from './hunyuan-graph';
import { minimaxGraph } from './minimax-graph';
import { haiperGraph } from './haiper-graph';
import { mochiGraph } from './mochi-graph';
import { lightricksGraph } from './lightricks-graph';
import { soraGraph } from './sora-graph';
import { veo3Graph } from './veo3-graph';
import { isWorkflowAvailable, getDefaultEcosystemForWorkflow } from './workflows';

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
      // Disable selection when there's only one option
      const disabled = compatibleEcosystems.length <= 1;

      return {
        input: z.string().optional(),
        output: z.string(),
        defaultValue,
        meta: {
          compatibleEcosystems,
          mediaType: ctx.output, // 'image' or 'video'
          disabled,
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
      const isDraft = ctx.workflow === 'txt2img:draft';
      return quantityNode({ min: isDraft ? 4 : 1, step: isDraft ? 4 : 1 })(ctx, ext);
    },
    ['workflow']
  )
  .node('prompt', (ctx) => promptNode({ required: ctx.input === 'text' }), ['input'])
  .node(
    'images',
    (ctx) => {
      const config = getImageConfig(ctx);
      const max = config?.max ?? 1;
      const min = config?.min ?? 1;
      const slots = config?.slots;
      return { ...imagesNode({ max, min, slots }), when: ctx.input === 'image' };
    },
    ['workflow', 'baseModel', 'model', 'input']
  )

  // Compute model family from baseModel to determine which subgraph to use
  .computed(
    'modelFamily',
    (ctx) => {
      // These are ecosystem keys, not base model names
      const sdFamilyEcosystems = ['SD1', 'SD2', 'SDXL', 'Pony', 'Illustrious', 'NoobAI'];
      const fluxFamilyEcosystems = ['Flux1', 'FluxKrea'];
      // Wan family includes all Wan video ecosystems
      const wanFamilyEcosystems = [
        'WanVideo',
        'WanVideo1_3B_T2V',
        'WanVideo14B_T2V',
        'WanVideo14B_I2V_480p',
        'WanVideo14B_I2V_720p',
        'WanVideo22_TI2V_5B',
        'WanVideo22_I2V_A14B',
        'WanVideo22_T2V_A14B',
        'WanVideo25_T2V',
        'WanVideo25_I2V',
      ];
      const baseModel = ctx.baseModel ?? '';

      // Image ecosystems
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
      if (ctx.baseModel === 'OpenAI') return 'openai';

      // Video ecosystems
      if (ctx.baseModel === 'Vidu') return 'vidu';
      if (ctx.baseModel === 'Kling') return 'kling';
      if (wanFamilyEcosystems.includes(baseModel)) return 'wan';
      if (ctx.baseModel === 'HyV1') return 'hunyuan';
      if (ctx.baseModel === 'MiniMax') return 'minimax';
      if (ctx.baseModel === 'Haiper') return 'haiper';
      if (ctx.baseModel === 'Mochi') return 'mochi';
      if (ctx.baseModel === 'Lightricks') return 'lightricks';
      if (ctx.baseModel === 'Sora2') return 'sora';
      if (ctx.baseModel === 'Veo3') return 'veo3';

      return undefined;
    },
    ['baseModel']
  )

  .discriminator('modelFamily', {
    // Image ecosystems
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
    openai: openaiGraph,
    // Video ecosystems
    vidu: viduGraph,
    kling: klingGraph,
    wan: wanGraph,
    hunyuan: hunyuanGraph,
    minimax: minimaxGraph,
    haiper: haiperGraph,
    mochi: mochiGraph,
    lightricks: lightricksGraph,
    sora: soraGraph,
    veo3: veo3Graph,
  });

type ImageConfig = {
  max?: number;
  min?: number;
  slots?: ImageSlotConfig[];
};

/**
 * Image config lookup.
 * Keys can be:
 * - Model + workflow: "model:123456:image-edit"
 * - Model only: "model:123456"
 * - Ecosystem + workflow: "Qwen:image-edit"
 * - Ecosystem only: "Qwen"
 * - Workflow only: "image-edit"
 *
 * Lookup priority (most specific wins):
 * 1. model:{id}:{workflow}
 * 2. model:{id}
 * 3. {ecosystem}:{workflow}
 * 4. {ecosystem}
 * 5. {workflow}
 * 6. default (max: 1, min: 1)
 */
const imageConfigs: Record<string, ImageConfig> = {
  // Ecosystem + workflow combinations
  'Qwen:image-edit': { max: 1 },
  'Flux1Kontext:image-edit': { max: 1 },

  // Workflow defaults
  'image-edit': { max: 7 },

  // Video workflows - default img2vid is single image
  img2vid: { max: 1, min: 1 },
  // Vidu-specific video workflows
  'img2vid:first-last-frame': {
    slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame' }],
  },
  'img2vid:ref2vid': { max: 7, min: 1 },
};

function getImageConfig(ctx: {
  workflow?: string;
  baseModel?: string;
  model?: { id: number };
}): ImageConfig | undefined {
  // 1. Check model + workflow combination
  if (ctx.model?.id && ctx.workflow) {
    const modelWorkflowConfig = imageConfigs[`model:${ctx.model.id}:${ctx.workflow}`];
    if (modelWorkflowConfig) return modelWorkflowConfig;
  }

  // 2. Check model-specific config
  if (ctx.model?.id) {
    const modelConfig = imageConfigs[`model:${ctx.model.id}`];
    if (modelConfig) return modelConfig;
  }

  // 3. Check ecosystem + workflow combination
  if (ctx.baseModel && ctx.workflow) {
    const comboConfig = imageConfigs[`${ctx.baseModel}:${ctx.workflow}`];
    if (comboConfig) return comboConfig;
  }

  // 4. Check ecosystem only
  if (ctx.baseModel) {
    const ecosystemConfig = imageConfigs[ctx.baseModel];
    if (ecosystemConfig) return ecosystemConfig;
  }

  // 5. Check workflow only
  if (ctx.workflow) {
    const workflowConfig = imageConfigs[ctx.workflow];
    if (workflowConfig) return workflowConfig;
  }

  return undefined;
}
