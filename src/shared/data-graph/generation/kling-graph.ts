/**
 * Kling Graph
 *
 * Controls for Kling video generation ecosystem.
 * Supports txt2vid and img2vid workflows with multiple model versions.
 *
 * Uses groupedDiscriminator to split legacy (V1.6/V2/V2.5) and V3 versions,
 * as V3 uses a different engine ('kling-v3') with significantly different inputs.
 *
 * Legacy versions (V1.6, V2, V2.5):
 * - engine: 'kling'
 * - Standard controls: seed, prompt enhancer, negative prompt, aspect ratio, mode, duration, cfgScale
 *
 * V3:
 * - engine: 'kling-v3'
 * - Operation-based: text-to-video, image-to-video, reference-to-video, vid2vid
 * - New features: elements, end image, multi-prompt, audio generation
 *
 * Nodes (legacy):
 * - model: Model version selector (V1_6, V2, V2_5_TURBO)
 * - seed: Optional seed for reproducibility
 * - enablePromptEnhancer: Toggle for prompt enhancement
 * - negativePrompt: Negative prompt for generation
 * - aspectRatio: Output aspect ratio (txt2vid only)
 * - mode: Generation mode (standard/professional)
 * - duration: Video duration (5 or 10 seconds)
 * - cfgScale: CFG scale for generation control
 *
 * Nodes (V3):
 * - model: Model version selector (V3)
 * - operation: Computed from workflow (text-to-video, image-to-video, reference-to-video)
 * - seed: Optional seed for reproducibility
 * - mode: Generation mode (standard/professional)
 * - duration: Video duration (5 or 10 seconds)
 * - aspectRatio: Output aspect ratio (txt2vid and ref2vid only)
 * - multiShot: Toggle for multi-segment generation (img2vid + ref2vid)
 * - klingElements: Per-segment elements with frontalImage/video/prompt (when multiShot)
 * - generateAudio: Toggle for audio generation
 * - keepAudio: Toggle to preserve source audio (vid2vid only)
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  seedNode,
  negativePromptNode,
  aspectRatioNode,
  sliderNode,
  enumNode,
  imagesNode,
  createCheckpointGraph,
  imageValueSchema,
  videoValueSchema,
  type ResourceData,
} from './common';
import { removeEmpty } from '~/utils/object-helpers';

// =============================================================================
// Constants
// =============================================================================

/** Kling model version IDs */
const klingVersionIds = {
  v1_6: 2623815,
  v2: 2623817,
  v2_5_turbo: 2623821,
  v3: 2698632,
} as const;

/** Options for Kling model selector */
const klingVersionOptions = [
  { label: 'V1.6', value: klingVersionIds.v1_6 },
  { label: 'V2', value: klingVersionIds.v2 },
  { label: 'V2.5 Turbo', value: klingVersionIds.v2_5_turbo },
  { label: 'V3', value: klingVersionIds.v3 },
];

/** Kling aspect ratio options */
const klingAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

/** Kling mode options */
const klingModes = [
  { label: 'Standard', value: 'standard' },
  { label: 'Professional', value: 'professional' },
] as const;

/** Kling duration options */
const klingDurations = [
  { label: '5 seconds', value: '5' },
  { label: '10 seconds', value: '10' },
] as const;

// =============================================================================
// Types
// =============================================================================

/** Kling version group for discriminator */
export type KlingVersion = 'legacy' | 'v3';

/** V3 operation type, derived from workflow */
export type KlingV3Operation =
  | 'text-to-video'
  | 'image-to-video'
  | 'reference-to-video'
  | 'video-to-video-edit'
  | 'video-to-video-reference';

/**
 * V3 multi-shot element: one segment of a multi-shot generation.
 * Media is optional — a segment may contain just a prompt.
 * Elements with media appear in the API's elements[] array and get an @ElementN prefix
 * in their multiPrompt entry. Prompt-only elements appear only in multiPrompt.
 */
const klingV3ElementSchema = z.object({
  frontalImage: imageValueSchema.optional(),
  referenceImages: z.array(imageValueSchema).max(3).optional(),
  videoUrl: videoValueSchema.nullable().optional(),
  prompt: z.string().optional(),
});

// =============================================================================
// Sub-graph context types
// =============================================================================

/** Context shape for kling version sub-graphs */
type KlingVersionCtx = {
  ecosystem: string;
  workflow: string;
  klingVersion: KlingVersion;
  /** Model from checkpoint graph - needed by legacy graph for version-dependent behavior */
  model: ResourceData;
};

// =============================================================================
// Legacy Sub-graph (V1.6, V2, V2.5)
// =============================================================================

