import { branch, defineGraph } from 'form-graph';
import { zImageControlNetPreprocessors } from '~/shared/constants/controlnets.constants';
import { checkpointDef } from '../checkpoint';
import { SDXL_SQUARE_AR, SEED, controlNetsDef, defaultSamplerPresets, selectDef } from '../defs';
import {
  familyResources,
  familyScope,
  makeTextBlock,
  perModelSlider,
  type FamilyExt,
} from '../shared';

/**
 * ZImage family (ZImageTurbo / ZImageBase), ported from `z-image-graph.ts`.
 * Turbo has fixed sampler/scheduler and no negative prompt; Base exposes both.
 */

// Copied from z-image-graph.ts, which dies with the data-graph engine.
const zImageVersionIds = { turbo: 2442439, base: 2635223 } as const;
const zImageModeVersionOptions = [
  { label: 'Turbo', value: zImageVersionIds.turbo },
  { label: 'Base', value: zImageVersionIds.base },
];
/** SdCpp sampler/scheduler options. */
const zImageSamplers = ['euler', 'heun'] as const;
const zImageSchedules = ['simple', 'discrete'] as const;

const modeOf = (ecosystem: string) => {
  switch (ecosystem) {
    case 'ZImageBase':
      return 'base' as const;
    case 'ZImageTurbo':
    default:
      return 'turbo' as const;
  }
};

const AR = SDXL_SQUARE_AR;
const CONTROL_NETS = controlNetsDef({ preprocessors: zImageControlNetPreprocessors, limit: 1 });

const turbo = defineGraph<FamilyExt>()
  .scope(familyScope)
  .field('resources', familyResources)
  .field('aspectRatio', AR)
  .field('cfgScale', perModelSlider({ min: 1, max: 2, step: 0.1, default: 1 }))
  .field('steps', perModelSlider({ min: 1, max: 15, default: 9 }))
  .field('controlNets', ({ _ext }) => (_ext.workflow === 'txt2img' ? CONTROL_NETS : null))
  .field('seed', SEED);

const base = defineGraph<FamilyExt>()
  .scope(familyScope)
  .field('resources', familyResources)
  .field('aspectRatio', AR)
  .field(
    'sampler',
    selectDef({ options: zImageSamplers, default: 'euler', presets: defaultSamplerPresets })
  )
  .field('scheduler', selectDef({ options: zImageSchedules, default: 'simple' }))
  .field('cfgScale', perModelSlider({ min: 1, max: 10, step: 0.5, default: 4 }))
  .field('steps', perModelSlider({ min: 1, max: 50, default: 20 }))
  .field('controlNets', ({ _ext }) => (_ext.workflow === 'txt2img' ? CONTROL_NETS : null))
  .field('seed', SEED);

/** Tagged: v1's `zImageMode` computed becomes the branch key, same state shape. */
const modes = branch('zImageMode', (ext: FamilyExt) => modeOf(ext.ecosystem), { turbo, base });

export const zimage = defineGraph<FamilyExt>()
  .scope(familyScope)
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: zImageModeVersionOptions },
    })
  )
  .use(modes)
  // Base's negative prompt is a full EDITOR, but it lives inside v1's mode
  // subgraph where its snippet registration never fires — the oracle's
  // targets carry `prompt` alone.
  .use(
    makeTextBlock({
      negativePrompt: (ext) => modeOf(ext.ecosystem) === 'base',
      negativePromptRegistersTarget: false,
    })
  );
