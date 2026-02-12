/**
 * Veo3 Graph
 *
 * Controls for Google Veo 3 video generation ecosystem.
 * Supports txt2vid and img2vid workflows with model version selection (fast/standard).
 *
 * Model versions map to different AIR URNs:
 * - Fast Mode: Lower latency, good quality
 * - Standard: Higher quality, longer generation time
 *
 * Nodes:
 * - model: Model version selector (Fast/Standard per workflow)
 * - seed: Optional seed for reproducibility
 * - enablePromptEnhancer: Toggle for prompt enhancement
 * - negativePrompt: Negative prompt for generation
 * - aspectRatio: Output aspect ratio (txt2vid only)
 * - duration: Video duration (4, 6, or 8 seconds)
 * - generateAudio: Toggle for audio generation
 * - version: API version selector (3.0 vs 3.1)
 * - resources: Additional LoRAs
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  seedNode,
  negativePromptNode,
  aspectRatioNode,
  imagesNode,
  createCheckpointGraph,
  resourcesNode,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** Veo3 base model name */
const veo3BaseModel = 'Veo 3';

/** Veo3 model version mapping */
const veo3VersionIds = {
  // txt2vid versions
  txt2vid_fast: 1995399,
  txt2vid_standard: 1885367,
  // img2vid versions
  img2vid_fast: 2082027,
  img2vid_standard: 1996013,
} as const;

/** Veo3 version options for txt2vid */
const veo3Txt2VidVersionOptions = [
  { label: 'Fast Mode', value: veo3VersionIds.txt2vid_fast, baseModel: veo3BaseModel },
  { label: 'Standard', value: veo3VersionIds.txt2vid_standard, baseModel: veo3BaseModel },
];

/** Veo3 version options for img2vid */
const veo3Img2VidVersionOptions = [
  { label: 'Fast Mode', value: veo3VersionIds.img2vid_fast, baseModel: veo3BaseModel },
  { label: 'Standard', value: veo3VersionIds.img2vid_standard, baseModel: veo3BaseModel },
];

/** Veo3 aspect ratio options */
const veo3AspectRatios = [
  { label: '16:9', value: '16:9', width: 1920, height: 1080 },
  { label: '1:1', value: '1:1', width: 1080, height: 1080 },
  { label: '9:16', value: '9:16', width: 1080, height: 1920 },
];

/** Veo3 duration options */
const veo3Durations = [
  { label: '4 seconds', value: 4 },
  { label: '6 seconds', value: 6 },
  { label: '8 seconds', value: 8 },
];

/** Veo3 API version options */
const veo3ApiVersions = ['3.0', '3.1'] as const;
type Veo3ApiVersion = (typeof veo3ApiVersions)[number];

const veo3ApiVersionOptions = [
  { label: 'Veo 3.0', value: '3.0' as Veo3ApiVersion },
  { label: 'Veo 3.1', value: '3.1' as Veo3ApiVersion },
];

// =============================================================================
// Veo3 Graph
// =============================================================================

/** Context shape for veo3 graph */
type Veo3Ctx = { ecosystem: string; workflow: string };

/** Workflow-specific version configuration for Veo3 */
const veo3WorkflowVersions = {
  txt2vid: {
    versions: veo3Txt2VidVersionOptions,
    defaultModelId: veo3VersionIds.txt2vid_fast,
  },
  img2vid: {
    versions: veo3Img2VidVersionOptions,
    defaultModelId: veo3VersionIds.img2vid_fast,
  },
};

/**
 * Veo 3 video generation controls.
 *
 * Workflow-specific behavior:
 * - txt2vid: Shows aspect ratio selector, txt2vid model versions
 * - img2vid: Aspect ratio derived from source image, img2vid model versions
 */
export const veo3Graph = new DataGraph<Veo3Ctx, GenerationCtx>()
  // Images node - shown for img2vid, hidden for txt2vid
  .node(
    'images',
    (ctx) => ({
      ...imagesNode(),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )

  // Merge checkpoint graph with workflow-specific versions
  // The workflowVersions option handles automatic model syncing when workflow changes
  .merge(
    (ctx) =>
      createCheckpointGraph({
        workflowVersions: veo3WorkflowVersions,
        currentWorkflow: ctx.workflow,
      }),
    ['workflow']
  )

  // Seed node
  .node('seed', seedNode())

  // Prompt enhancer toggle
  .node('enablePromptEnhancer', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })

  // Negative prompt node
  .node('negativePrompt', negativePromptNode())

  // Aspect ratio node - only for txt2vid workflow
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: veo3AspectRatios, defaultValue: '16:9' }),
      when: ctx.workflow === 'txt2vid',
    }),
    ['workflow']
  )

  // Duration node (fixed at 8s for img2vid)
  .node(
    'duration',
    (ctx) => {
      const isImg2Vid = ctx.workflow === 'img2vid';
      return {
        input: z.coerce.number().optional(),
        output: z.number(),
        defaultValue: 8,
        meta: {
          options: isImg2Vid
            ? [{ label: '8 seconds', value: 8 }] // Only show 8s option for img2vid
            : veo3Durations,
          disabled: isImg2Vid,
        },
        // Force duration to 8s when workflow changes to img2vid
        transform: (value: number) => (isImg2Vid ? 8 : value),
      };
    },
    ['workflow']
  )

  // Generate audio toggle
  .node('generateAudio', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })

  // API version selector (3.0 vs 3.1)
  .node('version', {
    input: z.enum(veo3ApiVersions).optional(),
    output: z.enum(veo3ApiVersions),
    defaultValue: '3.0' as Veo3ApiVersion,
    meta: {
      options: veo3ApiVersionOptions,
    },
  })

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
export {
  veo3AspectRatios,
  veo3Durations,
  veo3VersionIds,
  veo3Txt2VidVersionOptions,
  veo3Img2VidVersionOptions,
  veo3ApiVersions,
  veo3ApiVersionOptions,
};