/**
 * Legacy Kling controls for V1.6, V2, and V2.5 Turbo.
 *
 * Workflow-specific behavior:
 * - txt2vid: Shows aspect ratio selector
 * - img2vid: Aspect ratio derived from source image
 *
 * Mode is derived from model version:
 * - V1.6: Can use standard or professional
 * - V2/V2.5: Professional only
 */
const klingLegacyGraph = new DataGraph<KlingVersionCtx, GenerationCtx>()
  // Images node - shown for img2vid, hidden for txt2vid
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ warnOnMissingAiMetadata: true }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )

  // Seed node
  .node('seed', seedNode())

  // Prompt enhancer toggle
  .node('enablePromptEnhancer', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: true,
  })

  // Negative prompt node
  .node('negativePrompt', negativePromptNode())

  // Aspect ratio node - only for txt2vid workflow
  .node(
    'aspectRatio',
    (ctx) => {
      const isTxt2Vid = !ctx.images?.length;
      return {
        ...aspectRatioNode({ options: klingAspectRatios, defaultValue: '1:1' }),
        when: isTxt2Vid,
      };
    },
    ['workflow']
  )

  // Mode node - only available for V1.6 which supports standard/professional choice
  .node(
    'mode',
    (ctx) => {
      const model = ctx.model as { id?: number } | undefined;
      const isV1_6 = model?.id === klingVersionIds.v1_6;

      return {
        input: z.enum(['standard', 'professional']).optional(),
        output: z.enum(['standard', 'professional']),
        defaultValue: isV1_6 ? ('standard' as const) : ('professional' as const),
        when: isV1_6,
        meta: {
          options: klingModes,
        },
      };
    },
    ['model']
  )

  // Duration node
  .node('duration', enumNode({ options: klingDurations, defaultValue: '5' }))

  // CFG scale node
  .node(
    'cfgScale',
    sliderNode({
      min: 0.1,
      max: 1,
      step: 0.1,
      defaultValue: 0.5,
      presets: [
        { label: 'Low', value: 0.3 },
        { label: 'Medium', value: 0.5 },
        { label: 'High', value: 0.7 },
      ],
    })
  );

// =============================================================================
// V3 Sub-graph
// =============================================================================

/** Map workflow to V3 operation */
function getV3Operation(workflow: string): KlingV3Operation {
  if (workflow === 'img2vid:ref2vid') return 'reference-to-video';
  if (workflow.startsWith('img2vid')) return 'image-to-video';
  // TODO: Add vid2vid workflow mappings when those workflows are available
  // vid2vid:edit → 'video-to-video-edit'
  // vid2vid:ref → 'video-to-video-reference'
  return 'text-to-video';
}

/**
 * Kling V3 controls.
 *
 * V3 uses a different engine ('kling-v3') with operation-based inputs.
 * Operation is derived from the workflow context:
 * - txt2vid → text-to-video
 * - img2vid → image-to-video (with optional end image)
 * - img2vid:ref2vid → reference-to-video (with elements)
 *
 * New V3 features:
 * - Elements: Reference images/videos for guided generation
 * - Multi-prompt: Multiple prompt segments with individual durations
 * - Audio generation: Generate or preserve audio
 */
