import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { img2imgImages, SDXL_SQUARE_AR, SEED } from '../defs';
import {
  versionModeOf,
  familyResources,
  familyScope,
  makeTextBlock,
  perModelSlider,
  type FamilyExt,
} from '../shared';

/**
 * Boogu (base / turbo / edit / editTurbo), ported from `boogu-graph.ts`. One
 * ecosystem; version options are WORKFLOW-scoped (Base/Turbo on txt2img,
 * Edit/Edit Turbo on img2img:edit) and the MODEL WINS the workflow — an edit
 * checkpoint on txt2img switches the workflow to img2img:edit (probed; the
 * cross-workflow rewrite itself lives in `../reconcile.ts` since a family
 * cannot change the root workflow mid-parse). Distilled modes hide cfg range
 * and negative prompt.
 */

// ---- copied from boogu-graph.ts, which dies with the data-graph engine ------

export type BooguMode = 'base' | 'turbo' | 'edit' | 'editTurbo';

export const booguVersionIds = {
  base: 3049541,
  turbo: 3050010,
  edit: 3049824,
  editTurbo: 3113427,
} as const;

/** One lookup for the graph AND the handler — the lanes cannot drift. */
export const booguModeOf = versionModeOf(booguVersionIds, (ext) =>
  ext.workflow.startsWith('txt') ? 'base' : 'edit'
);

const booguTxt2ImgVersionOptions = [
  { label: 'Base', value: booguVersionIds.base },
  { label: 'Turbo', value: booguVersionIds.turbo },
];

const booguEditVersionOptions = [
  { label: 'Edit', value: booguVersionIds.edit },
  { label: 'Edit Turbo', value: booguVersionIds.editTurbo },
];

// ---- end of boogu-graph.ts copies -------------------------------------------

type BooguModeExt = FamilyExt & { model?: unknown };

const FULL_CFG = { min: 1, max: 8, step: 0.5 };
const TURBO_CFG = { min: 1, max: 2, step: 0.1, default: 1 };
const TURBO_STEPS = { min: 1, max: 12, default: 4 };

const base = defineGraph<BooguModeExt>()
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_SQUARE_AR)
  .field('cfgScale', perModelSlider({ ...FULL_CFG, default: 4 }))
  .field('steps', perModelSlider({ min: 1, max: 50, default: 35 }));

const turbo = defineGraph<BooguModeExt>()
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_SQUARE_AR)
  .field('cfgScale', perModelSlider(TURBO_CFG))
  .field('steps', perModelSlider(TURBO_STEPS));

const edit = defineGraph<BooguModeExt>()
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_SQUARE_AR)
  .field('cfgScale', perModelSlider({ ...FULL_CFG, default: 5 }))
  .field('steps', perModelSlider({ min: 1, max: 50, default: 35 }));

const editTurbo = defineGraph<BooguModeExt>()
  .field('resources', familyResources)
  .field('aspectRatio', SDXL_SQUARE_AR)
  .field('cfgScale', perModelSlider(TURBO_CFG))
  .field('steps', perModelSlider(TURBO_STEPS));

/** Tagged: v1's `booguMode` computed becomes the branch key. */
const modes = branch('booguMode', (ext: BooguModeExt) => booguModeOf(ext.model, ext), {
  base,
  turbo,
  edit,
  editTurbo,
});

const isEditWorkflow = (workflow: string) => workflow.startsWith('img2img:edit');

export const boogu = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', img2imgImages({ max: 1 }))
  .field('model', ({ _ext }) => {
    const isEdit = isEditWorkflow(_ext.workflow);
    return checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: isEdit ? booguEditVersionOptions : booguTxt2ImgVersionOptions },
      defaultModelId: isEdit ? booguVersionIds.edit : booguVersionIds.base,
    });
  })
  .field('seed', SEED)
  .use(modes)
  // negativePrompt exists only in the base/edit v1 subgraphs (turbo variants
  // drop it), and its in-branch snippet registration never fires
  .use(
    makeTextBlock({
      negativePrompt: (ext) => ['base', 'edit'].includes(booguModeOf(ext.model, ext)),
      negativePromptRegistersTarget: false,
    })
  );

export { booguTxt2ImgVersionOptions, booguEditVersionOptions };
