import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SDXL_FULL_AR, SEED } from '../defs';
import {
  familyResources,
  familyScope,
  makeTextBlock,
  perModelSlider,
  type FamilyExt,
} from '../shared';

/** Neither variant is distilled (both are CFG models), so SFT exposes steps, CFG and negative prompt too. */

export type MossImageModel = 'sft' | 'base';

const mossImageVersionIds = { sft: 3409867, base: 3409868 } as const;

const mossImageVersionOptions = [
  { label: 'SFT', value: mossImageVersionIds.sft },
  { label: 'Base', value: mossImageVersionIds.base },
];

export const mossImageModelOf = (ecosystem: string): MossImageModel =>
  ecosystem === 'MossImage_base' ? 'base' : 'sft';

export const mossImage = defineGraph<FamilyExt>({ scope: familyScope })
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: mossImageVersionOptions },
    })
  )
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_FULL_AR)
  .field('cfgScale', perModelSlider({ min: 1, max: 10, step: 0.5, default: 3 }))
  .field('steps', perModelSlider({ min: 4, max: 60, default: 25 }))
  .field('seed', SEED)
  .use(makeTextBlock({ negativePromptRegistersTarget: false }));

export { mossImageVersionIds };
