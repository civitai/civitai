import { branch, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { img2imgImages, SDXL_FULL_AR, SEED, type ResourceData } from '../defs';
import {
  versionModeOf,
  familyScope,
  makeTextBlock,
  perModelSlider,
  type FamilyExt,
} from '../shared';
import { comfyResourceBlock } from '../turbo';

/**
 * Fibo 2.0. Dev creates, with the Turbo toggle adding the turbo LoRA; Edit
 * Turbo is a distilled edit-only build, so it is the edit workflow's model and
 * runs without LoRAs. The mode derives from the model version id.
 */

export type Fibo2Mode = 'dev' | 'turbo';

export const fibo2VersionIds = {
  dev: 3469179,
  turbo: 3469181,
} as const;

export const FIBO2_TURBO_BASE_MODEL = 'Fibo 2.0 Turbo';

/** One lookup for the graph AND the handler — the lanes cannot drift. */
export const fibo2ModeOf = versionModeOf(fibo2VersionIds, 'dev');

const fibo2EditVersionOptions = [{ label: 'Edit Turbo', value: fibo2VersionIds.turbo }];

const isEditWorkflow = (workflow: string) => workflow.startsWith('img2img:edit');

type Fibo2ModeExt = FamilyExt & { model?: unknown };

const dev = defineGraph<Fibo2ModeExt>().use(
  comfyResourceBlock({
    cfgScale: { min: 1, max: 10, step: 0.5, default: 5 },
    steps: { min: 4, max: 60, default: 30 },
    // Fibo 2.0 Turbo LoRA
    turbo: { lora: 3469218 },
  })
);

const turbo = defineGraph<Fibo2ModeExt>()
  .field('cfgScale', perModelSlider({ min: 1, max: 5, step: 0.5, default: 1 }))
  .field('steps', perModelSlider({ min: 1, max: 12, default: 4 }));

/** Tagged: the picked key is stamped into state as `fibo2Mode`. */
const modes = branch('fibo2Mode', (ext: Fibo2ModeExt) => fibo2ModeOf(ext.model), { dev, turbo });

export const fibo2 = defineGraph<FamilyExt>({ scope: familyScope })
  .field('images', img2imgImages({ min: 1, max: 16 }))
  .field('model', ({ _ext }) => {
    const isEdit = isEditWorkflow(_ext.workflow);
    const base = checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: isEdit ? { options: fibo2EditVersionOptions } : undefined,
      defaultModelId: isEdit ? fibo2VersionIds.turbo : fibo2VersionIds.dev,
      modelLocked: isEdit,
    });
    return {
      ...base,
      // Leaving the edit workflow takes Edit Turbo back to Dev, which is the one that creates.
      correct: (value: ResourceData | undefined) =>
        !isEdit && value?.id === fibo2VersionIds.turbo
          ? {
              value: { id: fibo2VersionIds.dev, model: { type: 'Checkpoint' } } as ResourceData,
              reason: 'workflow_version_remap',
            }
          : base.correct?.(value),
    };
  })
  .use(modes)
  .field('aspectRatio', SDXL_FULL_AR)
  .field('seed', SEED)
  .use(makeTextBlock({ negativePromptRegistersTarget: false }));
