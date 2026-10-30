import { z } from 'zod';
import { defineGraph } from 'form-graph';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { clampCorrect, SEED, boolDef, enumDef, imagesDef } from '../defs';
import { familyScope, type FamilyExt } from '../shared';

/**
 * Tripo (via Fal). Image-to-3D only — no text branch. `tripoVersion` picks
 * v2.5 (one image) or H3.1 (one image, or 2–4 views for multiview), and is
 * flag-gated the way PolyGen's `polygenVersion` is: H3.1 needs `tripoH31Generator`.
 */

export const tripoVersions = ['v2.5', 'h3.1'] as const;
export type TripoVersion = (typeof tripoVersions)[number];

export const tripoVersionOptions = [
  { label: 'v2.5', value: 'v2.5' as const, description: 'One source image.' },
  {
    label: 'H3.1',
    value: 'h3.1' as const,
    description:
      'Higher-detail geometry from one image, or 2-4 views ordered front, left, back, right.',
  },
];

export const tripoGeometryQualityOptions = [
  { label: 'Standard', value: 'standard' as const },
  { label: 'Detailed', value: 'detailed' as const },
];

/** Gated by the flag only — H3.1 runs on every workflow Tripo is offered on. */
export function getTripoVersionOptions(flags?: Partial<FeatureAccess>) {
  return flags?.tripoH31Generator === true ? tripoVersionOptions : [tripoVersionOptions[0]];
}

/** What a submitted version runs as: anything not offered to this user clamps to v2.5. */
export function resolveTripoVersion(
  version: TripoVersion | undefined,
  flags?: Partial<FeatureAccess>
) {
  return version && getTripoVersionOptions(flags).some((o) => o.value === version)
    ? version
    : ('v2.5' as const);
}

export const tripoTextureOptions = [
  { label: 'None', value: 'no' as const },
  { label: 'Standard', value: 'standard' as const },
  { label: 'HD', value: 'HD' as const },
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
const TRIPO_MAX_FACE_LIMIT = 500_000;
const TRIPO_H31_MAX_FACE_LIMIT = 2_000_000;
const TRIPO_H31_MAX_IMAGES = 4;

export const tripo = defineGraph<FamilyExt>({ scope: familyScope })
  .field('tripoVersion', ({ _ext }) => {
    const options = getTripoVersionOptions(_ext.flags);
    const clamp = (v?: TripoVersion) => resolveTripoVersion(v, _ext.flags);
    return {
      input: z.enum(tripoVersions).optional().transform(clamp),
      output: z.enum(tripoVersions).transform(clamp),
      default: 'v2.5' as const,
      meta: { options },
    };
  })
  .field('images', ({ tripoVersion }) => {
    const max = tripoVersion === 'h3.1' ? TRIPO_H31_MAX_IMAGES : 1;
    return imagesDef({ min: 1, max });
  })
  .field('texture', enumDef({ options: tripoTextureOptions, default: 'standard' }))
  .field('pbr', boolDef(false))
  .field('quad', boolDef(false))
  .field('autoSize', boolDef(false))
  // optional — omitted means Tripo auto-selects the face count
  .field('faceLimit', ({ tripoVersion }) => {
    const max = tripoVersion === 'h3.1' ? TRIPO_H31_MAX_FACE_LIMIT : TRIPO_MAX_FACE_LIMIT;
    return {
      input: z.coerce.number().int().min(TRIPO_MIN_FACE_LIMIT).max(max).optional(),
      output: z.number().int().min(TRIPO_MIN_FACE_LIMIT).max(max).optional(),
      default: undefined,
      // Clamp rather than clear: an out-of-range face limit came from somewhere, and
      // dropping it silently reverts the user to 'Auto'.
      correct: clampCorrect({ min: TRIPO_MIN_FACE_LIMIT, max, fallback: TRIPO_MIN_FACE_LIMIT }),
      meta: { min: TRIPO_MIN_FACE_LIMIT, max, placeholder: 'Auto' },
    };
  })
  .field('geometryQuality', ({ tripoVersion }) =>
    tripoVersion === 'h3.1'
      ? enumDef({ options: tripoGeometryQualityOptions, default: 'standard' })
      : null
  )
  .field(
    'textureAlignment',
    enumDef({ options: tripoTextureAlignmentOptions, default: 'original_image' })
  )
  .field('orientation', enumDef({ options: tripoOrientationOptions, default: 'default' }))
  .field('seed', SEED)
  .field('textureSeed', SEED);

export {
  TRIPO_MIN_FACE_LIMIT,
  TRIPO_MAX_FACE_LIMIT,
  TRIPO_H31_MAX_FACE_LIMIT,
  TRIPO_H31_MAX_IMAGES,
};
