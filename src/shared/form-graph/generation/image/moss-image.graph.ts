import { cachedFactory, defineGraph } from 'form-graph';
import { checkpointDef } from '../checkpoint';
import { SDXL_FULL_AR, SEED, resourcesDef, sliderDef, type ResourceData } from '../defs';
import { familyScope, makeTextBlock, modelIdOf, perModelScope, type FamilyExt } from '../shared';

/** Neither variant is distilled (both are CFG models), so SFT exposes steps, CFG and negative prompt too. */

export type MossImageModel = 'sft' | 'base';

const mossImageVersionIds = { sft: 3409867, base: 3409868 } as const;

const mossImageVersionOptions = [
  { label: 'SFT', value: mossImageVersionIds.sft },
  { label: 'Base', value: mossImageVersionIds.base },
];

/**
 * Turbo (DMD distillation, no CFG) LoRAs, matched by MODEL so new
 * versions uploaded to the same page are covered without a code change.
 */
const MOSS_IMAGE_TURBO_LORA_MODEL_ID = 3006599;
export const mossImageTurboLoraModelIds: readonly number[] = [MOSS_IMAGE_TURBO_LORA_MODEL_ID];

/** The checkpoint each turbo LoRA version is for, and its recommended steps; an unlisted version gets 8. */
const mossImageTurboLoraVersions: Record<number, { model: MossImageModel; steps: number }> = {
  3411385: { model: 'sft', steps: 8 }, // 8-step DMD
  3413516: { model: 'base', steps: 8 }, // 8-step DMD
  3414934: { model: 'sft', steps: 4 }, // 4-step v2
};
const MOSS_IMAGE_TURBO_DEFAULT_STEPS = 8;

/**
 * The version the Turbo toggle adds for each checkpoint. SFT gets the 8-step
 * build rather than the 4-step v2, whose results creators report as weaker.
 */
const mossImageTurboToggleVersionIds: Record<MossImageModel, number> = {
  sft: 3411385,
  base: 3413516,
};
const mossImageBaseModels: Record<MossImageModel, string> = {
  sft: 'MOSS Image',
  base: 'MOSS Image Base',
};

/** A fresh object each call: state and the server's corrected value must not share one. */
const mossImageTurboToggleLora = (model: MossImageModel): ResourceData => ({
  id: mossImageTurboToggleVersionIds[model],
  baseModel: mossImageBaseModels[model],
  model: { id: MOSS_IMAGE_TURBO_LORA_MODEL_ID, type: 'LORA' } as ResourceData['model'],
  strength: 1,
});

/**
 * Known versions match by id too: the output schema drops `model.id`, so the
 * server parse sees only the version id.
 */
const isMossImageTurboLora = (resource: unknown) => {
  const r = resource as { id?: unknown; model?: unknown } | null;
  if (typeof r?.id === 'number' && r.id in mossImageTurboLoraVersions) return true;
  const modelId = modelIdOf(r?.model);
  return modelId != null && mossImageTurboLoraModelIds.includes(modelId);
};

const mossImageTurboLoraOf = (resources: readonly unknown[] | undefined) =>
  resources?.find(isMossImageTurboLora) as { id: number } | undefined;

export const hasMossImageTurboLora = (resources: readonly unknown[] | undefined) =>
  mossImageTurboLoraOf(resources) != null;

export const mossImageModelOf = (ecosystem: string): MossImageModel =>
  ecosystem === 'MossImage_base' ? 'base' : 'sft';

/**
 * What the Turbo toggle writes: `resources` with and without the turbo LoRA.
 * `full`: no free slot to turn it on.
 */
type ResourcesTurboMeta = {
  enabled: boolean;
  full: boolean;
  withTurbo: ResourceData[];
  withoutTurbo: ResourceData[];
};

/**
 * The Turbo toggle lives on `resources` rather than in a field of its own, so
 * a toggled LoRA and a hand-picked one are the same state and drive steps/CFG
 * through the same sliders below. Switching checkpoint swaps a turbo LoRA made
 * for the other one to this checkpoint's, so Turbo stays on.
 */
const mossImageResources = cachedFactory(function mossImageResources(
  ecosystem: string,
  limit: number
) {
  const def = resourcesDef({ ecosystem, limit });
  const model = mossImageModelOf(ecosystem);
  const toggleVersionId = mossImageTurboToggleVersionIds[model];
  const isOtherCheckpointTurboLora = (r: ResourceData) => {
    const forModel = mossImageTurboLoraVersions[r.id]?.model;
    return forModel != null && forModel !== model;
  };
  return {
    ...def,
    correct: (value: ResourceData[]) => {
      if (!value?.some(isOtherCheckpointTurboLora)) return def.correct(value);
      const swapped = [
        ...value.filter((r) => !isMossImageTurboLora(r)),
        // its turbo LoRA could already be there beside the other one
        value.find((r) => r.id === toggleVersionId) ?? mossImageTurboToggleLora(model),
      ];
      return def.correct(swapped) ?? { value: swapped, reason: 'turbo_lora_checkpoint_swap' };
    },
    meta: (value: ResourceData[] | undefined) => {
      const resources = value ?? [];
      const withoutTurbo = resources.filter((r) => !isMossImageTurboLora(r));
      const enabled = withoutTurbo.length < resources.length;
      return {
        ...def.meta(resources),
        turbo: {
          enabled,
          full: !enabled && resources.length >= limit,
          withTurbo: [...withoutTurbo, mossImageTurboToggleLora(model)],
          withoutTurbo,
        } satisfies ResourcesTurboMeta,
      };
    },
  };
});

type MossSliderCtx = { _ext: FamilyExt & { model?: unknown }; resources?: readonly unknown[] };

/**
 * A turbo LoRA swaps in its recommended default, and remembers the user's
 * values per mode (like MiniMax's turbo toggle): removing the LoRA restores
 * whatever they had before. Standard keeps the plain per-model scope so
 * values stored before turbo awareness still apply. `turbo` gives the default
 * and any scope segments below 'turbo' for the LoRA version in use.
 */
const turboAwareSlider =
  (
    opts: Parameters<typeof sliderDef>[0],
    turbo: (loraVersionId: number) => { default: number; scope?: number[] }
  ) =>
  ({ _ext, resources }: MossSliderCtx) => {
    const turboLora = mossImageTurboLoraOf(resources);
    if (!turboLora) return { ...sliderDef(opts), scope: perModelScope(_ext) };
    const modelId = modelIdOf(_ext.model);
    const { default: turboDefault, scope = [] } = turbo(turboLora.id);
    return {
      ...sliderDef({ ...opts, default: turboDefault }),
      scope: [...(modelId != null ? [modelId] : []), 'turbo', ...scope],
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
  .field('resources', ({ _ext }) => mossImageResources(_ext.ecosystem, _ext.limits.maxResources))
  .field('aspectRatio', SDXL_FULL_AR)
  // One turbo CFG for every turbo version, so a remembered CFG survives a version swap
  .field(
    'cfgScale',
    turboAwareSlider({ min: 1, max: 10, step: 0.5, default: 3 }, () => ({ default: 1 }))
  )
  .field(
    'steps',
    turboAwareSlider({ min: 4, max: 60, default: 25 }, (loraVersionId) => ({
      default: mossImageTurboLoraVersions[loraVersionId]?.steps ?? MOSS_IMAGE_TURBO_DEFAULT_STEPS,
      scope: [loraVersionId],
    }))
  )
  .field('seed', SEED)
  .use(makeTextBlock({ negativePromptRegistersTarget: false }));

export { mossImageVersionIds };
