import { defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SDXL_FULL_AR, SEED, sliderDef } from '../defs';
import {
  familyResources,
  familyScope,
  makeTextBlock,
  modelIdOf,
  perModelScope,
  type FamilyExt,
} from '../shared';

/** Neither variant is distilled (both are CFG models), so SFT exposes steps, CFG and negative prompt too. */

export type MossImageModel = 'sft' | 'base';

const mossImageVersionIds = { sft: 3409867, base: 3409868 } as const;

const mossImageVersionOptions = [
  { label: 'SFT', value: mossImageVersionIds.sft },
  { label: 'Base', value: mossImageVersionIds.base },
];

/**
 * Turbo (8-step DMD distillation, no CFG) LoRAs, matched by MODEL so new
 * versions uploaded to the same page are covered without a code change.
 */
export const mossImageTurboLoraModelIds: readonly number[] = [3006599];

export const hasMossImageTurboLora = (resources: readonly unknown[] | undefined) =>
  resources?.some((r) => {
    const modelId = modelIdOf((r as { model?: unknown } | null)?.model);
    return modelId != null && mossImageTurboLoraModelIds.includes(modelId);
  }) ?? false;

export const mossImageModelOf = (ecosystem: string): MossImageModel =>
  ecosystem === 'MossImage_base' ? 'base' : 'sft';

type MossSliderCtx = { _ext: FamilyExt & { model?: unknown }; resources?: readonly unknown[] };

/**
 * A turbo LoRA swaps in its recommended default, and remembers the user's
 * values per mode (like MiniMax's turbo toggle): removing the LoRA restores
 * whatever they had before. Standard keeps the plain per-model scope so
 * values stored before turbo awareness still apply.
 */
const turboAwareSlider =
  (opts: Parameters<typeof sliderDef>[0], turboDefault: number) =>
  ({ _ext, resources }: MossSliderCtx) => {
    const turbo = hasMossImageTurboLora(resources);
    const scope = perModelScope(_ext);
    return {
      ...sliderDef({ ...opts, default: turbo ? turboDefault : opts.default }),
      scope: turbo ? [...(scope ?? []), 'turbo'] : scope,
    };
  };

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
  .field('cfgScale', turboAwareSlider({ min: 1, max: 10, step: 0.5, default: 3 }, 1))
  .field('steps', turboAwareSlider({ min: 4, max: 60, default: 25 }, 8))
  .field('seed', SEED)
  .use(makeTextBlock({ negativePromptRegistersTarget: false }));

export { mossImageVersionIds };
