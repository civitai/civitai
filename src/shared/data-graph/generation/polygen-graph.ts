/**
 * PolyGen Graph
 *
 * Controls for the PolyGen (Meshy via Fal) 3D-model generation ecosystem,
 * covering BOTH Meshy versions behind one ecosystem entry — the version is a
 * control in the form (`polygenVersion`), not a second row in the "Eco" picker.
 *
 * Supports two workflows:
 * - txt2model3d: prompt → 3D model  (v6 only — v7 has no text-to-3D operation)
 * - img2model3d: source image(s) → 3D model
 *
 * Version differences, all expressed as `when` on `polygenVersion`:
 * - v6: text-to-3D branch (prompt/mode/prompt-expansion), one source image,
 *   `seed`.
 * - v7: 1-4 source images (1 ⇒ imageTo3D, 2-4 ⇒ multiImageTo3D), `poseMode`,
 *   `ultraMode` + `modelType` (single-image only), and `riggingHeightMeters` +
 *   `animationActionId` while animation is on. No seed — the orchestrator type
 *   only carries one on the v6 branch.
 *
 * Follows the standard convention (happy-horse/kling/wan): a single flat set of
 * nodes gated by `when`, rather than an internal discriminator. The orchestrator
 * schemas (`polygen.schema.ts` / `polygen-v7.schema.ts`) discriminate on
 * `process`, which the handler derives from `workflow` + version + image count.
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { GenerationCtx } from './context';
import { enumNode, imagesNode, seedNode, sliderNode, textNode } from './common';

// =============================================================================
// Constants
// =============================================================================

export const polygenVersions = ['v6', 'v7'] as const;
export type PolygenVersion = (typeof polygenVersions)[number];

export const polygenVersionOptions = [
  {
    label: 'v6',
    value: 'v6' as const,
    description: 'Text-to-3D, or one source image.',
  },
  {
    label: 'v7',
    value: 'v7' as const,
    description:
      'Higher-fidelity geometry from 1-4 images. No text-to-3D — choosing it switches you to Image to 3D.',
  },
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

export const polygenPoseModeOptions = [
  { label: 'Auto', value: 'none' as const },
  { label: 'A-pose', value: 'a-pose' as const },
  { label: 'T-pose', value: 't-pose' as const },
];

export const polygenModelTypeOptions = [
  { label: 'Standard', value: 'standard' as const },
  { label: 'Low poly', value: 'lowpoly' as const },
];

const POLYGEN_MIN_POLYCOUNT = 100;
const POLYGEN_MAX_POLYCOUNT = 300_000;
const POLYGEN_DEFAULT_POLYCOUNT = 30_000;

const POLYGEN_MAX_PROMPT_LENGTH = 600;
const POLYGEN_MAX_TEXTURE_PROMPT_LENGTH = 600;

const POLYGEN_V7_MAX_IMAGES = 4;

const POLYGEN_MIN_RIGGING_HEIGHT = 0.1;
const POLYGEN_MAX_RIGGING_HEIGHT = 10;
const POLYGEN_DEFAULT_RIGGING_HEIGHT = 1.7;

const POLYGEN_MIN_ANIMATION_ACTION_ID = 0;
const POLYGEN_MAX_ANIMATION_ACTION_ID = 10_000;

const polygenPolycountPresets = [
  { label: '5k', value: 5_000 },
  { label: '30k', value: 30_000 },
  { label: '100k', value: 100_000 },
  { label: '300k', value: 300_000 },
];

/**
 * Which versions the picker RENDERS. Gated only by the flag, deliberately not
 * by the workflow: both buttons stay on screen for a flagged user whichever
 * workflow they're on, so the choice is always discoverable. (Restricting this
 * by workflow too meant the whole control vanished on `txt2model3d` — the 3D
 * category's default — and the choice was invisible.)
 *
 * Dropping v7 is the flag gate: an absent option both hides it client-side and
 * makes a submitted `v7` clamp back to v6 (see the node's input transform).
 * Fail-closed — absent `ext.flags` leaves v6 as the only choice.
 */
export function getPolygenVersionOptions(flags?: Partial<FeatureAccess>) {
  return flags?.meshyV7Generator === true ? polygenVersionOptions : [polygenVersionOptions[0]];
}

/**
 * Which versions are actually RUNNABLE on a workflow. Meshy v7 has no
 * text-to-3D operation, so it cannot run `txt2model3d`. Choosing v7 there moves
 * the user to `img2model3d` (the form sets both in one `graph.set`); anything
 * that still arrives as v7-on-text is clamped to v6 rather than handed to the
 * v7 builder, which would dereference a source image that cannot exist.
 */
export function isPolygenVersionRunnable(version: PolygenVersion, workflow: string) {
  return version === 'v6' || !workflow.startsWith('txt');
}

// =============================================================================
// PolyGen Graph
// =============================================================================

type PolyGenCtx = {
  ecosystem: string;
  workflow: string;
  polygenVersion: PolygenVersion;
  images?: Array<{ url: string }>;
  enableAnimation?: boolean;
};

