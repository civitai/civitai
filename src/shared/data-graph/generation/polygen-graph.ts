/**
 * PolyGen Graph
 *
 * Controls for the PolyGen (Meshy via Fal) 3D-model generation ecosystem.
 *
 * Supports two workflows:
 * - txt2model3d: prompt → 3D model
 * - img2model3d: source image → 3D model
 *
 * Follows the standard convention (happy-horse/kling/wan): a single flat set of
 * nodes whose per-workflow fields are gated by `when` on `workflow`, rather than
 * an internal discriminator. The orchestrator schema
 * (`src/server/orchestrator/polygen/polygen.schema.ts`) discriminates on
 * `process` (textTo3D/imageTo3D), which the handler derives from `workflow`.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { imagesNode, seedNode, sliderNode, textNode } from './common';

// =============================================================================
// Constants
// =============================================================================

export const polygenTextModeOptions = [
  { label: 'Preview', value: 'preview' as const },
  { label: 'Full', value: 'full' as const },
];

export const polygenTopologyOptions = [
  { label: 'Triangle', value: 'triangle' as const },
  { label: 'Quad', value: 'quad' as const },
];

export const polygenSymmetryOptions = [
  { label: 'Off', value: 'off' as const },
  { label: 'Auto', value: 'auto' as const },
  { label: 'On', value: 'on' as const },
];

const POLYGEN_MIN_POLYCOUNT = 100;
const POLYGEN_MAX_POLYCOUNT = 300_000;
const POLYGEN_DEFAULT_POLYCOUNT = 30_000;

const POLYGEN_MAX_PROMPT_LENGTH = 600;
const POLYGEN_MAX_TEXTURE_PROMPT_LENGTH = 600;

const polygenPolycountPresets = [
  { label: '5k', value: 5_000 },
  { label: '30k', value: 30_000 },
  { label: '100k', value: 100_000 },
  { label: '300k', value: 300_000 },
];

// =============================================================================
// PolyGen Graph
// =============================================================================

type PolyGenCtx = { ecosystem: string; workflow: string };

export const polyGenGraph = new DataGraph<PolyGenCtx, GenerationCtx>()
  // --- Text-to-3D fields (hidden for img2model3d) ---
  .node(
    'prompt',
    (ctx) => ({
      ...textNode({
        name: 'prompt',
        required: true,
        emptyMessage: 'Prompt is required',
        maxLength: POLYGEN_MAX_PROMPT_LENGTH,
        placeholder: 'A low-poly fantasy treasure chest…',
      }),
      when: ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  // Named `polygenMode` (not `mode`) to avoid colliding with the standard `mode`
  // Controller in GenerationForm.tsx; the handler maps it back to `mode`.
  .node(
    'polygenMode',
    (ctx) => ({
      input: z.enum(['preview', 'full']).optional(),
      output: z.enum(['preview', 'full']),
      defaultValue: 'full' as const,
      meta: { options: polygenTextModeOptions },
      when: ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  .node(
    'enablePromptExpansion',
    (ctx) => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: false,
      when: ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )

  // --- Image-to-3D fields (hidden for txt2model3d) ---
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({
        min: 1,
        max: 1,
        label: 'Starting image',
        description: 'The reference Meshy will use to build the 3D mesh',
      }),
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )
  .node(
    'shouldTexture',
    (ctx) => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: true,
      when: !ctx.workflow.startsWith('txt'),
    }),
    ['workflow']
  )

  // --- Shared Meshy controls (both workflows) ---
  .node(
    'targetPolycount',
    () =>
      sliderNode({
        min: POLYGEN_MIN_POLYCOUNT,
        max: POLYGEN_MAX_POLYCOUNT,
        step: 100,
        defaultValue: POLYGEN_DEFAULT_POLYCOUNT,
        presets: polygenPolycountPresets,
      }),
    []
  )
  .node('topology', {
    input: z.enum(['quad', 'triangle']).optional(),
    output: z.enum(['quad', 'triangle']),
    defaultValue: 'triangle' as const,
    meta: { options: polygenTopologyOptions },
  })
  .node('symmetryMode', {
    input: z.enum(['off', 'auto', 'on']).optional(),
    output: z.enum(['off', 'auto', 'on']),
    defaultValue: 'auto' as const,
    meta: { options: polygenSymmetryOptions },
  })
  .node('shouldRemesh', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: true,
  })
  .node('enablePbr', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  .node('texturePrompt', {
    input: z.string().optional(),
    output: z
      .string()
      .trim()
      .max(POLYGEN_MAX_TEXTURE_PROMPT_LENGTH, 'Texture prompt is too long')
      .optional(),
    defaultValue: '',
    meta: {
      placeholder: 'Weathered oak with bronze fittings…',
      maxLength: POLYGEN_MAX_TEXTURE_PROMPT_LENGTH,
    },
  })
  .node('enableRigging', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  .node('enableAnimation', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  // Meshy accepts a 32-bit signed int seed; we keep it optional so the
  // workflow handler can randomize when omitted.
  .node('seed', seedNode());

export type PolyGenGraphCtx = ReturnType<typeof polyGenGraph.init>;

// Export constants for use in components
export {
  POLYGEN_MIN_POLYCOUNT,
  POLYGEN_MAX_POLYCOUNT,
  POLYGEN_DEFAULT_POLYCOUNT,
  POLYGEN_MAX_PROMPT_LENGTH,
  POLYGEN_MAX_TEXTURE_PROMPT_LENGTH,
  polygenPolycountPresets,
};
