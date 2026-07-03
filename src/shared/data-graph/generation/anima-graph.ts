/**
 * Anima Family Graph
 *
 * Controls for Anima ecosystem (CircleStone Labs).
 * Uses sdcpp engine with support for negative prompts, samplers, and schedules.
 */

import type { SdCppSampleMethod, SdCppSchedule } from '@civitai/client';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
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

/** Anima default model version ID */
const animaVersionId = 2945208;

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
// Anima Graph
// =============================================================================

/**
 * Anima ecosystem controls.
 * Supports negative prompts, samplers, schedules, and cfg scale.
 */
export const animaGraph = new DataGraph<{ ecosystem: string; workflow: string }, GenerationCtx>()
  .merge(
    () =>
      createCheckpointGraph({
        defaultModelId: animaVersionId,
      }),
    []
  )
  .merge(createResourcesGraph())
  .node('seed', seedNode())
  .node('aspectRatio', aspectRatioNode({ options: sdxlAspectRatioBuckets, defaultValue: '1:1' }))
  .node('cfgScale', sliderNode({ min: 1, max: 20, defaultValue: 7, step: 0.5 }))
  .node('steps', sliderNode({ min: 8, max: 50, defaultValue: 25 }))
  .node(
    'sampler',
    samplerNode({ options: animaSamplers, defaultValue: 'euler_a', presets: animaSamplerPresets })
  )
  .node('scheduler', schedulerNode({ options: animaSchedules, defaultValue: 'simple' }))
  // ControlNets — only available for txt2img workflows.
  .node(
    'controlNets',
    (ctx) => ({
      ...controlNetsNode({ preprocessors: animaControlNetPreprocessors, limit: CONTROLNET_LIMIT }),
      when: ctx.workflow === 'txt2img',
    }),
    ['workflow']
  )
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .merge(negativePromptGraph);
