/**
 * Generation Graph V2
 *
 * Uses the DataGraph v2 class with Controller pattern.
 * Meta only contains dynamic props (options, min/max from context, etc.)
 * Static props (label, buttonLabel, placeholder, etc.) are defined in components.
 *
 * Workflow-First Architecture:
 * - Users select a workflow (Create Image, Draft, Face Fix, etc.)
 * - Workflow determines input type (text/image), output type (image/video), and available ecosystems
 * - Ecosystem picker shows compatible ecosystems for the selected workflow
 * - Recent ecosystems are tracked in localStorage (limit 3)
 *
 * Ecosystem Support Discriminator:
 * - Some workflows (like vid2vid:upscale, img2img:upscale) have no ecosystem support
 * - For these workflows, ecosystem/model nodes are not rendered
 * - The `hasEcosystemSupport` computed node acts as a discriminator
 */

import { z } from 'zod';
import { DataGraph, type InferDataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { videoInterpolationGraph } from './video-interpolation-graph';
import { videoUpscaleGraph } from './video-upscale-graph';
import { imageUpscaleGraph } from './image-upscale-graph';
import { imageRemoveBackgroundGraph } from './image-remove-background-graph';
import { ecosystemGraph } from './ecosystem-graph';
import {
  getInputTypeForWorkflow,
  getOutputTypeForWorkflow,
  workflowOptions,
  type WorkflowOption,
} from './config/workflows';

// =============================================================================
// Priority & Output Format Types
// =============================================================================

/** Priority options */
const priorityOptions = ['low', 'normal', 'high'] as const;
export type Priority = (typeof priorityOptions)[number];

/** Priority option metadata */
type PriorityOption = {
  label: string;
  value: Priority;
  offset: number;
  memberOnly?: boolean;
  disabled?: boolean;
};

/** Output format options */
const outputFormatOptions = ['jpeg', 'png'] as const;
export type OutputFormat = (typeof outputFormatOptions)[number];

// =============================================================================
// Generation Graph V2
// =============================================================================

/**
 * Generation graph v2 definition.
 *
 * Workflow-First Architecture:
 * - The `workflow` node is the primary selector (Create Image, Draft, Face Fix, etc.)
 * - `output` and `input` are computed from the selected workflow
 * - `hasEcosystemSupport` determines if ecosystem/model nodes should be shown
 * - `ecosystem` picker shows ecosystems compatible with the workflow, plus recent selections
 * - When ecosystem changes, workflow compatibility is checked and may switch
 *
 * @example
 * ```tsx
 * <Controller
 *   graph={graph}
 *   name="workflow"
 *   render={({ value, meta, onChange }) => (
 *     <WorkflowSelect
 *       value={value}
 *       onChange={onChange}
 *       options={meta.options}
 *     />
 *   )}
 * />
 * ```
 */
/** Maps new-format workflow keys back to old format for migration */
const NEW_TO_OLD: Record<string, string> = {
  'image:create': 'txt2img',
  'image:edit': 'img2img:edit',
  'image:draft': 'txt2img:draft',
  'image:face-fix': 'txt2img:face-fix',
  'image:hires-fix': 'txt2img:hires-fix',
  'image:upscale': 'img2img:upscale',
  'image:remove-background': 'img2img:remove-background',
  'video:create': 'txt2vid',
  'video:animate': 'txt2vid',
  'video:first-last-frame': 'img2vid',
  'video:ref2vid': 'img2vid:ref2vid',
  'video:upscale': 'vid2vid:upscale',
  'video:interpolate': 'vid2vid:interpolate',
};

/** Migrate stored workflow key to current format */
function migrateWorkflowKey(key: string | undefined): string | undefined {
  if (!key) return key;
  // Migrate old first-last-frame key to img2vid (now an alias on Vidu)
  if (key === 'img2vid:first-last-frame') return 'img2vid';
  return NEW_TO_OLD[key] ?? key;
}

export const generationGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  // Workflow is the primary selector - determines input type, output type, and available ecosystems
  // Workflow values are workflow keys (e.g., 'txt2img', 'txt2img:draft', 'txt2vid')
  .node(
    'workflow',
    () => ({
      input: z.string().optional().transform(migrateWorkflowKey),
      output: z.string(),
      defaultValue: 'txt2img',
      meta: {
        // All workflows are shown - compatibility is handled by baseModel filtering
      },
    }),
    []
  )
  // Output is computed from workflow
  .computed(
    'output',
    (ctx) => {
      return getOutputTypeForWorkflow(ctx.workflow);
    },
    ['workflow']
  )
  // Input is computed from workflow
  .computed(
    'input',
    (ctx) => {
      return getInputTypeForWorkflow(ctx.workflow);
    },
    ['workflow']
  )
  // Priority node - only for image output
  .node(
    'priority',
    (ctx, ext) => {
      const isImageOutput = ctx.output === 'image';
      const isMember = ext.user?.isMember ?? false;

      const options: PriorityOption[] = isMember
        ? [
            { label: 'High', value: 'low', offset: 10 },
            { label: 'Highest', value: 'high', offset: 20, memberOnly: true },
          ]
        : [
            { label: 'Standard', value: 'low', offset: 0, disabled: isMember },
            { label: 'High', value: 'normal', offset: 10 },
            { label: 'Highest', value: 'high', offset: 20, memberOnly: true },
          ];

      return {
        input: z
          .enum(priorityOptions)
          .optional()
          .transform((val) => {
            if (!isMember && val === 'high') return 'low';
            return val;
          }),
        output: z.enum(priorityOptions),
        defaultValue: 'low' as const,
        meta: { options, isMember },
        when: isImageOutput,
      };
    },
    ['output']
  )
  // Output format node - only for image output, excluding background removal
  .node(
    'outputFormat',
    (ctx, ext) => {
      const isImageOutput = ctx.output === 'image';
      const isBackgroundRemoval = ctx.workflow === 'img2img:remove-background';
      const isMember = ext.user?.isMember ?? false;

      return {
        input: z.enum(outputFormatOptions).optional(),
        output: z.enum(outputFormatOptions),
        defaultValue: 'jpeg' as OutputFormat,
        meta: {
          options: [
            { label: 'JPEG', value: 'jpeg', offset: 0 },
            { label: 'PNG', value: 'png', offset: 2 },
          ],
          isMember,
        },
        when: isImageOutput && !isBackgroundRemoval,
      };
    },
    ['output', 'workflow']
  )

  // Discriminator: include ecosystem-dependent nodes only for workflows with ecosystem support
  // Workflows without ecosystem support (vid2vid:*) use their own specialized graphs
  //
  // Using groupedDiscriminator to reduce TypeScript type complexity:
  // - All ecosystem workflows share the same graph, so they're grouped into ONE type branch
  // - Standalone workflows each get their own type branch
  // - Result: 5 type branches instead of 16, significantly reducing union type size
  .groupedDiscriminator('workflow', [
    // Ecosystem workflows - all share ecosystemGraph (ONE type branch)
    {
      values: [
        // Image creation workflows
        'txt2img',
        'img2img',
        'img2img:edit',
        'txt2img:draft',
        'txt2img:face-fix',
        'img2img:face-fix',
        'txt2img:hires-fix',
        'img2img:hires-fix',
        // Video workflows with ecosystem support
        'txt2vid',
        'img2vid',
        'img2vid:ref2vid',
      ] as const,
      graph: ecosystemGraph,
    },
    // Video enhancement workflows (no ecosystem support) - each gets its own type branch
    { values: ['vid2vid:interpolate'] as const, graph: videoInterpolationGraph },
    { values: ['vid2vid:upscale'] as const, graph: videoUpscaleGraph },
    // Image enhancement workflows (no ecosystem support)
    { values: ['img2img:upscale'] as const, graph: imageUpscaleGraph },
    { values: ['img2img:remove-background'] as const, graph: imageRemoveBackgroundGraph },
  ]);

// =============================================================================
// Graph-Derived Workflow Node Detection
// =============================================================================

/** Cache for workflowHasNode results, keyed by `workflow:nodeKey` */
const _hasNodeCache = new Map<string, boolean>();

/**
 * Check if a workflow's sub-graph contains a specific node key.
 * Uses DataGraph's findKeyInBranches with context to evaluate the graph's
 * default path for the workflow. Unpinned discriminators (e.g., ecosystem)
 * are resolved to their default value via node factory evaluation.
 *
 * @example
 * ```ts
 * workflowHasNode('txt2img', 'images') // true - default ecosystem has images
 * workflowHasNode('vid2vid:upscale', 'video')  // true - video upscale graph has video
 * workflowHasNode('vid2vid:upscale', 'images') // false - video upscale has no images
 * workflowHasNode('txt2img:draft', 'images')   // false - images has when:false in default ecosystem
 * ```
 */
export function workflowHasNode(workflow: string, nodeKey: string): boolean {
  const cacheKey = `${workflow}:${nodeKey}`;
  let result = _hasNodeCache.get(cacheKey);
  if (result === undefined) {
    result =
      generationGraph.findKeyInBranches(['workflow', 'ecosystem'], nodeKey, { workflow }).length >
      0;
    _hasNodeCache.set(cacheKey, result);
  }
  return result;
}

/**
 * Get all workflows that can accept a given media type, derived from graph structure.
 * Checks whether each workflow's sub-graph contains an 'images' or 'video' node
 * by evaluating the graph's default path for each workflow.
 */
export function getWorkflowsForMediaType(mediaType: 'image' | 'video'): WorkflowOption[] {
  const nodeKey = mediaType === 'image' ? 'images' : 'video';
  return workflowOptions.filter((w) => workflowHasNode(w.graphKey, nodeKey));
}

/** Type helper for the generation graph context */
export type GenerationGraphCtx = ReturnType<typeof generationGraph.init>;

/** Inferred types for use with Controller and useGraph hooks */
export type GenerationGraphTypes = InferDataGraph<typeof generationGraph>;

/**
 * Flat union of all possible generation param values across all workflows/ecosystems.
 * Each key maps to a union of all possible values for that key across all branches.
 *
 * Use this instead of `Record<string, unknown>` when working with params from
 * step metadata or the legacy data mapper. Provides type-safe access to known
 * fields like `prompt`, `workflow`, `seed`, `ecosystem`, etc. without manual casting.
 *
 * @example
 * ```ts
 * const params: GenerationGraphValues = step.metadata.params;
 * params.prompt   // string | undefined
 * params.workflow // string
 * params.seed     // number | null | undefined
 * ```
 */
export type GenerationGraphValues = GenerationGraphTypes['Values'];

// Do not modify this test code
if ('test'.length > 5) {
  const result = generationGraph.validate();
  if (result.success) {
    const { data } = result;
    console.log(data.workflow);
    console.log(data.input);

    if (data.workflow === 'txt2img') {
      console.log(data.ecosystem);
      if (data.ecosystem === 'SDXL') {
        console.log(data.images);
      }
    }
    if (data.workflow === 'txt2img:draft') {
      console.log(data.ecosystem);
      // Now discriminating on ecosystem instead of modelFamily
      if (data.ecosystem === 'Flux1') {
        console.log(data.fluxMode);
      }
      if (data.ecosystem === 'SDXL') {
        console.log(data.aspectRatio);
        console.log(data.seed);
        console.log(data.model);
      }
    }

    // Test non-ecosystem workflows - these define their own images node
    if (data.workflow === 'img2img:upscale') {
      console.log(data.images);
      console.log(data.scaleFactor);
    }

    if (data.workflow === 'txt2vid') {
      // Now discriminating on ecosystem instead of modelFamily
      if (data.ecosystem === 'Vidu') {
        console.log(data.movementAmplitude);
      }
    }
  }
}
