/**
 * LTXV23 Graph
 *
 * Controls for LTX Video 2.3 generation ecosystem.
 * Advanced video generation model from Lightricks.
 *
 * Workflows:
 * - txt2vid: Text to video generation (ComfyLtx23CreateVideoInput)
 * - img2vid: First/last frame guided video generation (ComfyLtx23FirstLastFrameToVideoInput)
 * - vid2vid:edit: Edit video with Canny edge control (ComfyLtx23EditVideoInput)
 * - vid2vid:extend: Extend an existing video (ComfyLtx23ExtendVideoInput)
 *
 * Nodes:
 * - images: Workflow-dependent image input (img2vid only)
 * - video: Source video input (vid2vid:edit and vid2vid:extend)
 * - seed: Optional seed for reproducibility
 * - aspectRatio: Output aspect ratio (hidden when video source provided)
 * - cfgScale: CFG scale for generation control
 * - duration: Video duration
 * - steps: Number of inference steps
 * - frameGuideStrength: Frame guide conditioning strength (img2vid only)
 * - cannyLowThreshold: Canny low threshold (vid2vid:edit only)
 * - cannyHighThreshold: Canny high threshold (vid2vid:edit only)
 * - guideStrength: Guide strength for video editing (vid2vid:edit only)
 * - numFrames: Number of frames to extend (vid2vid:extend only)
 * - resources: Additional LoRAs
 */

import { z } from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  seedNode,
  aspectRatioNode,
  sliderNode,
  enumNode,
  imagesNode,
  videoNode,
  resourcesNode,
  createCheckpointGraph,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** LTXV23 model version options */
const ltxv23VersionOptions = [
  { label: 'Dev', value: 2749908 },
  { label: 'Distilled', value: 2749948 },
];

/** LTXV23 aspect ratio options (same as LTXV2) */
const ltxv23AspectRatios = [
  { label: '16:9', value: '16:9', width: 848, height: 480 },
  { label: '3:2', value: '3:2', width: 720, height: 480 },
  { label: '1:1', value: '1:1', width: 512, height: 512 },
  { label: '2:3', value: '2:3', width: 480, height: 720 },
  { label: '9:16', value: '9:16', width: 480, height: 848 },
];

/** LTXV23 duration options */
const ltxv23Durations = [
  { label: '3 seconds', value: 3 },
  { label: '5 seconds', value: 5 },
];

// =============================================================================
// LTXV23 Graph
// =============================================================================

/** Context shape for LTXV23 graph */
type LTXV23Ctx = {
  ecosystem: string;
  workflow: string;
};

/**
 * LTXV23 video generation controls.
 *
 * Workflow-specific behavior:
 * - txt2vid: Text to video with optional source image and LoRA support
 * - img2vid: First/last frame guided generation with frameGuideStrength
 * - vid2vid:edit: Edit existing video using Canny edge control
 * - vid2vid:extend: Extend an existing video with new content
 */
export const ltxv23Graph = new DataGraph<LTXV23Ctx, GenerationCtx>()
  // Video node - source video for vid2vid:edit and vid2vid:extend
  .node(
    'video',
    (ctx) => ({
      ...videoNode(),
      when: ctx.workflow === 'vid2vid:edit' || ctx.workflow === 'vid2vid:extend',
    }),
    ['workflow']
  )

  // Images node - first/last frame slots for img2vid, reference image for ref2vid
  .node(
    'images',
    (ctx) => {
      if (ctx.workflow === 'img2vid') {
        return {
          ...imagesNode({
            slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
            warnOnMissingAiMetadata: true,
            aspectRatios: ltxv23AspectRatios.map((a) => a.value as `${number}:${number}`),
          }),
          when: true,
        };
      }
      if (ctx.workflow === 'img2vid:ref2vid') {
        return {
          ...imagesNode({
            warnOnMissingAiMetadata: true,
          }),
          when: true,
        };
      }
      return { ...imagesNode(), when: false };
    },
    ['workflow']
  )

  // Merge checkpoint graph with version options
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: ltxv23VersionOptions },
        defaultModelId: ltxv23VersionOptions[0].value,
      }),
    []
  )

  // Seed node
  .node('seed', seedNode())

  // Aspect ratio node - only for txt2vid (img2vid uses image crop, vid2vid uses source video)
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: ltxv23AspectRatios, defaultValue: '16:9' }),
      when: ctx.workflow === 'txt2vid' || ctx.workflow === 'img2vid:ref2vid',
    }),
    ['workflow']
  )

  // CFG scale node
  .node(
    'cfgScale',
    sliderNode({
      min: 1,
      max: 10,
      step: 0.5,
      defaultValue: 3,
      presets: [
        { label: 'Low', value: 2 },
        { label: 'Balanced', value: 3 },
        { label: 'High', value: 5 },
      ],
    })
  )

  // Duration node
  .node('duration', enumNode({ options: ltxv23Durations, defaultValue: 5 }))

  // Steps node
  .node(
    'steps',
    sliderNode({
      min: 10,
      max: 50,
      defaultValue: 30,
      presets: [
        { label: 'Fast', value: 20 },
        { label: 'Balanced', value: 30 },
        { label: 'Quality', value: 50 },
      ],
    })
  )

  // Frame guide strength - img2vid only (first/last frame conditioning)
  .node(
    'frameGuideStrength',
    (ctx) => ({
      ...sliderNode({
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 1,
        presets: [
          { label: 'Subtle', value: 0.3 },
          { label: 'Moderate', value: 0.6 },
          { label: 'Strong', value: 1 },
        ],
      }),
      when: ctx.workflow === 'img2vid' && ctx.images?.length === 2,
    }),
    ['workflow']
  )

  // Canny low threshold - vid2vid:edit only
  .node(
    'cannyLowThreshold',
    (ctx) => ({
      ...sliderNode({
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 0.1,
        presets: [
          { label: 'Low', value: 0.05 },
          { label: 'Medium', value: 0.1 },
          { label: 'High', value: 0.2 },
        ],
      }),
      when: ctx.workflow === 'vid2vid:edit',
    }),
    ['workflow']
  )

  // Canny high threshold - vid2vid:edit only
  .node(
    'cannyHighThreshold',
    (ctx) => ({
      ...sliderNode({
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: 0.3,
        presets: [
          { label: 'Low', value: 0.15 },
          { label: 'Medium', value: 0.3 },
          { label: 'High', value: 0.5 },
        ],
      }),
      when: ctx.workflow === 'vid2vid:edit',
    }),
    ['workflow']
  )

  // Guide strength - vid2vid:edit only
  .node(
    'guideStrength',
    (ctx) => ({
      ...sliderNode({
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.7,
        presets: [
          { label: 'Subtle', value: 0.3 },
          { label: 'Moderate', value: 0.7 },
          { label: 'Strong', value: 1 },
        ],
      }),
      when: ctx.workflow === 'vid2vid:edit',
    }),
    ['workflow']
  )

  // Num frames - vid2vid:extend only
  .node(
    'numFrames',
    (ctx) => ({
      input: z.coerce.number().min(1).max(120).optional(),
      output: z.number().min(1).max(120),
      defaultValue: 24,
      meta: { min: 1, max: 120, step: 1 },
      when: ctx.workflow === 'vid2vid:extend',
    }),
    ['workflow']
  )

  // Resources node (LoRAs)
  .node(
    'resources',
    (ctx, ext) =>
      resourcesNode({
        ecosystem: ctx.ecosystem,
        limit: ext.limits.maxResources,
      }),
    ['ecosystem']
  );

// Export constants for use in components
export { ltxv23AspectRatios, ltxv23Durations, ltxv23VersionOptions };