export const polyGenGraph = new DataGraph<PolyGenCtx, GenerationCtx>()
  // --- Version selector (drives every `when` below) ---
  .node(
    'polygenVersion',
    (ctx, ext) => {
      // `options` is what renders (flag-gated); the input transform is what
      // validates (flag- AND workflow-gated), clamping anything unrunnable back
      // to v6 rather than erroring — same graceful degradation the ecosystem
      // picker uses for a stale selection.
      const options = getPolygenVersionOptions(ext.flags);
      const offered = new Set(options.map((o) => o.value));
      const clamp = (v?: PolygenVersion) =>
        v && offered.has(v) && isPolygenVersionRunnable(v, ctx.workflow) ? v : ('v6' as const);
      return {
        input: z.enum(polygenVersions).optional().transform(clamp),
        output: z.enum(polygenVersions).transform(clamp),
        defaultValue: 'v6' as const,
        meta: { options },
      };
    },
    ['workflow', 'ext:flags']
  )

  // --- Text-to-3D fields (v6 only; v7 has no text branch) ---
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
  // v7 takes up to four views of the same object; v6 takes exactly one.
  .node(
    'images',
    (ctx) => {
      const isV7 = ctx.polygenVersion === 'v7';
      return {
        ...imagesNode({
          min: 1,
          max: isV7 ? POLYGEN_V7_MAX_IMAGES : 1,
          label: isV7 ? 'Starting images' : 'Starting image',
          description: isV7
            ? // The second sentence is why "Ultra fidelity" and "Low poly" vanish
              // when a second image is added — without it that looks like a bug.
              'One image, or 2-4 views of the same object. Ultra fidelity and Low poly are single-image only.'
            : 'The reference Meshy will use to build the 3D mesh',
        }),
        when: !ctx.workflow.startsWith('txt'),
      };
    },
    ['workflow', 'polygenVersion']
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

  // --- Shared Meshy controls (both workflows, both versions) ---
  .node(
    'targetPolycount',
    sliderNode({
      min: POLYGEN_MIN_POLYCOUNT,
      max: POLYGEN_MAX_POLYCOUNT,
      step: 100,
      defaultValue: POLYGEN_DEFAULT_POLYCOUNT,
      presets: polygenPolycountPresets,
    })
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

  // --- v7-only controls ---
  .node(
    'poseMode',
    (ctx) => ({
      ...enumNode({ options: polygenPoseModeOptions, defaultValue: 'none' as const }),
      when: ctx.polygenVersion === 'v7',
    }),
    ['polygenVersion']
  )
  // Ultra fidelity and the low-poly preset are single-image only — Meshy has no
  // equivalent on the multi-view operation.
  .node(
    'ultraMode',
    (ctx) => ({
      input: z.boolean().optional(),
      output: z.boolean(),
      defaultValue: false,
      when: ctx.polygenVersion === 'v7' && (ctx.images?.length ?? 0) <= 1,
    }),
    ['polygenVersion', 'images']
  )
  .node(
    'modelType',
    (ctx) => ({
      ...enumNode({ options: polygenModelTypeOptions, defaultValue: 'standard' as const }),
      when: ctx.polygenVersion === 'v7' && (ctx.images?.length ?? 0) <= 1,
    }),
    ['polygenVersion', 'images']
  )
  // Rigging height and the animation preset are only read when the mesh is
  // rigged/animated, which the single "Animate" toggle drives.
  .node(
    'riggingHeightMeters',
    (ctx) => ({
      ...sliderNode({
        min: POLYGEN_MIN_RIGGING_HEIGHT,
        max: POLYGEN_MAX_RIGGING_HEIGHT,
        step: 0.1,
        defaultValue: POLYGEN_DEFAULT_RIGGING_HEIGHT,
      }),
      when: ctx.polygenVersion === 'v7' && ctx.enableAnimation === true,
    }),
    ['polygenVersion', 'enableAnimation']
  )
  .node(
    'animationActionId',
    (ctx) => ({
      input: z.coerce
        .number()
        .int()
        .min(POLYGEN_MIN_ANIMATION_ACTION_ID)
        .max(POLYGEN_MAX_ANIMATION_ACTION_ID)
        .optional(),
      output: z
        .number()
        .int()
        .min(POLYGEN_MIN_ANIMATION_ACTION_ID)
        .max(POLYGEN_MAX_ANIMATION_ACTION_ID)
        .optional(),
      defaultValue: POLYGEN_MIN_ANIMATION_ACTION_ID,
      meta: {
        min: POLYGEN_MIN_ANIMATION_ACTION_ID,
        max: POLYGEN_MAX_ANIMATION_ACTION_ID,
        placeholder: '0 (Idle)',
      },
      when: ctx.polygenVersion === 'v7' && ctx.enableAnimation === true,
    }),
    ['polygenVersion', 'enableAnimation']
  )

  // Meshy v6 accepts a 32-bit signed int seed; we keep it optional so the
  // workflow handler can randomize when omitted. v7 has no seed.
  .node('seed', (ctx) => ({ ...seedNode(), when: ctx.polygenVersion !== 'v7' }), [
    'polygenVersion',
  ]);

export type PolyGenGraphCtx = ReturnType<typeof polyGenGraph.init>;

// Export constants for use in components
export {
  POLYGEN_MIN_POLYCOUNT,
  POLYGEN_MAX_POLYCOUNT,
  POLYGEN_DEFAULT_POLYCOUNT,
  POLYGEN_MAX_PROMPT_LENGTH,
  POLYGEN_MAX_TEXTURE_PROMPT_LENGTH,
  POLYGEN_V7_MAX_IMAGES,
  POLYGEN_MIN_RIGGING_HEIGHT,
  POLYGEN_MAX_RIGGING_HEIGHT,
  POLYGEN_MIN_ANIMATION_ACTION_ID,
  POLYGEN_MAX_ANIMATION_ACTION_ID,
  polygenPolycountPresets,
};
