/**
 * LTX Graph (LTXV2 + LTXV23)
 *
 * Consolidated controls for LTX Video 2 and LTX Video 2.3 ecosystems.
 * Both ecosystems are bound to this single graph; the model selector exposes
 * versions for both, and picking a version switches the active ecosystem
 * via the model node's baseModel transform.
 *
 * Architecture:
 * - Parent graph holds shared nodes (model, seed, cfgScale, steps,
 *   frameGuideStrength, resources) and the combined version selector.
 * - `.discriminator('ecosystem', ...)` routes to per-ecosystem subgraphs:
 *   - ltxv2SubGraph: aspectRatio (v2), duration (enum)
 *   - ltxv23SubGraph: video, resolution, aspectRatio (v23), duration (slider),
 *     canny*, guideStrength, numFrames, generateAudio
 *
 * Workflows:
 * - txt2vid: Text to video generation (both)
 * - img2vid: First/last frame guided video generation (both)
 * - img2vid:ref2vid: Reference image to video (LTXV23 only)
 * - vid2vid:edit: Edit existing video using Canny edge control (LTXV23 only)
 * - vid2vid:extend: Extend an existing video (LTXV23 only)
 */

import { z } from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import type { AspectRatioOption, VersionGroup } from './common';
import {
  seedNode,
  aspectRatioNode,
  sliderNode,
  enumNode,
  imagesNode,
  videoNode,
  createResourcesGraph,
  createCheckpointGraph,
} from './common';
import { isWorkflowOrVariant } from './config/workflows';

// =============================================================================
// Constants
// =============================================================================

/** LTXV2 model version IDs */
const LTXV2_DEV_ID = 2578325;
const LTXV2_DISTILLED_ID = 2600562;

/** LTXV23 model version IDs */
const LTXV23_DEV_ID = 2749908;
const LTXV23_DISTILLED_ID = 2749948;

/** Set of all distilled version IDs (across both ecosystems) */
const DISTILLED_IDS = new Set<number>([LTXV2_DISTILLED_ID, LTXV23_DISTILLED_ID]);

/**
 * Hierarchical version options for the model selector.
 * Top level: LTX version (2.0 / 2.3). Selecting a top-level option also
 * switches the active ecosystem via `baseModel`.
 * Second level: variant (Dev / Distilled).
 */
const ltxVersionOptions: VersionGroup = {
  label: 'Version',
  options: [
    {
      label: '2.0',
      value: LTXV2_DEV_ID,
      baseModel: 'LTXV2',
      children: {
        label: 'Variant',
        options: [
          { label: '19B Dev', value: LTXV2_DEV_ID, baseModel: 'LTXV2' },
          { label: '19B Distilled', value: LTXV2_DISTILLED_ID, baseModel: 'LTXV2' },
        ],
      },
    },
    {
      label: '2.3',
      value: LTXV23_DEV_ID,
      baseModel: 'LTXV23',
      children: {
        label: 'Variant',
        options: [
          { label: 'Dev', value: LTXV23_DEV_ID, baseModel: 'LTXV23' },
          { label: 'Distilled', value: LTXV23_DISTILLED_ID, baseModel: 'LTXV23' },
        ],
      },
    },
  ],
};

/** LTXV2 aspect ratio options */
const ltxv2AspectRatios: AspectRatioOption[] = [
  { label: '16:9', value: '16:9', width: 848, height: 480 },
  { label: '3:2', value: '3:2', width: 720, height: 480 },
  { label: '1:1', value: '1:1', width: 512, height: 512 },
  { label: '2:3', value: '2:3', width: 480, height: 720 },
  { label: '9:16', value: '9:16', width: 480, height: 848 },
];

/** LTXV2 duration options */
const ltxv2Durations = [
  { label: '3 seconds', value: 3 },
  { label: '5 seconds', value: 5 },
  { label: '7 seconds', value: 7 },
];

