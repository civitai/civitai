/**
 * Vidu Graph
 *
 * Controls for Vidu Q1 video generation ecosystem.
 *
 * Workflows:
 * - txt2vid: Text to video generation (no images)
 * - img2vid: Image to video with first/last frame inputs
 * - img2vid:ref2vid: Reference-guided video generation with multiple images
 *
 * Nodes:
 * - images: Workflow-dependent image input (hidden for text-to-video)
 * - seed: Optional seed for reproducibility
 * - enablePromptEnhancer: Toggle for prompt enhancement
 * - style: Video style (General/Anime) - only visible for txt2vid
 * - aspectRatio: Output aspect ratio - visible for txt2vid and img2vid:ref2vid
 * - movementAmplitude: Movement intensity control
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { seedNode, aspectRatioNode, enumNode, imagesNode, createCheckpointGraph } from './common';

// =============================================================================
// Constants
// =============================================================================

/** Vidu aspect ratio options */
const viduAspectRatios = [
  { label: '16:9', value: '16:9', width: 1280, height: 720 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '9:16', value: '9:16', width: 720, height: 1280 },
];

/** Vidu style options */
const viduStyles = [
  { label: 'General', value: 'general' },
  { label: 'Anime', value: 'anime' },
] as const;

/** Vidu movement amplitude options */
const viduMovementAmplitudes = [
  { label: 'Auto', value: 'auto' },
  { label: 'Small', value: 'small' },
  { label: 'Medium', value: 'medium' },
  { label: 'Large', value: 'large' },
] as const;

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
 * - txt2vid: Shows style selector and aspect ratio
 * - img2vid: First/last frame mode, no style or aspect ratio
 * - img2vid:ref2vid: Reference mode, shows aspect ratio but no style
 */
export const viduGraph = new DataGraph<ViduCtx, GenerationCtx>()
  // Images node - workflow-dependent config
  .node(
    'images',
    (ctx) => {
      if (ctx.workflow === 'img2vid') {
        return {
          ...imagesNode({
            slots: [{ label: 'First Frame', required: true }, { label: 'Last Frame (optional)' }],
          }),
          when: true,
        };
      }
      if (ctx.workflow === 'img2vid:ref2vid') {
        return {
          ...imagesNode({ max: 7 }),
          when: true,
        };
      }
      // txt2vid — hide images node entirely
      return { ...imagesNode(), when: false };
    },
    ['workflow']
  )

  // Merge checkpoint graph (model node with locked model from ecosystem settings)
  .merge(createCheckpointGraph())

  // Seed node
  .node('seed', seedNode())

  // Prompt enhancer toggle
  .node('enablePromptEnhancer', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: true,
  })

  // Style node - only for txt2vid
  .node(
    'style',
    (ctx) => ({
      ...enumNode({
        options: viduStyles,
        defaultValue: 'general',
      }),
      when: ctx.workflow === 'txt2vid',
    }),
    ['workflow']
  )

  // Aspect ratio node - for txt2vid and img2vid:ref2vid
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: viduAspectRatios, defaultValue: '1:1' }),
      when: ctx.workflow === 'txt2vid' || ctx.workflow === 'img2vid:ref2vid',
    }),
    ['workflow']
  )

  // Movement amplitude node - always shown
  .node(
    'movementAmplitude',
    enumNode({
      options: viduMovementAmplitudes,
      defaultValue: 'auto',
    })
  );

// Export constants for use in components
export { viduAspectRatios, viduStyles, viduMovementAmplitudes };
