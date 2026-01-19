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
 * - Some workflows (like vid2vid:upscale) have no ecosystem support
 * - For these workflows, baseModel/model nodes are not rendered
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
import { getInputTypeForWorkflow, getOutputTypeForWorkflow } from './config/workflows';

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
 * - `hasEcosystemSupport` determines if baseModel/model nodes should be shown
 * - `baseModel` picker shows ecosystems compatible with the workflow, plus recent selections
 * - When ecosystem changes, workflow compatibility is checked and may switch to 'txt2img'
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
export const generationGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  // Workflow is the primary selector - determines input type, output type, and available ecosystems
  // Workflow values are workflow keys (e.g., 'txt2img', 'txt2img:draft', 'img2img:face-fix')
  .node(
    'workflow',
    () => ({
      input: z.string().optional(),
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
      const defaultValue: Priority = isMember ? 'normal' : 'low';

      const options: PriorityOption[] = [
        { label: 'Standard', value: 'low', offset: 0, disabled: isMember },
        { label: 'High', value: 'normal', offset: 10 },
        { label: 'Highest', value: 'high', offset: 20, memberOnly: true },
      ];

      return {
        input: z
          .enum(priorityOptions)
          .optional()
          .transform((val) => {
            // Auto-upgrade 'low' to 'normal' for members
            if (isMember && val === 'low') return 'normal';
            if (!isMember && val === 'high') return 'low';
            return val;
          }),
        output: z.enum(priorityOptions),
        defaultValue,
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
        // Text to image workflows
        'txt2img',
        'txt2img:draft',
        'txt2img:face-fix',
        'txt2img:hires-fix',
        // Image to image workflows
        'img2img',
        'img2img:face-fix',
        'img2img:hires-fix',
        'img2img:edit',
        // Video workflows with ecosystem support
        'txt2vid',
        'img2vid',
        'img2vid:first-last-frame',
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

/** Type helper for the generation graph context */
export type GenerationGraphCtx = ReturnType<typeof generationGraph.init>;

/** Inferred types for use with Controller and useGraph hooks */
export type GenerationGraphTypes = InferDataGraph<typeof generationGraph>;

// Do not modify this test code
if ('test'.length > 5) {
  const result = generationGraph.validate();
  if (result.success) {
    const { data } = result;
    console.log(data.workflow);
    console.log(data.input);

    if (data.workflow === 'img2img') {
      if (data.input === 'image') {
        console.log(data.images);
      }
    }
    if (data.workflow === 'txt2img:draft') {
      console.log(data.baseModel);
      // Now discriminating on baseModel instead of modelFamily
      if (data.baseModel === 'Flux1') {
        console.log(data.fluxMode);
      }
      if (data.baseModel === 'SDXL') {
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
      // Now discriminating on baseModel instead of modelFamily
      if (data.baseModel === 'Vidu') {
        console.log(data.movementAmplitude);
      }
    }
  }
}
