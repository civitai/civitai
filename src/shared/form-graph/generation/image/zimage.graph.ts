import { branch, defineGraph } from 'form-graph';
import { zImageControlNetPreprocessors } from '~/shared/constants/controlnets.constants';
import { checkpointDef } from '../checkpoint';
import {
  SDXL_FULL_AR,
  SDXL_FULL_AR_4MP,
  SEED,
  controlNetsDef,
  defaultSamplerPresets,
  selectDef,
} from '../defs';
import {
  familyResources,
  familyScope,
  makeTextBlock,
  perModelSlider,
  type FamilyExt,
} from '../shared';

/**
 * ZImage family (ZImageTurbo / ZImageBase).
 * Turbo has fixed sampler/scheduler and no negative prompt; Base exposes both.
 */

const zImageVersionIds = { turbo: 2442439, base: 2635223 } as const;
const zImageModeVersionOptions = [
  { label: 'Turbo', value: zImageVersionIds.turbo },
  { label: 'Base', value: zImageVersionIds.base },
];
const zImageSamplers = ['euler', 'heun'] as const;
/** Must be valid comfy scheduler names — comfy has no 'discrete'. */
const zImageSchedules = ['simple'] as const;

const modeOf = (ecosystem: string) => {
  switch (ecosystem) {
    case 'ZImageBase':
      return 'base' as const;
    case 'ZImageTurbo':
    default:
      return 'turbo' as const;
  }
};

// Base is documented to 2048² total area; Turbo has no official figure above 1 MP.
const AR_TURBO = SDXL_FULL_AR;
const AR_BASE = SDXL_FULL_AR_4MP;
const CONTROL_NETS = controlNetsDef({ preprocessors: zImageControlNetPreprocessors, limit: 1 });

const turbo = defineGraph<FamilyExt>()
  .field('resources', familyResources)
  .field('aspectRatio', AR_TURBO)
  .field('cfgScale', perModelSlider({ min: 1, max: 2, step: 0.1, default: 1 }))
  .field('steps', perModelSlider({ min: 1, max: 15, default: 9 }))
  .field('controlNets', ({ _ext }) => (_ext.workflow === 'txt2img' ? CONTROL_NETS : null))
  .field('seed', SEED);

const base = defineGraph<FamilyExt>()
  .field('resources', familyResources)
  .field('aspectRatio', AR_BASE)
  .field(
    'sampler',
    selectDef({ options: zImageSamplers, default: 'euler', presets: defaultSamplerPresets })
  )
  .field('scheduler', selectDef({ options: zImageSchedules, default: 'simple' }))
  .field('cfgScale', perModelSlider({ min: 1, max: 10, step: 0.5, default: 4 }))
  .field('steps', perModelSlider({ min: 1, max: 50, default: 20 }))
  .field('controlNets', ({ _ext }) => (_ext.workflow === 'txt2img' ? CONTROL_NETS : null))
  .field('seed', SEED);

/** Tagged: the picked key is stamped into state as `zImageMode`. */
const modes = branch('zImageMode', (ext: FamilyExt) => modeOf(ext.ecosystem), { turbo, base });

export const zimage = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: zImageModeVersionOptions },
    })
  )
  .use(modes)
  .use(
    makeTextBlock({
      negativePrompt: (ext) => modeOf(ext.ecosystem) === 'base',
      negativePromptRegistersTarget: false,
    })
  );
