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
  createCheckpointGraph,
  negativePromptNode,
  samplerNode,
  schedulerNode,
  seedNode,
  sliderNode,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** Anima default model version ID */
const animaVersionId = 2836417;

// =============================================================================
// Aspect Ratios
// =============================================================================

/** Anima aspect ratios (1024px based) */
const animaAspectRatios = [
  { label: '2:3', value: '2:3', width: 832, height: 1216 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '3:2', value: '3:2', width: 1216, height: 832 },
];

// =============================================================================
// Sampler & Schedule Options
// =============================================================================

const animaSamplers: SdCppSampleMethod[] = [
  'euler',
  'euler_a',
  'heun',
  'dpm2',
  'dpm++2s_a',
  'dpm++2m',
  'dpm++2mv2',
];

const animaSamplerPresets = [
  { label: 'Fast', value: 'euler' },
  { label: 'Quality', value: 'dpm++2m' },
];

const animaSchedules: SdCppSchedule[] = ['simple', 'karras', 'exponential', 'sgm_uniform'];

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
  .node('seed', seedNode())
  .node('aspectRatio', aspectRatioNode({ options: animaAspectRatios, defaultValue: '1:1' }))
  .node('cfgScale', sliderNode({ min: 1, max: 20, defaultValue: 7, step: 0.5 }))
  .node('steps', sliderNode({ min: 10, max: 50, defaultValue: 25 }))
  .node(
    'sampler',
    samplerNode({ options: animaSamplers, defaultValue: 'euler', presets: animaSamplerPresets })
  )
  .node('scheduler', schedulerNode({ options: animaSchedules, defaultValue: 'simple' }))
  .node('negativePrompt', negativePromptNode());
