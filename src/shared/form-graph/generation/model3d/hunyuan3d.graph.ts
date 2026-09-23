import { defineGraph } from 'form-graph';
import { SEED, boolDef, enumDef, imagesDef, sliderDef, textDef } from '../defs';
import { familyScope, type FamilyExt } from '../shared';

/**
 * Hunyuan3D (via Comfy), ported from `hunyuan3d-graph.ts`. Image-to-3D only.
 * Field names keep v1's `hunyuan*` prefixes — they exist so the fields don't
 * collide with the standard image Controllers, and the handler maps them back
 * to schema names.
 */

// ---- copied from hunyuan3d-graph.ts, which dies with the data-graph engine --

export const hunyuan3dModelVersionOptions = [
  { label: 'v2.1', value: 'v2.1' as const },
  { label: 'v2', value: 'v2' as const },
  { label: 'v2 Mini', value: 'v2-mini' as const },
];

export const hunyuan3dOctreeResolutionOptions = [
  { label: '256', value: 256 },
  { label: '384', value: 384 },
  { label: '512', value: 512 },
];

const HUNYUAN3D_MIN_STEPS = 10;
const HUNYUAN3D_MAX_STEPS = 50;
const HUNYUAN3D_DEFAULT_STEPS = 30;

const HUNYUAN3D_MIN_CFG_SCALE = 0;
const HUNYUAN3D_MAX_CFG_SCALE = 20;
const HUNYUAN3D_DEFAULT_CFG_SCALE = 5;

const HUNYUAN3D_MAX_PROMPT_LENGTH = 600;

// ---- end of hunyuan3d-graph.ts copies ---------------------------------------

export const hunyuan3d = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', imagesDef({ min: 1, max: 1 }))
  // optional texture/style hint — geometry comes from the image
  .field('hunyuanPrompt', textDef('hunyuanPrompt', HUNYUAN3D_MAX_PROMPT_LENGTH))
  .field('hunyuanModelVersion', enumDef({ options: hunyuan3dModelVersionOptions, default: 'v2.1' }))
  .field('shouldTexture', boolDef(true))
  .field('shouldRemesh', boolDef(true))
  .field('enablePbr', boolDef(false))
  .field(
    'hunyuanSteps',
    sliderDef({
      min: HUNYUAN3D_MIN_STEPS,
      max: HUNYUAN3D_MAX_STEPS,
      step: 1,
      default: HUNYUAN3D_DEFAULT_STEPS,
    })
  )
  .field(
    'hunyuanCfgScale',
    sliderDef({
      min: HUNYUAN3D_MIN_CFG_SCALE,
      max: HUNYUAN3D_MAX_CFG_SCALE,
      step: 0.5,
      default: HUNYUAN3D_DEFAULT_CFG_SCALE,
    })
  )
  .field(
    'hunyuanOctreeResolution',
    enumDef({ options: hunyuan3dOctreeResolutionOptions, default: 256 })
  )
  .field('seed', SEED);

export {
  HUNYUAN3D_MIN_STEPS,
  HUNYUAN3D_MAX_STEPS,
  HUNYUAN3D_DEFAULT_STEPS,
  HUNYUAN3D_MIN_CFG_SCALE,
  HUNYUAN3D_MAX_CFG_SCALE,
  HUNYUAN3D_DEFAULT_CFG_SCALE,
  HUNYUAN3D_MAX_PROMPT_LENGTH,
};
