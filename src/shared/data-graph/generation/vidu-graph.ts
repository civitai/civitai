/**
 * Vidu Graph
 *
 * Controls for Vidu video generation ecosystem.
 * Supports Q1 and Q3 model versions with different capabilities.
 *
 * Workflows:
 * - txt2vid: Text to video generation (no images)
 * - img2vid: Image to video with first/last frame inputs
 * - img2vid:ref2vid: Reference-guided video generation with multiple images
 *
 * Q1-specific nodes: enablePromptEnhancer, style, movementAmplitude
 * Q3-specific nodes: resolution, draft, enableAudio
 *
 * Nodes:
 * - images: Workflow-dependent image input (hidden for text-to-video)
 * - seed: Optional seed for reproducibility
 * - enablePromptEnhancer: Toggle for prompt enhancement (Q1 only)
 * - style: Video style (General/Anime) - only visible for Q1 txt2vid
 * - resolution: Video resolution (Q3 only)
 * - aspectRatio: Output aspect ratio - hidden for img2vid (auto-resolved from first image)
 * - movementAmplitude: Movement intensity control (Q1 only)
 * - draft: Draft mode toggle (Q3 only, maps to 'turbo' in API)
 * - enableAudio: Audio generation toggle (Q3 only)
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  seedNode,
  aspectRatioNode,
  enumNode,
  imagesNode,
  sliderNode,
  createCheckpointGraph,
} from './common';
import type { AspectRatioOption } from './common';
import { findClosestAspectRatio } from '~/utils/aspect-ratio-helpers';
import { isWorkflowOrVariant } from './config/workflows';

// =============================================================================
// Constants
// =============================================================================

/** Vidu model version IDs */
export const viduVersionIds = {
  q1: 2623839,
  q3: 2741273,
} as const;

/** Vidu version options for checkpoint selector */
const viduVersionOptions = [
  { label: 'Q1', value: viduVersionIds.q1 },
  { label: 'Q3', value: viduVersionIds.q3 },
];

/** Vidu Q1 aspect ratio options */
const viduAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

/** Vidu style options (Q1 only) */
const viduStyles = [
  { label: 'General', value: 'general' },
  { label: 'Anime', value: 'anime' },
] as const;

/** Vidu movement amplitude options (Q1 only) */
const viduMovementAmplitudes = [
  { label: 'Auto', value: 'auto' },
  { label: 'Small', value: 'small' },
  { label: 'Medium', value: 'medium' },
  { label: 'Large', value: 'large' },
] as const;

/** Vidu Q3 resolution options */
const viduQ3Resolutions = [
  { label: '360p', value: '360p' },
  { label: '540p', value: '540p' },
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
] as const;

/** Resolution value to pixel height mapping */
const resolutionPixels: Record<string, number> = {
  '360p': 360,
  '540p': 540,
  '720p': 720,
  '1080p': 1080,
};

/** Get Q3 aspect ratio options with dimensions derived from selected resolution */
function getViduQ3AspectRatios(resolution: string): AspectRatioOption[] {
  const res = resolutionPixels[resolution] ?? 720;
  return [
    { label: '16:9', value: '16:9', width: Math.round((res * 16) / 9), height: res },
    { label: '1:1', value: '1:1', width: res, height: res },
    { label: '9:16', value: '9:16', width: res, height: Math.round((res * 16) / 9) },
    { label: '4:3', value: '4:3', width: Math.round((res * 4) / 3), height: res },
    { label: '3:4', value: '3:4', width: res, height: Math.round((res * 4) / 3) },
  ];
}

// =============================================================================
// Helpers
// =============================================================================

/** Resolve closest aspect ratio from the first uploaded image's dimensions */
function resolveAspectRatioFromImage(
  ctx: Record<string, unknown>,
  options: AspectRatioOption[]
): AspectRatioOption {
  const images = ctx.images as Array<{ width?: number; height?: number }> | undefined;
  const first = images?.[0];
  if (first?.width && first?.height) {
    return findClosestAspectRatio({ width: first.width, height: first.height }, options);
  }
  return options.find((o) => o.value === '1:1') ?? options[0];
}

// =============================================================================
// Vidu Graph
// =============================================================================

/** Context shape for vidu graph */
type ViduCtx = {
  ecosystem: string;
  workflow: string;
};

/**
 * Vidu video generation controls.
 *
 * Workflow-specific behavior:
 * - txt2vid: Shows style selector (Q1) and aspect ratio
 * - img2vid: First/last frame mode (Q1), single image (Q3)
 * - img2vid:ref2vid: Reference mode with multiple images
 *
 * Model-specific behavior:
 * - Q1: enablePromptEnhancer, style, movementAmplitude
 * - Q3: resolution, turbo, enableAudio, expanded aspect ratios
 */
