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
 * - negativePrompt: Negative prompt for generation
 * - aspectRatio: Output aspect ratio (txt2vid only)
 * - duration: Video duration (4, 6, or 8 seconds)
 * - generateAudio: Toggle for audio generation
 * - version: API version selector
 * - resources: Additional LoRAs
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  seedNode,
  negativePromptGraph,
  promptGraph,
  snippetsGraph,
  triggerWordsGraph,
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

/**
 * Veo3 model version mapping.
 *
 * Veo 3.1 ships one pair for every workflow, where 3.0 had a separate txt2vid
 * and img2vid pair. Both workflows now offer the same two versions.
 */
const veo3VersionIds = {
  fast: 2827948,
  standard: 2827945,
} as const;

/** Veo3 version options */
const veo3VersionOptions = [
  { label: 'Fast Mode', value: veo3VersionIds.fast, baseModel: veo3BaseModel },
  { label: 'Standard', value: veo3VersionIds.standard, baseModel: veo3BaseModel },
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

/**
 * Veo3 API version options.
 *
 * 3.0 is absent because Google retired veo-3.0-generate-001 and
 * veo-3.0-fast-generate-001 on 2026-08-28; they 404. The node stays even with a
 * single option so `version` is always sent explicitly — the orchestrator's
 * Veo3Version enum has 3.0 as its zero value, so omitting the field selects the
 * retired endpoint.
 */
const veo3ApiVersions = ['3.1'] as const;
type Veo3ApiVersion = (typeof veo3ApiVersions)[number];

const veo3ApiVersionOptions = [{ label: 'Veo 3.1', value: '3.1' as Veo3ApiVersion }];

// =============================================================================
// Veo3 Graph
// =============================================================================

/** Context shape for veo3 graph */
type Veo3Ctx = { ecosystem: string; workflow: string };

/** Workflow-specific version configuration for Veo3 */
const veo3WorkflowVersions = {
  txt2vid: {
    versions: { options: veo3VersionOptions },
    defaultModelId: veo3VersionIds.fast,
  },
  img2vid: {
    versions: { options: veo3VersionOptions },
    defaultModelId: veo3VersionIds.fast,
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
  // Images node - shown for img2vid/ref2vid, hidden for txt2vid
  .node(
    'images',
    (ctx) => {
      if (ctx.workflow === 'img2vid:ref2vid') {
        return {
          ...imagesNode({
            // Veo 3.1 accepts at most three asset reference images.
            max: 3,
            warnOnMissingAiMetadata: true,
            aspectRatios: ['16:9', '9:16'],
          }),
          when: true,
        };
      }
      if (ctx.workflow === 'img2vid') {
        return {
          ...imagesNode({
            warnOnMissingAiMetadata: true,
            aspectRatios: ['16:9', '9:16'],
          }),
          when: true,
        };
      }
      return { ...imagesNode(), when: false };
    },
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

  // Prompt + triggerWords + negativePrompt
  .merge(triggerWordsGraph)
  .merge(snippetsGraph)
  .merge(promptGraph)
  .merge(negativePromptGraph)

  // Aspect ratio node - for txt2vid and ref2vid workflows (img2vid derives from source image)
  .node(
    'aspectRatio',
    (ctx) => {
      return {
        ...aspectRatioNode({ options: veo3AspectRatios, defaultValue: '16:9' }),
        when: ctx.workflow === 'txt2vid',
      };
    },
    ['workflow']
  )

  // Duration node (fixed at 8s for img2vid)
  .node(
    'duration',
    (ctx) => {
      // const isImg2Vid = ctx.workflow === 'img2vid';
      const isRef2Vid = ctx.workflow === 'img2vid:ref2vid';
      return {
        input: z.coerce.number().optional(),
        output: z.number(),
        defaultValue: 8,
        meta: {
          // options: veo3Durations,
          options: isRef2Vid
            ? [{ label: '8 seconds', value: 8 }] // Only show 8s option for img2vid
            : veo3Durations,
          disabled: isRef2Vid,
        },
        // Force duration to 8s when workflow changes to ref2vid
        transform: (value: number) => (isRef2Vid ? 8 : value),
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

  // API version selector
  .node('version', {
    input: z.enum(veo3ApiVersions).optional(),
    output: z.enum(veo3ApiVersions),
    defaultValue: '3.1' as Veo3ApiVersion,
    meta: {
      options: veo3ApiVersionOptions,
    },
  });

// Resources node (LoRAs)
// .node(
//   'resources',
//   (ctx, ext) =>
//     resourcesNode({
//       ecosystem: ctx.ecosystem,
//       limit: ext.limits.maxResources,
//     }),
//   ['ecosystem']
// );

// Export constants for use in components
export {
  veo3AspectRatios,
  veo3Durations,
  veo3VersionIds,
  veo3VersionOptions,
  veo3ApiVersions,
  veo3ApiVersionOptions,
};
