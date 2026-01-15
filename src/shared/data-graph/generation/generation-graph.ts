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
import { imageOutputGraph, videoOutputGraph } from './common';
import { videoInterpolationGraph } from './video-interpolation-graph';
import { videoUpscaleGraph } from './video-upscale-graph';
import { imageUpscaleGraph } from './image-upscale-graph';
import { imageRemoveBackgroundGraph } from './image-remove-background-graph';
import { ecosystemGraph } from './ecosystem-graph';
import { getInputTypeForWorkflow, getOutputTypeForWorkflow } from './workflows';

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
  // Workflow values are workflow keys (e.g., 'txt2img', 'draft', 'img2img:face-fix')
  .node(
    'workflow',
    () => {
      return {
        input: z.string().optional(),
        output: z.string(),
        defaultValue: 'txt2img',
        meta: {
          // All workflows are shown - compatibility is handled by baseModel filtering
        },
      };
    },
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
  // Output type discriminator - adds priority/outputFormat only for image output
  .discriminator('output', {
    image: imageOutputGraph,
    video: videoOutputGraph,
  })

  // Discriminator: include ecosystem-dependent nodes only for workflows with ecosystem support
  // Workflows without ecosystem support (vid2vid:*) use their own specialized graphs
  .discriminator('workflow', {
    // Text to image workflows
    txt2img: ecosystemGraph,
    draft: ecosystemGraph,
    'txt2img:face-fix': ecosystemGraph,
    'txt2img:hires-fix': ecosystemGraph,
    // Image to image workflows
    img2img: ecosystemGraph,
    'img2img:face-fix': ecosystemGraph,
    'img2img:hires-fix': ecosystemGraph,
    'image-edit': ecosystemGraph,
    // Video workflows with ecosystem support
    txt2vid: ecosystemGraph,
    img2vid: ecosystemGraph,
    // Video enhancement workflows (no ecosystem support)
    'vid2vid:interpolate': videoInterpolationGraph,
    'vid2vid:upscale': videoUpscaleGraph,
    // Image enhancement workflows (no ecosystem support)
    'img2img:upscale': imageUpscaleGraph,
    'img2img:remove-background': imageRemoveBackgroundGraph,
  });

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
    if (data.workflow === 'draft') {
      console.log(data.baseModel);
      if (data.modelFamily === 'flux') {
        console.log(data.fluxMode);
      }
      if (data.modelFamily === 'stable-diffusion') {
        console.log(data.aspectRatio);
        console.log(data.seed);
      }
    }

    // Test non-ecosystem workflows - these define their own images node
    if (data.workflow === 'img2img:upscale') {
      console.log(data.images);
      console.log(data.scaleFactor);
    }
  }
}
