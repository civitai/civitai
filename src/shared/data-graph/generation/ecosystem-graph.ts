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
  SDCPP_EXCLUDED_MODEL_IDS,
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
import {
  pickStrongerGate,
  rulesToStates,
  type GateItemState,
  type GateResolution,
  type GateState,
} from './gates';
import { quantityNode, enhancedCompatibilityNode } from './common';
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
import { hiDreamO1Graph } from './hi-dream-o1-graph';
import { ponyV7Graph } from './pony-v7-graph';
import { viduGraph } from './vidu-graph';
import { openaiGraph } from './openai-graph';
import { klingGraph } from './kling-graph';
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
import { lensGraph } from './lens-graph';
import { krea2Graph } from './krea2-graph';
import { maiGraph } from './mai-graph';
import { seedanceGraph } from './seedance-graph';
import { happyHorseGraph } from './happy-horse-graph';
import { aceAudioGraph } from './ace-audio-graph';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Whether the given ecosystem/model pair surfaces the `enhancedCompatibility` toggle.
 */
function supportsEnhancedCompatibility(ecosystem: string, modelId?: number): boolean {
  return EXPERIMENTAL_MODE_SUPPORTED_MODELS.includes(ecosystem) && modelId !== fluxUltraAirId;
}

/** Hard kill-switch for the `enhancedCompatibility` toggle. Flip to re-enable. */
const ENHANCED_COMPATIBILITY_ENABLED = false;

/**
 * Whether the given ecosystem/model pair runs through sdcpp and qualifies for
 * the 2-for-1 quantity bonus. Superset of `supportsEnhancedCompatibility` —
 * includes ecosystems without the `enhancedCompatibility` toggle, minus
 * specific model versions excluded via SDCPP_EXCLUDED_MODEL_IDS.
 */
