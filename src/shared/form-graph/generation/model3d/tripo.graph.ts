import { z } from 'zod';
import { cachedFactory, defineGraph } from 'form-graph';
import { MAX_RANDOM_SEED } from '~/shared/constants/generation.constants';
import { clampCorrect, boolDef, enumDef, imagesDef, seedDef, textDef } from '../defs';
import { familyScope, type FamilyExt } from '../shared';

/**
 * Tripo (via Fal). `version` is a control, clamped by workflow. H3.1 takes
 * text, one image, or 2–4 views of one object (sent as multiview); v2.5 takes one image.
 */

export const tripoVersions = ['v2.5', 'h3.1'] as const;
export type TripoVersion = (typeof tripoVersions)[number];

export const tripoVersionOptions = [
  { label: 'H3.1', value: 'h3.1' as const, description: 'Text-to-3D, or 1-4 views of one object.' },
  // imageOnly: the form switches a text-to-3D user to image-to-3D on picking it
  { label: 'v2.5', value: 'v2.5' as const, description: 'One source image.', imageOnly: true },
];

/** Tripo v2.5 has no text-to-3D operation — v2.5-on-text clamps to H3.1. */
export function isTripoVersionRunnable(version: TripoVersion, workflow: string) {
  return version === 'h3.1' || !workflow.startsWith('txt');
}

export const tripoTextureOptions = [
  { label: 'None', value: 'no' as const },
  { label: 'Standard', value: 'standard' as const },
  { label: 'HD', value: 'HD' as const },
];

export const tripoGeometryQualityOptions = [
  { label: 'Standard', value: 'standard' as const },
  { label: 'Detailed', value: 'detailed' as const },
];

export const tripoTextureAlignmentOptions = [
  { label: 'Original image', value: 'original_image' as const },
  { label: 'Geometry', value: 'geometry' as const },
];

export const tripoOrientationOptions = [
  { label: 'Default', value: 'default' as const },
  { label: 'Align to image', value: 'align_image' as const },
];

const TRIPO_MIN_FACE_LIMIT = 1_000;
const TRIPO_MAX_FACE_LIMIT: Record<TripoVersion, number> = { 'v2.5': 500_000, 'h3.1': 2_000_000 };

const TRIPO_MAX_PROMPT_LENGTH = 1024;
const TRIPO_H31_MAX_VIEWS = 4;

const tripoVersionDef = cachedFactory((workflow: string) => {
  const clamp = (v?: TripoVersion) =>
    v && isTripoVersionRunnable(v, workflow) ? v : ('h3.1' as const);
  return {
    input: z.enum(tripoVersions).optional().transform(clamp),
    output: z.enum(tripoVersions).transform(clamp),
    default: 'h3.1' as const,
    meta: {
      options: tripoVersionOptions,
      info: 'H3.1 adds text-to-3D and accepts up to four views of the same object, in the order front, left, back, right. v2.5 takes one source image.',
    },
  };
});

// optional — omitted means Tripo auto-selects the face count
const tripoFaceLimitDef = cachedFactory((version: TripoVersion) => {
  const max = TRIPO_MAX_FACE_LIMIT[version];
  return {
    input: z.coerce.number().int().min(TRIPO_MIN_FACE_LIMIT).max(max).optional(),
    output: z.number().int().min(TRIPO_MIN_FACE_LIMIT).max(max).optional(),
    default: undefined,
    // Clamp rather than clear: an out-of-range face limit came from somewhere, and
    // dropping it silently reverts the user to 'Auto'.
    correct: clampCorrect({ min: TRIPO_MIN_FACE_LIMIT, max, fallback: TRIPO_MIN_FACE_LIMIT }),
    meta: { min: TRIPO_MIN_FACE_LIMIT, max, placeholder: 'Auto' },
  };
});

export const tripo = defineGraph<FamilyExt>({ scope: familyScope })
  .field('version', ({ _ext }) => tripoVersionDef(_ext.workflow))
  .field('images', ({ version, _ext }) => {
    if (_ext.workflow.startsWith('txt')) return null;
    const max = version === 'h3.1' ? TRIPO_H31_MAX_VIEWS : 1;
    return {
      ...imagesDef({ min: 1, max }),
      // H3.1's views truncate on a v2.5 switch instead of failing max(1) at validate
      correct: (value: unknown) =>
        Array.isArray(value) && value.length > max
          ? { value: value.slice(0, max), reason: 'image_limit' }
          : undefined,
    };
  })
  .field('prompt', ({ _ext }) => {
    if (!_ext.workflow.startsWith('txt')) return null;
    return {
      ...textDef('prompt', TRIPO_MAX_PROMPT_LENGTH),
      refine: (output: z.ZodString) =>
        output.refine((v) => v.trim().length > 0, { message: 'Prompt is required' }),
      meta: {
        required: true,
        targetKey: 'prompt',
        snippets: undefined,
        triggerWords: [],
        info: 'Describe the 3D model you want to generate.',
        placeholder: 'A low-poly fantasy treasure chest…',
      },
    };
  })
  .field('texture', enumDef({ options: tripoTextureOptions, default: 'standard' }))
  .field('geometryQuality', ({ version }) =>
    version === 'h3.1'
      ? enumDef({ options: tripoGeometryQualityOptions, default: 'standard' })
      : null
  )
  .field('enablePbr', boolDef(false))
  .field('quad', boolDef(false))
  .field('autoSize', boolDef(false))
  // optional — omitted means Tripo auto-selects the face count
  .field('faceLimit', ({ version }) => tripoFaceLimitDef(version))
  .field('textureAlignment', ({ _ext }) =>
    _ext.workflow.startsWith('txt')
      ? null
      : enumDef({ options: tripoTextureAlignmentOptions, default: 'original_image' })
  )
  .field('orientation', ({ _ext }) =>
    _ext.workflow.startsWith('txt')
      ? null
      : enumDef({ options: tripoOrientationOptions, default: 'default' })
  )
  // Tripo takes signed 32-bit seeds
  .field('seed', seedDef(MAX_RANDOM_SEED))
  .field('textureSeed', seedDef(MAX_RANDOM_SEED));

export { TRIPO_MIN_FACE_LIMIT, TRIPO_MAX_FACE_LIMIT };
