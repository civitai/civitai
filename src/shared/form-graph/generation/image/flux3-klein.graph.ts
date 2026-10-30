import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { img2imgImages, SDXL_FULL_AR, SEED } from '../defs';
import {
  familyResources,
  familyScope,
  makeTextBlock,
  perModelSlider,
  type FamilyExt,
} from '../shared';

/**
 * Flux.3 Klein (distilled / Base). Two ECOSYSTEMS share this graph; the mode
 * derives from the ecosystem. The distilled model runs at fixed steps with no
 * guidance, so it exposes neither; Base exposes both.
 */

export type Flux3KleinMode = 'distilled' | 'base';

const flux3KleinVersionIds = { distilled: 3407486, base: 3407485 } as const;

const flux3KleinModeVersionOptions = [
  { label: 'Klein', value: flux3KleinVersionIds.distilled },
  { label: 'Klein Base', value: flux3KleinVersionIds.base },
];

export const flux3KleinModeOf = (ecosystem: string): Flux3KleinMode =>
  ecosystem === 'Flux3Klein_base' ? 'base' : 'distilled';

const distilled = defineGraph<FamilyExt>()
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_FULL_AR)
  .field('seed', SEED);

const base = defineGraph<FamilyExt>()
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_FULL_AR)
  .field('cfgScale', perModelSlider({ min: 1, max: 10, step: 0.5, default: 3.5 }))
  .field('steps', perModelSlider({ min: 20, max: 60, default: 50 }))
  .field('seed', SEED);

/** Tagged: the picked key is stamped into state as `flux3KleinMode`. */
const modes = branch('flux3KleinMode', (ext: FamilyExt) => flux3KleinModeOf(ext.ecosystem), {
  distilled,
  base,
});

export const flux3Klein = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', img2imgImages({ max: 10 }))
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: flux3KleinModeVersionOptions },
    })
  )
  .use(modes)
  .use(
    makeTextBlock({
      // without guidance a negative prompt has no effect
      negativePrompt: (ext) => flux3KleinModeOf(ext.ecosystem) === 'base',
      negativePromptRegistersTarget: false,
    })
  );

export { flux3KleinVersionIds };
