import { z } from 'zod';
import { defineGraph } from 'form-graph';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import {
  truncateCoerce,
  clampCorrect,
  SEED,
  boolDef,
  enumDef,
  imagesDef,
  sliderDef,
  textDef,
} from '../defs';
import { familyScope, type FamilyExt } from '../shared';

/**
 * PolyGen (Meshy via Fal). Every Meshy version
 * behind one ecosystem — `polygenVersion` is a control, flag-gated (v7 needs
 * `meshyV7Generator`, v7.1 `meshyV71Generator`) and workflow-clamped (v7 has
 * no text-to-3D, so v7-on-text clamps back to v6). Flat field set gated per
 * version/workflow, conditional on the same fields.
 */

export const polygenVersions = ['v6', 'v7', 'v7.1'] as const;
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
  {
    label: 'v7.1',
    value: 'v7.1' as const,
    description: 'Text-to-3D or 1-4 images, with smart topology and up to 4K geometry resolution.',
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

export const polygenV71ModelTypeOptions = [
  { label: 'Standard', value: 'standard' as const },
  { label: 'Smart topology', value: 'smart-topology' as const },
];

export const polygenGeometryResolutionOptions = [
  { label: 'Standard', value: 'standard' as const },
  { label: '2K', value: '2k' as const },
  { label: '4K', value: '4k' as const },
];

const polygenMultiImageGeometryResolutionOptions = polygenGeometryResolutionOptions.slice(0, 2);

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
const POLYGEN_MAX_ANIMATION_ACTION_ID = 696;

const polygenPolycountPresets = [
  { label: '5k', value: 5_000 },
  { label: '30k', value: 30_000 },
  { label: '100k', value: 100_000 },
  { label: '300k', value: 300_000 },
];

/** Gated only by the flag, not the workflow, so the choice stays discoverable. */
export function getPolygenVersionOptions(flags?: Partial<FeatureAccess>) {
  return polygenVersionOptions.filter(
    ({ value }) =>
      value === 'v6' ||
      (value === 'v7' && flags?.meshyV7Generator === true) ||
      (value === 'v7.1' && flags?.meshyV71Generator === true)
  );
}

/** v7 and v7.1 share the multi-image input and the pose/rigging/animation controls. */
function isV7Line(version: PolygenVersion | undefined) {
  return version === 'v7' || version === 'v7.1';
}

/** Meshy v7 has no text-to-3D operation — v7-on-text clamps back to v6. */
export function isPolygenVersionRunnable(version: PolygenVersion, workflow: string) {
  return version !== 'v7' || !workflow.startsWith('txt');
}

export const polygen = defineGraph<FamilyExt>({ scope: familyScope })
  .field('polygenVersion', ({ _ext }) => {
    // options render flag-gated; the transforms validate flag- AND
    // workflow-gated, clamping anything unrunnable to v6 rather than erroring
    const options = getPolygenVersionOptions(_ext.flags);
    const offered = new Set(options.map((o) => o.value));
    const clamp = (v?: PolygenVersion) =>
      v && offered.has(v) && isPolygenVersionRunnable(v, _ext.workflow) ? v : ('v6' as const);
    return {
      input: z.enum(polygenVersions).optional().transform(clamp),
      output: z.enum(polygenVersions).transform(clamp),
      default: 'v6' as const,
      meta: { options },
    };
  })
  // --- text-to-3D fields (v6 only; v7 has no text branch) ---
  .field('prompt', ({ _ext }) => {
    if (!_ext.workflow.startsWith('txt')) return null;
    return {
      ...textDef('prompt', POLYGEN_MAX_PROMPT_LENGTH),
      refine: (output: z.ZodString) =>
        output.refine((v) => v.trim().length > 0, { message: 'Prompt is required' }),
      meta: { required: true, targetKey: 'prompt', snippets: undefined, triggerWords: [] },
    };
  })
  .field('polygenMode', ({ _ext }) =>
    _ext.workflow.startsWith('txt')
      ? enumDef({ options: polygenTextModeOptions, default: 'full' })
      : null
  )
  .field('enablePromptExpansion', ({ _ext }) =>
    _ext.workflow.startsWith('txt') ? boolDef(false) : null
  )
  // --- image-to-3D fields ---
  .field('images', ({ polygenVersion, _ext }) => {
    if (_ext.workflow.startsWith('txt')) return null;
    const max = isV7Line(polygenVersion) ? POLYGEN_V7_MAX_IMAGES : 1;
    return {
      ...imagesDef({ min: 1, max }),
      // v7's multi-image staging truncates on a v6 switch instead of failing
      // max(1) at validate; intent keeps the full set for the switch back
      correct: (value: unknown) =>
        Array.isArray(value) && value.length > max
          ? { value: value.slice(0, max), reason: 'image_limit' }
          : undefined,
    };
  })
  .field('shouldTexture', ({ _ext }) => (!_ext.workflow.startsWith('txt') ? boolDef(true) : null))
  // --- shared Meshy controls ---
  .field(
    'targetPolycount',
    sliderDef({
      min: POLYGEN_MIN_POLYCOUNT,
      max: POLYGEN_MAX_POLYCOUNT,
      step: 100,
      default: POLYGEN_DEFAULT_POLYCOUNT,
      presets: polygenPolycountPresets,
    })
  )
  .field('topology', enumDef({ options: polygenTopologyOptions, default: 'triangle' }))
  .field('symmetryMode', enumDef({ options: polygenSymmetryOptions, default: 'auto' }))
  .field('shouldRemesh', boolDef(true))
  .field('enablePbr', boolDef(false))
  .field('texturePrompt', {
    input: z.string().optional(),
    output: z
      .string()
      .trim()
      .max(POLYGEN_MAX_TEXTURE_PROMPT_LENGTH, 'Texture prompt is too long')
      .optional(),
    default: '',
    coerce: truncateCoerce(POLYGEN_MAX_TEXTURE_PROMPT_LENGTH),
    meta: {
      placeholder: 'Weathered oak with bronze fittings…',
      maxLength: POLYGEN_MAX_TEXTURE_PROMPT_LENGTH,
    },
  })
  .field('enableRigging', boolDef(false))
  .field('enableAnimation', boolDef(false))
  // --- v7-only controls ---
  .field('poseMode', ({ polygenVersion }) =>
    isV7Line(polygenVersion) ? enumDef({ options: polygenPoseModeOptions, default: 'none' }) : null
  )
  // ultra fidelity and the low-poly preset are single-image only
  .field('ultraMode', ({ polygenVersion, images }) =>
    polygenVersion === 'v7' && (images?.length ?? 0) <= 1 ? boolDef(false) : null
  )
  .field('modelType', ({ polygenVersion, images }) => {
    if ((images?.length ?? 0) > 1) return null;
    if (polygenVersion === 'v7')
      return enumDef({ options: polygenModelTypeOptions, default: 'standard' });
    if (polygenVersion === 'v7.1')
      return enumDef({ options: polygenV71ModelTypeOptions, default: 'standard' });
    return null;
  })
  // v7.1 only. 2K/4K need the standard model type; multi-image tops out at 2K.
  .field('geometryResolution', ({ polygenVersion, images, modelType }) => {
    if (polygenVersion !== 'v7.1') return null;
    if ((images?.length ?? 0) > 1)
      return enumDef({ options: polygenMultiImageGeometryResolutionOptions, default: 'standard' });
    if (modelType === 'smart-topology') return null;
    return enumDef({ options: polygenGeometryResolutionOptions, default: 'standard' });
  })
  .field('riggingHeightMeters', ({ polygenVersion, enableAnimation }) =>
    isV7Line(polygenVersion) && enableAnimation === true
      ? sliderDef({
          min: POLYGEN_MIN_RIGGING_HEIGHT,
          max: POLYGEN_MAX_RIGGING_HEIGHT,
          step: 0.1,
          default: POLYGEN_DEFAULT_RIGGING_HEIGHT,
        })
      : null
  )
  .field('animationActionId', ({ polygenVersion, enableAnimation }) =>
    isV7Line(polygenVersion) && enableAnimation === true
      ? {
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
          default: POLYGEN_MIN_ANIMATION_ACTION_ID,
          correct: clampCorrect({
            min: POLYGEN_MIN_ANIMATION_ACTION_ID,
            max: POLYGEN_MAX_ANIMATION_ACTION_ID,
            fallback: POLYGEN_MIN_ANIMATION_ACTION_ID,
          }),
          meta: {
            min: POLYGEN_MIN_ANIMATION_ACTION_ID,
            max: POLYGEN_MAX_ANIMATION_ACTION_ID,
            placeholder: '0 (Idle)',
          },
        }
      : null
  )
  // v6 takes a seed on both operations, v7.1 only on text-to-3D, v7 never
  .field('seed', ({ polygenVersion, _ext }) =>
    polygenVersion === 'v6' || (polygenVersion === 'v7.1' && _ext.workflow.startsWith('txt'))
      ? SEED
      : null
  );

export {
  POLYGEN_MIN_POLYCOUNT,
  POLYGEN_MAX_POLYCOUNT,
  POLYGEN_DEFAULT_POLYCOUNT,
  POLYGEN_MAX_PROMPT_LENGTH,
  POLYGEN_MAX_TEXTURE_PROMPT_LENGTH,
  POLYGEN_V7_MAX_IMAGES,
  POLYGEN_MIN_RIGGING_HEIGHT,
  POLYGEN_MAX_RIGGING_HEIGHT,
  POLYGEN_DEFAULT_RIGGING_HEIGHT,
  POLYGEN_MIN_ANIMATION_ACTION_ID,
  POLYGEN_MAX_ANIMATION_ACTION_ID,
  polygenPolycountPresets,
};
