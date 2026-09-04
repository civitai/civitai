import { branch, defineGraph } from 'form-graph';
import { animaControlNetPreprocessors } from '~/shared/constants/controlnets.constants';
import { checkpointDef } from '../checkpoint';
import { SDXL_SQUARE_AR, SEED, controlNetsDef, selectDef } from '../defs';
import {
  familyResources,
  familyScope,
  modelIdOf,
  perModelSlider,
  textBlock,
  type FamilyExt,
} from '../shared';

/**
 * Anima (base + turbo), ported from `anima-graph.ts`. Comfy engine —
 * sampler/scheduler use comfy names. Negative prompt supported; controlNets on
 * txt2img behind the `animaControlnet` kill-switch (fail-open).
 */

// ---- copied from anima-graph.ts, which dies with the data-graph engine ------

export const animaVersionIds = {
  anima: 2945208,
  turbo: 3108589,
} as const;

type AnimaVariant = 'base' | 'turbo';

/**
 * Only turbo is mapped; every other Anima version (incl. custom checkpoints)
 * keeps the standard cfgScale/steps defaults.
 */
const versionIdToVariant = new Map<number, AnimaVariant>([[animaVersionIds.turbo, 'turbo']]);

// dpmpp_2s_ancestral is incompatible with all available schedules;
// karras/exponential schedules are incompatible with most of these samplers.
const animaSamplers = ['er_sde', 'euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpmpp_2m'];

const animaSamplerPresets = [
  { label: 'Fast', value: 'euler' },
  { label: 'Quality', value: 'dpmpp_2m' },
];

const animaSchedules = ['simple', 'sgm_uniform'];

// ---- end of anima-graph.ts copies -------------------------------------------

type AnimaModeExt = FamilyExt & { model?: unknown };

const variantOf = (ext: AnimaModeExt): AnimaVariant => {
  const id = modelIdOf(ext.model);
  return (id != null ? versionIdToVariant.get(id) : undefined) ?? 'base';
};

const base = defineGraph<AnimaModeExt>()
  .field('cfgScale', perModelSlider({ min: 1, max: 20, default: 7, step: 0.5 }))
  .field('steps', perModelSlider({ min: 8, max: 50, default: 25 }));

const turbo = defineGraph<AnimaModeExt>()
  .field('cfgScale', perModelSlider({ min: 1, max: 2, step: 0.1, default: 1 }))
  .field('steps', perModelSlider({ min: 1, max: 15, default: 8 }));

/** Tagged: v1's `animaVariant` computed becomes the branch key. */
const variants = branch('animaVariant', variantOf, { base, turbo });

export const anima = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      defaultModelId: animaVersionIds.anima,
    })
  )
  .field('resources', familyResources)
  .field('seed', SEED)
  .field('aspectRatio', SDXL_SQUARE_AR)
  .use(variants)
  .field(
    'sampler',
    selectDef({ options: animaSamplers, default: 'euler_ancestral', presets: animaSamplerPresets })
  )
  .field('scheduler', selectDef({ options: animaSchedules, default: 'simple' }))
  .field('controlNets', ({ _ext }) =>
    _ext.workflow === 'txt2img' && _ext.flags?.animaControlnet !== false
      ? controlNetsDef({ preprocessors: animaControlNetPreprocessors, limit: 1 })
      : null
  )
  .use(textBlock);
