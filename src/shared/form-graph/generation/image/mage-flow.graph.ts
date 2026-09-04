import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { img2imgImages, SEED, aspectRatioDef, type ResourceData } from '../defs';
import {
  familyScope,
  modelIdOf,
  perModelSlider,
  promptOnlyTextBlock,
  type FamilyExt,
} from '../shared';

/**
 * Mage Flow (standard + turbo, per workflow), ported from `mage-flow-graph.ts`.
 * Version options are WORKFLOW-scoped, but unlike boogu the WORKFLOW wins:
 * the oracle remaps a cross-workflow version to its index-equivalent in the
 * current workflow's list (standard↔standard, turbo↔turbo — probed
 * 2026-09-01). No negative prompt, sampler, or CLIP skip; no LoRAs.
 */

// ---- copied from mage-flow-graph.ts, which dies with the data-graph engine --

export const mageFlowVersionIds = {
  txt2img_standard: 3172038,
  txt2img_turbo: 3172039,
  edit_standard: 3172043,
  edit_turbo: 3172044,
} as const;

const mageFlowTxt2ImgVersionOptions = [
  { label: 'Standard', value: mageFlowVersionIds.txt2img_standard },
  { label: 'Turbo', value: mageFlowVersionIds.txt2img_turbo },
];

const mageFlowEditVersionOptions = [
  { label: 'Standard', value: mageFlowVersionIds.edit_standard },
  { label: 'Turbo', value: mageFlowVersionIds.edit_turbo },
];

const turboVersionIds = new Set<number>([
  mageFlowVersionIds.txt2img_turbo,
  mageFlowVersionIds.edit_turbo,
]);

/** v1's index-equivalent mapping across the two workflow lists. */
const remapAcrossWorkflows: Record<number, Record<'txt2img' | 'img2img:edit', number>> = {
  [mageFlowVersionIds.txt2img_standard]: {
    txt2img: mageFlowVersionIds.txt2img_standard,
    'img2img:edit': mageFlowVersionIds.edit_standard,
  },
  [mageFlowVersionIds.txt2img_turbo]: {
    txt2img: mageFlowVersionIds.txt2img_turbo,
    'img2img:edit': mageFlowVersionIds.edit_turbo,
  },
  [mageFlowVersionIds.edit_standard]: {
    txt2img: mageFlowVersionIds.txt2img_standard,
    'img2img:edit': mageFlowVersionIds.edit_standard,
  },
  [mageFlowVersionIds.edit_turbo]: {
    txt2img: mageFlowVersionIds.txt2img_turbo,
    'img2img:edit': mageFlowVersionIds.edit_turbo,
  },
};

/**
 * Native resolution runs 512-2048 on any aspect ratio — wider than the usual
 * 1024 buckets, incl. the 4:1 / 1:4 extremes the model card calls out.
 */
const mageFlowAspectRatios = [
  { label: '1:4', value: '1:4', width: 512, height: 2048 },
  { label: '9:16', value: '9:16', width: 768, height: 1344 },
  { label: '2:3', value: '2:3', width: 832, height: 1248 },
  { label: '3:4', value: '3:4', width: 896, height: 1200 },
  { label: '1:1', value: '1:1', width: 1024, height: 1024 },
  { label: '4:3', value: '4:3', width: 1200, height: 896 },
  { label: '3:2', value: '3:2', width: 1248, height: 832 },
  { label: '16:9', value: '16:9', width: 1344, height: 768 },
  { label: '4:1', value: '4:1', width: 2048, height: 512 },
];

const mageFlowPriorityAspectRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];

// ---- end of mage-flow-graph.ts copies ---------------------------------------

type MageFlowVariant = 'standard' | 'turbo';
type MageFlowModeExt = FamilyExt & { model?: unknown };

const variantOf = (ext: MageFlowModeExt): MageFlowVariant => {
  const id = modelIdOf(ext.model);
  return id != null && turboVersionIds.has(id) ? 'turbo' : 'standard';
};

const AR = aspectRatioDef({
  options: mageFlowAspectRatios,
  default: '1:1',
  priorityOptions: mageFlowPriorityAspectRatios,
});

const standard = defineGraph<MageFlowModeExt>()
  .field('aspectRatio', AR)
  .field('seed', SEED)
  .field('cfgScale', perModelSlider({ min: 1, max: 10, default: 5, step: 0.5 }))
  .field('steps', perModelSlider({ min: 10, max: 50, default: 30 }));

const turbo = defineGraph<MageFlowModeExt>()
  .field('aspectRatio', AR)
  .field('seed', SEED)
  .field('cfgScale', perModelSlider({ min: 1, max: 2, default: 1, step: 0.1 }))
  .field('steps', perModelSlider({ min: 1, max: 12, default: 4 }));

/** Tagged: v1's `mageFlowVariant` computed becomes the branch key. */
const variants = branch('mageFlowVariant', variantOf, { standard, turbo });

const isEditWorkflow = (workflow: string) => workflow.startsWith('img2img:edit');

export const mageFlow = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', img2imgImages({ max: 3 }))
  .field('model', ({ _ext }) => {
    const isEdit = isEditWorkflow(_ext.workflow);
    const workflowKey = isEdit ? ('img2img:edit' as const) : ('txt2img' as const);
    const base = checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: isEdit ? mageFlowEditVersionOptions : mageFlowTxt2ImgVersionOptions },
      defaultModelId: isEdit
        ? mageFlowVersionIds.edit_standard
        : mageFlowVersionIds.txt2img_standard,
    });
    return {
      ...base,
      correct: (value: ResourceData | undefined) => {
        const mapped =
          value?.id != null ? remapAcrossWorkflows[value.id]?.[workflowKey] : undefined;
        if (mapped != null && mapped !== value!.id) {
          return {
            value: { id: mapped, model: { type: 'Checkpoint' } } as typeof value,
            reason: 'workflow_version_remap',
          };
        }
        return base.correct?.(value);
      },
    };
  })
  .use(variants)
  .use(promptOnlyTextBlock);

export { mageFlowAspectRatios, mageFlowTxt2ImgVersionOptions, mageFlowEditVersionOptions };