function supportsSdcpp(ecosystem: string, modelId?: number): boolean {
  if (!SDCPP_SUPPORTED_ECOSYSTEMS.includes(ecosystem)) return false;
  if (modelId !== undefined && SDCPP_EXCLUDED_MODEL_IDS.includes(modelId)) return false;
  return true;
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

type EcosystemGateExt = Pick<
  GenerationCtx,
  'selfHostedDisabledEcosystems' | 'selfHostedMode' | 'gateRules'
>;

/**
 * Resolve the unified gate state for the workflow's ecosystems. Folds the gate
 * sources — the self-hosted toggle (disable / memberOnly) and the rules model
 * (`gateRules`, which can also hide) — into one per-ecosystem `GateState` via
 * `pickStrongerGate`, then splits by what the picker needs:
 *   - `compatibleEcosystems` — workflow-compatible, minus hidden.
 *   - `hiddenEcosystems` — every hidden key, so the "All" search can drop them
 *     too (not just the compatible list).
 *   - `ecosystemStates` — compatible keys that are shown-but-disabled, each with
 *     its state (`disabled`/`memberOnly`) + optional message.
 *
 * Shared by the node factory (schemas/defaultValue) and its `meta` function so
 * they never diverge. Reads gating from `ext`, populated async by
 * `getGenerationConfig` — hence `meta` must call this on every `setExt`.
 */
function getEcosystemStates(
  workflow: string,
  ext: EcosystemGateExt
): {
  compatibleEcosystems: string[];
  hiddenEcosystems: string[];
  ecosystemStates: GateItemState[];
} {
  const states = new Map<string, GateResolution>();
  const selfHostedState: GateState =
    ext.selfHostedMode === 'memberOnly' ? 'memberOnly' : 'disabled';
  for (const key of ext.selfHostedDisabledEcosystems ?? [])
    states.set(key, pickStrongerGate(states.get(key), { state: selfHostedState }));
  for (const [key, res] of rulesToStates(ext.gateRules ?? []).ecosystems)
    states.set(key, pickStrongerGate(states.get(key), res));

  const hiddenEcosystems = [...states].filter(([, r]) => r.state === 'hidden').map(([key]) => key);
  const hiddenSet = new Set(hiddenEcosystems);
  const compatibleEcosystems = getEcosystemsForWorkflow(workflow)
    .map((id) => ecosystemById.get(id)?.key)
    .filter((key): key is string => !!key && !hiddenSet.has(key));
  const compatibleSet = new Set(compatibleEcosystems);

  const ecosystemStates = [...states]
    .filter(([key, r]) => r.state !== 'hidden' && compatibleSet.has(key))
    .map(([key, r]) => ({ key, state: r.state as 'disabled' | 'memberOnly', message: r.message }));

  return { compatibleEcosystems, hiddenEcosystems, ecosystemStates };
}

export const ecosystemGraph = new DataGraph<
  { workflow: string; output: 'image' | 'video' | 'audio'; input: 'text' | 'image' | 'video' },
  GenerationCtx
>()
  // ecosystem depends on workflow to filter compatible ecosystems
  .node(
    'ecosystem',
    (ctx, ext) => {
      // Resolve the unified gate state for the workflow's ecosystems (legacy
      // gated + self-hosted toggle + rules model, merged). Server enforces the
      // same gate via `buildGenerationContext`, but resolving here keeps the UI
      // honest and prevents validated submissions referencing a gated ecosystem.
      // Compute against the factory-time ext for the input/output schemas and
      // default value. NOTE: the node factory only re-runs on its deps
      // (`workflow`/`output`), not on async `ext` changes — so `meta` below is
      // a FUNCTION, which `_updateAllMeta` re-invokes with the live ext whenever
      // `setExt` fires (e.g. when `getGenerationConfig` resolves). Keep the
      // derivation in a shared helper so both stay in sync.
      const { compatibleEcosystems, hiddenEcosystems, ecosystemStates } = getEcosystemStates(
        ctx.workflow,
        ext
      );
      const hiddenSet = new Set(hiddenEcosystems);
      const disabledSet = new Set(ecosystemStates.map((e) => e.key));
      // Default ecosystem by output type — prefer the type-default, but skip any
      // gated ecosystem (hidden already filtered out, plus disabled/memberOnly)
      // so a fresh form doesn't land on an unusable selection. Fall through to
      // the first usable, then any compatible, then SDXL.
      const outputDefault =
        ctx.output === 'audio' ? 'Ace' : ctx.output === 'video' ? 'Kling' : 'ZImageTurbo';
      const usableEcosystems = disabledSet.size
        ? compatibleEcosystems.filter((key) => !disabledSet.has(key))
        : compatibleEcosystems;
      const defaultValue = usableEcosystems.includes(outputDefault)
        ? outputDefault
        : usableEcosystems[0] ?? compatibleEcosystems[0] ?? 'SDXL';

      return {
        input: z
          .string()
          .optional()
          .transform((v) => {
            if (!v) return undefined;
            // Drop hidden values at the input boundary so a stale stored ecosystem
            // (e.g. localStorage from before it was gated) falls back to default.
            // Disabled/memberOnly values are intentionally kept so the picker can
            // show them disabled and the alert can explain why.
            if (hiddenSet.has(v)) return undefined;
            return v;
          }),
        output:
          hiddenSet.size || disabledSet.size
            ? z.string().refine((v) => !hiddenSet.has(v) && !disabledSet.has(v), {
                message: 'Ecosystem is currently unavailable',
              })
            : z.string(),
        defaultValue,
        // Function form so meta tracks live `ext` (async config) — see note above.
        meta: (metaCtx, metaExt) => {
          const lists = getEcosystemStates(metaCtx.workflow, metaExt);
          return {
            compatibleEcosystems: lists.compatibleEcosystems,
            hiddenEcosystems: lists.hiddenEcosystems,
            ecosystemStates: lists.ecosystemStates,
            mediaType: metaCtx.output, // 'image' or 'video'
          };
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
    { values: ['HiDream-O1'] as const, graph: hiDreamO1Graph },
    { values: ['PonyV7'] as const, graph: ponyV7Graph },
    { values: ['Anima'] as const, graph: animaGraph },
    { values: ['Ernie'] as const, graph: ernieGraph },
    { values: ['Lens'] as const, graph: lensGraph },
    { values: ['Krea2'] as const, graph: krea2Graph },
    { values: ['MAI'] as const, graph: maiGraph },
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
    { values: ['HappyHorse'] as const, graph: happyHorseGraph },
    // Audio ecosystems
    { values: ['Ace'] as const, graph: aceAudioGraph },
  ])
  // Enhanced compatibility mode - txt2img only, supported ecosystems, hidden for Flux Ultra
  .node(
    'enhancedCompatibility',
    (ctx) => {
      const modelId = 'model' in ctx ? ctx.model?.id : undefined;
      return {
        ...enhancedCompatibilityNode(),
        when:
          ENHANCED_COMPATIBILITY_ENABLED &&
          ctx.workflow === 'txt2img' &&
          supportsEnhancedCompatibility(ctx.ecosystem, modelId),
      };
    },
    ['workflow', 'ecosystem', 'model']
  )
  // Quantity node - shown for image output, plus the small set of video
  // ecosystems that batch multiple outputs in a single job (currently LTXV23,
  // which generates extra videos via Seed + slotIndex).
  //
  // Step: draft=4, BOGO-enabled w/ enhancedCompatibility off=2, else=1.
  // The step=2 path is gated by the `enhancedCompatibilitySdcpp` feature flag and
  // limited to txt2img (matches the `enhancedCompatibility` toggle's visibility).
  .node(
    'quantity',
    (ctx, ext) => {
      const isDraft = ctx.workflow === 'txt2img:draft';
      const modelId = 'model' in ctx ? ctx.model?.id : undefined;
      const bogoActive =
        !!ext.flags?.enhancedCompatibilitySdcpp &&
        ctx.workflow === 'txt2img' &&
        supportsSdcpp(ctx.ecosystem, modelId) &&
        ctx.enhancedCompatibility !== true;
      const step = isDraft ? 4 : bogoActive ? 2 : 1;
      const supportsVideoQuantity = ctx.output === 'video' && ctx.ecosystem === 'LTXV23';
      // LTXV23 uses tier-gated vidQuantity (free=1, bronze=2, silver=3, gold=4)
      // so the upsell popover can fire when non-gold users try to bump past
      // their cap. Other ecosystems keep the standard maxQuantity.
      const max = ctx.ecosystem === 'LTXV23' ? ext.limits.vidQuantity : ext.limits.maxQuantity;
      return {
        ...quantityNode({ step, max }),
        when: ctx.output === 'image' || supportsVideoQuantity,
      };
    },
    // `ext:limits` tracks live getStatus quantity caps (maxQuantity / vidQuantity);
    // `ext:flags` tracks the enhancedCompatibilitySdcpp toggle that drives the bogo step.
    ['workflow', 'output', 'ecosystem', 'model', 'enhancedCompatibility', 'ext:limits', 'ext:flags']
  );

// Prompt + triggerWords are now defined per-ecosystem inside each subgraph
// (see common.ts: promptGraph, negativePromptGraph, triggerWordsGraph,
// createTextEditorGraph). Each ecosystem owns its own validation rule and
// merges triggerWordsGraph after model/resources so the dep system propagates
// correctly.