/** LTXV23 aspect ratio options by resolution */
const ltxv23AspectRatiosByResolution: Record<string, AspectRatioOption[]> = {
  '720p': [
    { label: '16:9', value: '16:9', width: 1280, height: 720 },
    { label: '3:2', value: '3:2', width: 1176, height: 784 },
    { label: '1:1', value: '1:1', width: 960, height: 960 },
    { label: '2:3', value: '2:3', width: 784, height: 1176 },
    { label: '9:16', value: '9:16', width: 720, height: 1280 },
  ],
  '1080p': [
    { label: '16:9', value: '16:9', width: 1920, height: 1080 },
    { label: '3:2', value: '3:2', width: 1764, height: 1176 },
    { label: '1:1', value: '1:1', width: 1440, height: 1440 },
    { label: '2:3', value: '2:3', width: 1176, height: 1764 },
    { label: '9:16', value: '9:16', width: 1080, height: 1920 },
  ],
};

/** Default aspect ratios (720p) */
const ltxv23AspectRatios = ltxv23AspectRatiosByResolution['720p'];

/** LTXV23 resolution options */
const ltxv23Resolutions = [
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
];

/** Max duration per resolution (LTXV23) */
const ltxv23MaxDurationByResolution: Record<string, number> = {
  '720p': 20,
  '1080p': 15,
};

/**
 * Aspect ratio values shared by both ecosystems (used by the parent-level
 * `images` node for upload-time aspect ratio hints). Both LTXV2 and LTXV23
 * support the same set of ratio strings; only the resolved pixel dimensions
 * differ, which is handled per-ecosystem in the handler.
 */
const sharedAspectRatioValues: `${number}:${number}`[] = ['16:9', '3:2', '1:1', '2:3', '9:16'];

// =============================================================================
// Types
// =============================================================================

/** LTX version discriminator — derived from `ecosystem`. */
type LTXVersion = 'v2' | 'v23';

type LTXCtx = { ecosystem: string; workflow: string };

/** Context shape passed to LTX version subgraphs (includes the computed discriminator) */
type LTXVersionCtx = LTXCtx & { ltxVersion: LTXVersion };

// =============================================================================
// LTXV2 Subgraph
// =============================================================================

const ltxv2SubGraph = new DataGraph<LTXVersionCtx, GenerationCtx>()
  // Aspect ratio - hidden for img2vid (driven by uploaded image)
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: ltxv2AspectRatios, defaultValue: '16:9' }),
      when: ctx.workflow !== 'img2vid',
    }),
    ['workflow']
  )

  // Duration - enum (3 / 5 / 7 seconds)
  .node('duration', enumNode({ options: ltxv2Durations, defaultValue: 5 }));

// =============================================================================
// LTXV23 Subgraph
// =============================================================================

const ltxv23SubGraph = new DataGraph<LTXVersionCtx, GenerationCtx>()
  // Source video for vid2vid:edit and vid2vid:extend
  .node(
    'video',
    (ctx) => ({
      ...videoNode(),
      when: ctx.workflow === 'vid2vid:edit' || ctx.workflow === 'vid2vid:extend',
    }),
    ['workflow']
  )

  // Resolution selector
  .node('resolution', {
    input: z.enum(['720p', '1080p']).optional(),
    output: z.enum(['720p', '1080p']),
    defaultValue: '720p' as const,
    meta: { options: ltxv23Resolutions },
  })

  // Aspect ratio - only for txt2vid and ref2vid; options vary by resolution
  .node(
    'aspectRatio',
    (ctx) => {
      const resolution = (ctx as { resolution?: string }).resolution ?? '720p';
      const options =
        ltxv23AspectRatiosByResolution[resolution] ?? ltxv23AspectRatiosByResolution['720p'];
      return {
        ...aspectRatioNode({ options, defaultValue: '16:9' }),
        when: ctx.workflow === 'txt2vid' || ctx.workflow === 'img2vid:ref2vid',
      };
    },
    ['workflow', 'resolution']
  )

  // Duration - slider, max varies by resolution
  .node(
    'duration',
    (ctx) => {
      const resolution = (ctx as { resolution?: string }).resolution ?? '720p';
      const max = ltxv23MaxDurationByResolution[resolution] ?? 20;
      return sliderNode({ min: 3, max, step: 1, defaultValue: 5 });
    },
    ['resolution']
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

  // Generate audio toggle
  .node('generateAudio', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  });

