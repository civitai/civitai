/**
 * HappyHorse Graph
 *
 * Controls for HappyHorse video generation ecosystem (Alibaba Taotian).
 * Version-selectable (v1.0 / v1.1) via the model picker; the handler maps the
 * selected model version id to the @civitai/client engine version.
 *
 * Workflows (vid2vid:edit is v1.0-only — excluded for v1.1 in config/workflows.ts):
 * - txt2vid           → operation 'textToVideo'
 * - img2vid           → operation 'imageToVideo' (single first frame)
 * - img2vid:ref2vid   → operation 'referenceToVideo' (1-9 reference images)
 * - vid2vid:edit      → operation 'videoEdit' (source video + optional reference images)
 *
 * Nodes:
 * - images: workflow-dependent (hidden for txt2vid, single for img2vid, up to 9 for ref2vid / vid2vid:edit)
 * - video: shown only for vid2vid:edit (sourceVideo)
 * - aspectRatio: shown for txt2vid and img2vid:ref2vid (img2vid + vid2vid:edit infer from input)
 * - resolution: 720p / 1080p
 * - duration: slider 3-15 seconds
 * - audioSetting: shown only for vid2vid:edit (auto / origin)
 * - seed
 *
 * The model swap button is locked via ecosystemSettings (modelLocked); users
 * still pick between the official v1.0 / v1.1 versions.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  enumNode,
  imagesNode,
  promptGraph,
  seedNode,
  sliderNode,
  snippetsGraph,
  triggerWordsGraph,
  videoNode,
} from './common';
import { isWorkflowOrVariant } from './config/workflows';
import {
  getAspectRatioOptions,
  type GenerationAspectRatio,
} from '~/shared/constants/generation.constants';
import { happyHorseVersionIds } from './version-ids';

// =============================================================================
// Constants
// =============================================================================

const happyHorseAspectRatioList: GenerationAspectRatio[] = ['16:9', '4:3', '1:1', '3:4', '9:16'];

// v1.1 accepts a wider ratio set than v1.0 (adds 21:9, 5:4, 4:5). The API also
// accepts 9:21, but Civitai's shared GenerationAspectRatio tables don't define
// it, so it isn't exposed here.
const happyHorseV1_1AspectRatioList: GenerationAspectRatio[] = [
  ...happyHorseAspectRatioList,
  '21:9',
  '5:4',
  '4:5',
];

/** Preferred ratios shown before the "More" overflow for the wider v1.1 set */
const happyHorseV1_1PriorityRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

/** Options for the HappyHorse version selector (using version IDs as values) */
const happyHorseVersionOptions = [
  { label: 'v1.0', value: happyHorseVersionIds['v1.0'] },
  { label: 'v1.1', value: happyHorseVersionIds['v1.1'] },
];

/** True when the selected model version is HappyHorse v1.1 */
const isHappyHorseV1_1 = (modelId?: number) => modelId === happyHorseVersionIds['v1.1'];

/** Default happy horse aspect ratios (720p) — exported for legacy consumers */
const happyHorseAspectRatios = getAspectRatioOptions('720p', happyHorseAspectRatioList);

/** HappyHorse resolution options */
const happyHorseResolutions = [
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
] as const;

/** HappyHorse audioSetting options (vid2vid:edit only) */
const happyHorseAudioSettings = [
  { label: 'Auto', value: 'auto' },
  { label: 'Origin', value: 'origin' },
] as const;

// =============================================================================
// HappyHorse Graph
// =============================================================================

/** Context shape for happy horse graph */
type HappyHorseCtx = { ecosystem: string; workflow: string };

export const happyHorseGraph = new DataGraph<HappyHorseCtx, GenerationCtx>()
  // Version-locked model (v1.0 / v1.1) — picker shows the official versions,
  // swap button hidden via modelLocked in ecosystemSettings. Defaults to v1.1.
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: happyHorseVersionOptions },
        defaultModelId: happyHorseVersionIds['v1.1'],
      }),
    []
  )

  // Images node — workflow-dependent
  .node(
    'images',
    (ctx) => {
      if (ctx.workflow === 'img2vid:ref2vid') {
        return { ...imagesNode({ max: 9, warnOnMissingAiMetadata: true }), when: true };
      }
      if (ctx.workflow === 'vid2vid:edit') {
        return { ...imagesNode({ max: 9 }), when: true };
      }
      if (isWorkflowOrVariant(ctx.workflow, 'img2vid')) {
        return { ...imagesNode({ max: 1, warnOnMissingAiMetadata: true }), when: true };
      }
      // txt2vid — hide
      return { ...imagesNode(), when: false };
    },
    ['workflow']
  )

  // Video node — shown only for vid2vid:edit (sourceVideo)
  .node(
    'video',
    (ctx) => ({
      ...videoNode(),
      when: ctx.workflow === 'vid2vid:edit',
    }),
    ['workflow']
  )

  // Resolution (declared before aspectRatio so dimensions can scale with it)
  .node(
    'resolution',
    enumNode({
      options: happyHorseResolutions,
      defaultValue: '720p',
    })
  )

  // Aspect ratio — shown for txt2vid and img2vid:ref2vid only; dimensions scale
  // with resolution and the option set widens for v1.1.
  .node(
    'aspectRatio',
    (ctx) => {
      const v11 = isHappyHorseV1_1(ctx.model?.id);
      return {
        ...aspectRatioNode({
          options: getAspectRatioOptions(
            ctx.resolution,
            v11 ? happyHorseV1_1AspectRatioList : happyHorseAspectRatioList
          ),
          defaultValue: '16:9',
          priorityOptions: v11 ? happyHorseV1_1PriorityRatios : undefined,
        }),
        when: ctx.workflow === 'txt2vid' || ctx.workflow === 'img2vid:ref2vid',
      };
    },
    ['workflow', 'resolution', 'model']
  )

  // Duration (3-15 seconds)
  .node('duration', sliderNode({ min: 3, max: 15, defaultValue: 5 }))

  // Audio setting — only for vid2vid:edit
  .node(
    'audioSetting',
    (ctx) => ({
      ...enumNode({ options: happyHorseAudioSettings, defaultValue: 'auto' }),
      when: ctx.workflow === 'vid2vid:edit',
    }),
    ['workflow']
  )

  // Seed
  .node('seed', seedNode())

  // Prompt + triggerWords (no negativePrompt for happyHorse)
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph);

// Export constants for use in components
export { happyHorseAspectRatios, happyHorseResolutions, happyHorseAudioSettings };
