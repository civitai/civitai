/**
 * PolyGen Graph
 *
 * Controls for the PolyGen (Meshy via Fal) 3D-model generation ecosystem.
 *
 * Supports two workflows:
 * - txt2model3d (process = 'textTo3D'): prompt → 3D model
 * - img2model3d (process = 'imageTo3D'): source image → 3D model
 *
 * Shape mirrors `ace-audio-graph.ts`: a top-level discriminator (`process`)
 * gates per-process subgraphs while shared Meshy controls (targetPolycount,
 * topology, symmetryMode, etc.) live above the discriminator so both branches
 * inherit them via the subgraph ctx.
 *
 * The corresponding handler (`polygen.handler.ts`) consumes the validated
 * snapshot and emits a `PolyGenStepTemplate` matching the schema in
 * `src/server/orchestrator/polygen/polygen.schema.ts`.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { seedNode, sliderNode, textNode } from './common';

// =============================================================================
// Constants
// =============================================================================

export const polygenProcessOptions = [
  { label: 'Text to 3D', value: 'textTo3D' as const },
  { label: 'Image to 3D', value: 'imageTo3D' as const },
];

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
// Source image schema (image-to-3D)
// =============================================================================

/**
 * Minimal source-image shape — matches what `ImageUploadMultipleInput` emits.
 * The orchestrator submission layer extracts `.url` only; width/height ride
 * along for UI sanity (preview render) but the orchestrator only requires
 * the URL.
 */
const polygenSourceImageSchema = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
});

export type PolygenSourceImage = z.infer<typeof polygenSourceImageSchema>;

// =============================================================================
// Subgraph context
// =============================================================================

/** Context shape inherited by polygen process subgraphs. */
type PolyGenProcessCtx = {
  ecosystem: string;
  workflow: string;
  process: 'textTo3D' | 'imageTo3D';
};

// =============================================================================
// Text-to-3D subgraph
// =============================================================================

const textTo3DGraph = new DataGraph<PolyGenProcessCtx, GenerationCtx>()
  // Use the shared `textNode` factory so the prompt's meta shape matches the
  // single-source-of-truth in `common.ts` (`{ required, targetKey, snippets,
  // triggerWords, placeholder, info }`). This keeps the meta union
  // compatible with the existing prompt Controller in GenerationForm.tsx.
  .node(
    'prompt',
    textNode({
      name: 'prompt',
      required: true,
      emptyMessage: 'Prompt is required',
      maxLength: POLYGEN_MAX_PROMPT_LENGTH,
      placeholder: 'A low-poly fantasy treasure chest…',
    })
  )
  // Named `polygenMode` (not `mode`) to avoid colliding with the standard
  // `mode` Radio.Group Controller in `GenerationForm.tsx` (Kling
  // standard/professional). The handler maps this back to the schema's
  // `mode` field before forwarding to `toMeshyPolyGenInput`.
  .node('polygenMode', {
    input: z.enum(['preview', 'full']).optional(),
    output: z.enum(['preview', 'full']),
    defaultValue: 'full' as const,
    meta: { options: polygenTextModeOptions },
  })
  .node('enablePromptExpansion', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  });

// =============================================================================
// Image-to-3D subgraph
// =============================================================================

const imageTo3DGraph = new DataGraph<PolyGenProcessCtx, GenerationCtx>()
  .node('sourceImage', {
    input: polygenSourceImageSchema.optional(),
    output: polygenSourceImageSchema,
    defaultValue: undefined,
    meta: {
      required: true,
    },
  })
  .node('shouldTexture', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: true,
  });

// =============================================================================
// PolyGen Graph (top-level)
// =============================================================================

type PolyGenCtx = { ecosystem: string; workflow: string };

export const polyGenGraph = new DataGraph<PolyGenCtx, GenerationCtx>()
  // Process is driven entirely by `workflow` — the V2 form collapses
  // "workflow" and "process" into the single Text-to-3D / Image-to-3D
  // toggle at the top of the panel (mirrors the Image segment's
  // txt2img/img2img toggle). The `transform` re-syncs process whenever
  // workflow changes so the user can't get them out-of-step, and the
  // process Controller is intentionally NOT rendered in the form.
  .node(
    'process',
    (ctx) => {
      const processForWorkflow = ctx.workflow === 'img2model3d' ? 'imageTo3D' : 'textTo3D';
      return {
        input: z.enum(['textTo3D', 'imageTo3D']).optional(),
        output: z.enum(['textTo3D', 'imageTo3D']),
        defaultValue: processForWorkflow as 'textTo3D' | 'imageTo3D',
        meta: { options: polygenProcessOptions },
        // Force process to follow workflow on workflow-change so the
        // graph stays consistent with whichever segment is active.
        transform: () => processForWorkflow as 'textTo3D' | 'imageTo3D',
      };
    },
    ['workflow']
  )

  // Shared Meshy controls — both processes consume these.
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
  .node('seed', seedNode())

  // Discriminate per process. Per-process fields live in the subgraphs above.
  .discriminator('process', {
    textTo3D: textTo3DGraph,
    imageTo3D: imageTo3DGraph,
  });

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
