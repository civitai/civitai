/**
 * Vidu Graph
 *
 * Controls for Vidu Q1 video generation ecosystem.
 * Supports txt2vid, img2vid (with first/last frame), and ref2vid workflows.
 *
 * Nodes:
 * - seed: Optional seed for reproducibility
 * - enablePromptEnhancer: Toggle for prompt enhancement
 * - style: Video style (General/Anime) - only for txt2vid
 * - aspectRatio: Output aspect ratio - only for txt2vid and ref2vid
 * - movementAmplitude: Movement intensity control
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { seedNode, aspectRatioNode, enumNode } from './common';

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
type ViduCtx = { baseModel: string; workflow: string };

/**
 * Vidu video generation controls.
 *
 * Workflow-specific behavior:
 * - txt2vid: Shows style selector and aspect ratio
 * - img2vid / img2vid:first-last-frame: No style or aspect ratio (derived from source)
 * - img2vid:ref2vid: Shows aspect ratio but no style
 */
export const viduGraph = new DataGraph<ViduCtx, GenerationCtx>()
  // Seed node
  .node('seed', seedNode())

  // Prompt enhancer toggle
  .node('enablePromptEnhancer', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: true,
  })

  // Style node - only for txt2vid workflow
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

  // Aspect ratio node - only for txt2vid and ref2vid workflows
  .node(
    'aspectRatio',
    (ctx) => {
      const showAspectRatio = ctx.workflow === 'txt2vid' || ctx.workflow === 'img2vid:ref2vid';
      return {
        ...aspectRatioNode({ options: viduAspectRatios, defaultValue: '1:1' }),
        when: showAspectRatio,
      };
    },
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