export const viduGraph = new DataGraph<ViduCtx, GenerationCtx>()
  // Images node - workflow-dependent config
  .node(
    'images',
    (ctx) => {
      if (isWorkflowOrVariant(ctx.workflow, 'img2vid')) {
        return {
          ...imagesNode({
            slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
            warnOnMissingAiMetadata: true,
          }),
          when: true,
        };
      }
      if (ctx.workflow === 'img2vid:ref2vid') {
        return {
          ...imagesNode({ max: 7, warnOnMissingAiMetadata: true }),
          when: true,
        };
      }
      // txt2vid — hide images node entirely
      return { ...imagesNode(), when: false };
    },
    ['workflow']
  )

  // Merge checkpoint graph with Q1/Q3 version options
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: viduVersionOptions },
        defaultModelId: viduVersionIds.q1,
      }),
    []
  )

  // Q3 doesn't support ref2vid — auto-switch to img2vid when Q3 is selected
  .effect(
    (ctx, _ext, set) => {
      const model = ctx.model as { id?: number } | undefined;
      if (model?.id === viduVersionIds.q3 && ctx.workflow === 'img2vid:ref2vid') {
        set('workflow', 'img2vid');
      }
    },
    ['model']
  )

  // Seed node
  .node('seed', seedNode())

  // Prompt enhancer toggle (Q1 only)
  .node(
    'enablePromptEnhancer',
    (ctx) => {
      const model = ctx.model as { id?: number } | undefined;
      const isQ1 = model?.id !== viduVersionIds.q3;
      return {
        input: z.boolean().optional(),
        output: z.boolean(),
        defaultValue: true,
        when: isQ1,
      };
    },
    ['model']
  )

  // Style node - Q1 txt2vid only
  .node(
    'style',
    (ctx) => {
      const model = ctx.model as { id?: number } | undefined;
      const isQ1 = model?.id !== viduVersionIds.q3;
      return {
        ...enumNode({
          options: viduStyles,
          defaultValue: 'general',
        }),
        when: isQ1 && ctx.workflow === 'txt2vid',
      };
    },
    ['workflow', 'model']
  )

  // Resolution node - Q3 only
  .node(
    'resolution',
    (ctx) => {
      const model = ctx.model as { id?: number } | undefined;
      const isQ3 = model?.id === viduVersionIds.q3;
      return {
        ...enumNode({
          options: viduQ3Resolutions,
          defaultValue: '720p',
        }),
        when: isQ3,
      };
    },
    ['model']
  )

  // Aspect ratio node - hidden for img2vid (auto-resolved from first image)
  .node(
    'aspectRatio',
    (ctx) => {
      const model = ctx.model as { id?: number } | undefined;
      const isQ3 = model?.id === viduVersionIds.q3;
      const isImg2Vid = isWorkflowOrVariant(ctx.workflow, 'img2vid');

      if (isQ3) {
        const resolution = 'resolution' in ctx ? (ctx.resolution as string) : '720p';
        const options = getViduQ3AspectRatios(resolution);

        if (isImg2Vid) {
          return {
            ...aspectRatioNode({ options, defaultValue: '1:1' }),
            when: false,
            transform: () => resolveAspectRatioFromImage(ctx, options),
          };
        }

        return {
          ...aspectRatioNode({ options, defaultValue: '1:1' }),
          when: true,
        };
      }

      // Q1: img2vid auto-resolves from first image
      if (isImg2Vid) {
        return {
          ...aspectRatioNode({ options: viduAspectRatios, defaultValue: '1:1' }),
          when: false,
          transform: () => resolveAspectRatioFromImage(ctx, viduAspectRatios),
        };
      }

      // Q1: show for txt2vid and ref2vid
      return {
        ...aspectRatioNode({ options: viduAspectRatios, defaultValue: '1:1' }),
        when: ctx.workflow === 'txt2vid' || ctx.workflow === 'img2vid:ref2vid',
      };
    },
    ['workflow', 'model', 'resolution', 'images']
  )

  // Movement amplitude node - Q1 only
  .node(
    'movementAmplitude',
    (ctx) => {
      const model = ctx.model as { id?: number } | undefined;
      const isQ1 = model?.id !== viduVersionIds.q3;
      return {
        ...enumNode({
          options: viduMovementAmplitudes,
          defaultValue: 'auto',
        }),
        when: isQ1,
      };
    },
    ['model']
  )

  // Duration node - Q3 only (seconds)
  .node(
    'duration',
    (ctx) => {
      const model = ctx.model as { id?: number } | undefined;
      const isQ3 = model?.id === viduVersionIds.q3;
      return {
        ...sliderNode({ min: 1, max: 16, defaultValue: 5 }),
        when: isQ3,
      };
    },
    ['model']
  )

  // Draft mode toggle - Q3 only (maps to 'turbo' in the API)
  .node(
    'draft',
    (ctx) => {
      const model = ctx.model as { id?: number } | undefined;
      const isQ3 = model?.id === viduVersionIds.q3;
      return {
        input: z.boolean().optional(),
        output: z.boolean(),
        defaultValue: false,
        when: isQ3,
      };
    },
    ['model']
  )

  // Enable audio toggle - Q3 only
  .node(
    'enableAudio',
    (ctx) => {
      const model = ctx.model as { id?: number } | undefined;
      const isQ3 = model?.id === viduVersionIds.q3;
      return {
        input: z.boolean().optional(),
        output: z.boolean(),
        defaultValue: false,
        when: isQ3,
      };
    },
    ['model']
  );

// Export constants for use in components
export {
  viduAspectRatios,
  viduStyles,
  viduMovementAmplitudes,
  viduQ3Resolutions,
  getViduQ3AspectRatios,
};