const klingV3Graph = new DataGraph<KlingVersionCtx, GenerationCtx>()
  // Computed operation from workflow
  .computed('operation', (ctx): KlingV3Operation => getV3Operation(ctx.workflow), ['workflow'])

  // MultiShot toggle - enables multi-segment generation with per-element media + prompt.
  // TODO: Re-enable when multi-shot is ready for production (set when: ctx.workflow === 'img2vid')
  .node(
    'multiShot',
    (_ctx) => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: false,
      when: false,
    }),
    []
  )

  // KlingElements - multi-shot elements, each with frontalImage (required), optional
  // referenceImages/videoUrl, and a prompt segment.
  // Declared before images so ctx.klingElements is typed when images reads it.
  .node(
    'klingElements',
    (ctx) => ({
      input: z.array(klingV3ElementSchema).max(5).optional(),
      output: z.array(klingV3ElementSchema).max(5).optional(),
      defaultValue: [] as z.infer<typeof klingV3ElementSchema>[],
      when: ctx.multiShot === true && ctx.workflow === 'img2vid',
    }),
    ['multiShot', 'workflow']
  )

  // Images node - workflow-dependent config
  // V3 img2vid supports start + end image via slots
  // V3 ref2vid uses multiple reference images; hidden when multiShot is active
  //   (klingElements provides reference media in that case)
  .node(
    'images',
    (ctx) => {
      if (ctx.workflow === 'img2vid') {
        return {
          ...imagesNode({
            slots: [
              { label: 'Start Image', required: true },
              { label: 'End Image', disabled: ctx.multiShot === true },
            ],
            warnOnMissingAiMetadata: true,
          }),
          when: true,
        };
      }
      if (ctx.workflow === 'img2vid:ref2vid') {
        return {
          ...imagesNode({ max: 7, warnOnMissingAiMetadata: true }),
          when: ctx.multiShot !== true,
        };
      }
      // txt2vid — hide images
      return { ...imagesNode(), when: false };
    },
    ['workflow', 'multiShot']
  )

  // Effect: When multiShot is enabled on img2vid, clear the End Image slot value.
  // The slot is disabled in that mode, so any stored value should be removed.
  .effect(
    (ctx, _ext, set) => {
      if (ctx.workflow !== 'img2vid' || ctx.multiShot !== true) return;
      if (ctx.images && ctx.images.length > 1) {
        set('images', [ctx.images[0]]);
      }
    },
    ['multiShot', 'images']
  )

  // Seed node
  .node('seed', seedNode())

  // Mode (standard/professional) - always available in V3
  .node('mode', enumNode({ options: klingModes, defaultValue: 'standard' }))

  // Duration — slider from 5 to 15 seconds
  .node('duration', {
    input: z.coerce.number().min(5).max(15).optional(),
    output: z.number().min(5).max(15),
    defaultValue: 5,
    meta: { min: 5, max: 15, step: 1 },
  })

  // Aspect ratio - for text-to-video and reference-to-video
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: klingAspectRatios, defaultValue: '1:1' }),
      when: ctx.workflow === 'txt2vid' || ctx.workflow === 'img2vid:ref2vid',
    }),
    ['workflow']
  )

  // Generate audio toggle
  .node('generateAudio', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  });

// TODO: Add keepAudio node when vid2vid workflows are available
// keepAudio: boolean toggle to preserve source audio in vid2vid operations

// =============================================================================
// Kling Graph (root)
// =============================================================================

/** Context shape for kling graph */
type KlingCtx = { ecosystem: string; workflow: string };

/**
 * Kling video generation controls.
 *
 * Root graph that splits into legacy (V1.6/V2/V2.5) and V3 sub-graphs
 * based on the selected model version.
 *
 * The checkpoint/model selector is at this level so all versions share
 * the same model node. The computed `klingVersion` discriminator routes
 * to the appropriate sub-graph.
 */
export const klingGraph = new DataGraph<KlingCtx, GenerationCtx>()
  // Merge checkpoint graph with all model versions (including V3)
  .merge(
    createCheckpointGraph({
      versions: { options: klingVersionOptions },
      defaultModelId: klingVersionIds.v2_5_turbo, // Default to V2.5 Turbo for best performance/quality balance
    })
  )

  // Effect: When workflow switches to ref2vid, force model to V3
  // ref2vid is only supported on the kling-v3 engine
  .effect(
    (ctx, _ext, set) => {
      if (ctx.workflow !== 'img2vid:ref2vid') return;
      const model = ctx.model as { id?: number } | undefined;
      if (model?.id !== klingVersionIds.v3) {
        set('model', { id: klingVersionIds.v3, model: { type: 'Checkpoint' } } as ResourceData);
      }
    },
    ['workflow']
  )

  // Effect: When model changes to non-V3 while on ref2vid, fall back to img2vid
  // Consistency check prevents loops: if workflow already matches model, no action
  .effect(
    (ctx, _ext, set) => {
      if (ctx.workflow !== 'img2vid:ref2vid') return;
      const model = ctx.model as { id?: number } | undefined;
      if (model?.id !== klingVersionIds.v3) {
        set('workflow', 'img2vid');
      }
    },
    ['model']
  )

  // Computed: derive version group from selected model ID
  .computed(
    'klingVersion',
    (ctx): KlingVersion => {
      const model = ctx.model as { id?: number } | undefined;
      return model?.id === klingVersionIds.v3 ? 'v3' : 'legacy';
    },
    ['model']
  )

  // Split into legacy and V3 sub-graphs
  .groupedDiscriminator('klingVersion', [
    { values: ['legacy'] as const, graph: klingLegacyGraph },
    { values: ['v3'] as const, graph: klingV3Graph },
  ]);

// Export constants for use in components and handlers
export {
  klingAspectRatios,
  klingModes,
  klingDurations,
  klingVersionOptions,
  klingVersionIds,
  klingV3ElementSchema,
};