// =============================================================================
// LTX Graph (parent)
// =============================================================================

/**
 * Consolidated LTX video generation controls.
 * Bound to both LTXV2 and LTXV23 ecosystems via the ecosystem discriminator.
 *
 * Shared nodes (defined here, before the discriminator):
 * - images: First/last frame slots for img2vid; single reference for ref2vid
 * - model: Combined version selector (LTXV2 + LTXV23)
 * - seed
 * - cfgScale, steps: Hidden for distilled models
 * - frameGuideStrength: img2vid with both first/last frames
 * - resources: Additional LoRAs
 */
export const ltxGraph = new DataGraph<LTXCtx, GenerationCtx>()
  // Images node - first/last frame slots for img2vid, single reference for ref2vid
  .node(
    'images',
    (ctx) => {
      if (isWorkflowOrVariant(ctx.workflow, 'img2vid') && ctx.workflow !== 'img2vid:ref2vid') {
        return {
          ...imagesNode({
            slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
            warnOnMissingAiMetadata: true,
            aspectRatios: sharedAspectRatioValues,
          }),
          when: true,
        };
      }
      if (ctx.workflow === 'img2vid:ref2vid') {
        return {
          ...imagesNode({ warnOnMissingAiMetadata: true }),
          when: true,
        };
      }
      return { ...imagesNode(), when: false };
    },
    ['workflow']
  )

  // Combined version selector spanning both LTXV2 and LTXV23
  .merge(
    () =>
      createCheckpointGraph({
        versions: ltxVersionOptions,
        defaultModelId: LTXV23_DEV_ID,
      }),
    []
  )

  // Seed
  .node('seed', seedNode())

  // CFG scale - hidden for distilled models
  .node(
    'cfgScale',
    (ctx) => ({
      ...sliderNode({
        min: 1,
        max: 10,
        step: 0.5,
        defaultValue: 3,
        presets: [
          { label: 'Low', value: 2 },
          { label: 'Balanced', value: 3 },
          { label: 'High', value: 5 },
        ],
      }),
      when: !DISTILLED_IDS.has(ctx.model?.id ?? -1),
    }),
    ['model']
  )

  // Steps - hidden for distilled models
  .node(
    'steps',
    (ctx) => ({
      ...sliderNode({
        min: 10,
        max: 50,
        defaultValue: 30,
        presets: [
          { label: 'Fast', value: 20 },
          { label: 'Balanced', value: 30 },
          { label: 'Quality', value: 50 },
        ],
      }),
      when: !DISTILLED_IDS.has(ctx.model?.id ?? -1),
    }),
    ['model']
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
      when:
        isWorkflowOrVariant(ctx.workflow, 'img2vid') &&
        ctx.workflow !== 'img2vid:ref2vid' &&
        ctx.images?.length === 2,
    }),
    ['workflow']
  )

  // Resources (LoRAs)
  .merge(createResourcesGraph())

  // Computed discriminator — derived from ecosystem.
  // We can't discriminate directly on `ecosystem` here: the outer ecosystem-graph
  // uses a groupedDiscriminator that collapses ['LTXV2','LTXV23'] into a single
  // group and strips the inner ecosystem literal, so `data.ecosystem === 'LTXV23'`
  // would not narrow. Discriminating on a computed key sidesteps that collision.
  .computed('ltxVersion', (ctx): LTXVersion => (ctx.ecosystem === 'LTXV23' ? 'v23' : 'v2'), [
    'ecosystem',
  ])

  // Discriminate version-specific controls into per-version subgraphs
  .discriminator('ltxVersion', {
    v2: ltxv2SubGraph,
    v23: ltxv23SubGraph,
  });

// =============================================================================
// Exports
// =============================================================================

export {
  ltxv2AspectRatios,
  ltxv2Durations,
  ltxv23AspectRatios,
  ltxv23AspectRatiosByResolution,
  ltxv23Resolutions,
  ltxVersionOptions,
  LTXV2_DISTILLED_ID,
  LTXV23_DISTILLED_ID,
};
