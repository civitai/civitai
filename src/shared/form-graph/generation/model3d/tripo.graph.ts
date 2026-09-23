import { z } from 'zod';
import { defineGraph } from 'form-graph';
import { SEED, boolDef, enumDef, imagesDef } from '../defs';
import { familyScope, type FamilyExt } from '../shared';

/**
 * Tripo (via Fal), ported from `tripo-graph.ts`. Image-to-3D only — no text
 * branch, no version discriminator.
 */

// ---- copied from tripo-graph.ts, which dies with the data-graph engine ------

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

// ---- end of tripo-graph.ts copies -------------------------------------------

export const tripo = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', imagesDef({ min: 1, max: 1 }))
  .field('texture', enumDef({ options: tripoTextureOptions, default: 'standard' }))
  .field('pbr', boolDef(false))
  .field('quad', boolDef(false))
  .field('autoSize', boolDef(false))
  // optional — omitted means Tripo auto-selects the face count
  .field('faceLimit', {
    input: z.coerce.number().int().min(TRIPO_MIN_FACE_LIMIT).max(TRIPO_MAX_FACE_LIMIT).optional(),
    output: z.number().int().min(TRIPO_MIN_FACE_LIMIT).max(TRIPO_MAX_FACE_LIMIT).optional(),
    default: undefined,
    meta: { min: TRIPO_MIN_FACE_LIMIT, max: TRIPO_MAX_FACE_LIMIT, placeholder: 'Auto' },
  })
  .field(
    'textureAlignment',
    enumDef({ options: tripoTextureAlignmentOptions, default: 'original_image' })
  )
  .field('orientation', enumDef({ options: tripoOrientationOptions, default: 'default' }))
  .field('seed', SEED)
  .field('textureSeed', SEED);

export { TRIPO_MIN_FACE_LIMIT, TRIPO_MAX_FACE_LIMIT };
