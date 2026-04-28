/**
 * HappyHorse Graph
 *
 * Controls for HappyHorse video generation ecosystem (Alibaba Taotian).
 * Single version (v1.0) with four operations selected via workflow.
 *
 * Workflows:
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
 * NOTE: No model node — HappyHorse has no Civitai version published yet.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  enumNode,
  imagesNode,
  seedNode,
  sliderNode,
  videoNode,
} from './common';
import { isWorkflowOrVariant } from './config/workflows';

// =============================================================================
// Constants
// =============================================================================

/** HappyHorse aspect ratio options (dimensions aligned to 720p) */
const happyHorseAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '4:3', value: '4:3', width: 960, height: 720 },
  { label: '1:1', value: '1:1', width: 720, height: 720 },
  { label: '3:4', value: '3:4', width: 720, height: 960 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

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

  // Aspect ratio — shown for txt2vid and img2vid:ref2vid only
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: happyHorseAspectRatios, defaultValue: '16:9' }),
      when: ctx.workflow === 'txt2vid' || ctx.workflow === 'img2vid:ref2vid',
    }),
    ['workflow']
  )

  // Resolution
  .node(
    'resolution',
    enumNode({
      options: happyHorseResolutions,
      defaultValue: '720p',
    })
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
  .node('seed', seedNode());

// Export constants for use in components
export { happyHorseAspectRatios, happyHorseResolutions, happyHorseAudioSettings };
