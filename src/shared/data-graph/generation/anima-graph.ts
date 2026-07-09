/**
 * Anima Family Graph
 *
 * Controls for Anima ecosystem (CircleStone Labs).
 * Uses sdcpp engine with support for negative prompts, samplers, and schedules.
 *
 * Two models discriminated by animaVariant (computed from model.id):
 * - base: cfg 7, steps 25
 * - turbo: cfg 1, steps 8, tight ranges (distilled build)
 *
 * Only cfgScale/steps differ per variant; sampler, scheduler, resources (LoRA),
 * and controlNets are shared parent-level nodes.
 */

import type { SdCppSampleMethod, SdCppSchedule } from '@civitai/client';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import type { ResourceData } from './common';
import {
  aspectRatioNode,
  controlNetsNode,
  CONTROLNET_LIMIT,
  createCheckpointGraph,
  createResourcesGraph,
  negativePromptGraph,
  promptGraph,
  samplerNode,
  schedulerNode,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
} from './common';
import { sdxlAspectRatioBuckets } from '~/shared/constants/generation.constants';
import { animaControlNetPreprocessors } from '~/shared/constants/controlnets.constants';

// =============================================================================
// Constants
// =============================================================================

/** Anima version IDs */
export const animaVersionIds = {
  anima: 2945208,
  turbo: 3108589,
} as const;

type AnimaVariant = 'base' | 'turbo';

/**
 * Map version ID to variant. Only the turbo version is mapped; every other
 * Anima version (incl. the default and any future ones) falls back to 'base'
 * in the computed below, keeping the standard cfgScale/steps defaults.
 */
const versionIdToVariant = new Map<number, AnimaVariant>([
  [animaVersionIds.turbo, 'turbo'],
]);

// =============================================================================
// Sampler & Schedule Options
// =============================================================================

// Note: dpm++2s_a is omitted because it is incompatible with all available schedules.
// karras and exponential are omitted because they are incompatible with most samplers
// (euler, heun, dpm++2m, dpm++2mv2). See anima-graph sampler/scheduler compatibility.
const animaSamplers: SdCppSampleMethod[] = [
  'er_sde',
  'euler',
  'euler_a',
  'heun',
  'dpm2',
  'dpm++2m',
  'dpm++2mv2',
];

const animaSamplerPresets = [
  { label: 'Fast', value: 'euler' },
  { label: 'Quality', value: 'dpm++2m' },
];

const animaSchedules: SdCppSchedule[] = ['simple', 'sgm_uniform'];

// =============================================================================
// Variant Subgraphs
// =============================================================================

/** Base model: cfg 7, steps 25 */
const baseGraph = new DataGraph<{ ecosystem: string }, GenerationCtx>()
  .node('cfgScale', sliderNode({ min: 1, max: 20, defaultValue: 7, step: 0.5 }))
  .node('steps', sliderNode({ min: 8, max: 50, defaultValue: 25 }));

/** Turbo model: cfg 1 (tight 1-2 range), steps 8 — distilled build */
const turboGraph = new DataGraph<{ ecosystem: string }, GenerationCtx>()
  .node('cfgScale', sliderNode({ min: 1, max: 2, step: 0.1, defaultValue: 1 }))
  .node('steps', sliderNode({ min: 1, max: 15, defaultValue: 8 }));

// =============================================================================
// Anima Graph
// =============================================================================

/**
 * Anima ecosystem controls.
 * Supports negative prompts, samplers, schedules, and cfg scale.
 *
 * Discriminates on animaVariant (computed from model.id) to select base vs turbo subgraph.
 */
export const animaGraph = new DataGraph<
  { ecosystem: string; workflow: string; model: ResourceData },
  GenerationCtx
>()
  .merge(
    () =>
      createCheckpointGraph({
        defaultModelId: animaVersionIds.anima,
      }),
    []
  )
  .merge(createResourcesGraph())
  .node('seed', seedNode())
  .node('aspectRatio', aspectRatioNode({ options: sdxlAspectRatioBuckets, defaultValue: '1:1' }))
  .computed(
    'animaVariant',
    (ctx) => (ctx.model?.id ? versionIdToVariant.get(ctx.model.id) : undefined) ?? 'base',
    ['model']
  )
  .discriminator('animaVariant', {
    base: baseGraph,
    turbo: turboGraph,
  })
  .node(
    'sampler',
    samplerNode({ options: animaSamplers, defaultValue: 'euler_a', presets: animaSamplerPresets })
  )
  .node('scheduler', schedulerNode({ options: animaSchedules, defaultValue: 'simple' }))
  // ControlNets — txt2img only, gated by the `animaControlnet` kill-switch flag
  // (fail-open: shown unless the flag is explicitly false).
  .node(
    'controlNets',
    (ctx, ext) => ({
      ...controlNetsNode({ preprocessors: animaControlNetPreprocessors, limit: CONTROLNET_LIMIT }),
      when: ctx.workflow === 'txt2img' && ext.flags?.animaControlnet !== false,
    }),
    ['workflow', 'ext:flags']
  )
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .merge(negativePromptGraph);
