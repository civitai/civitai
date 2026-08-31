import { ModelType } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';

export const modelTypeGroups = [
  { group: 'Fine-tunes', types: [ModelType.Checkpoint] },
  { group: 'Adapters', types: [ModelType.LORA, ModelType.LoCon, ModelType.DoRA] },
  {
    group: 'Component replacements',
    types: [ModelType.VAE, ModelType.TextEncoder, ModelType.UNet, ModelType.Upscaler],
  },
  {
    group: 'Workflow additives',
    types: [ModelType.Workflows, ModelType.Wildcards, ModelType.Controlnet],
  },
  { group: 'Other', types: [ModelType.Other] },
] as const satisfies readonly { group: string; types: readonly ModelType[] }[];

export const selectableModelTypes = modelTypeGroups.flatMap(({ types }) => types);

/**
 * Types no longer offered when picking a type. They stay valid everywhere else: a model already set
 * to one keeps the value and keeps displaying it.
 */
export const retiredModelTypes = [
  ModelType.TextualInversion,
  ModelType.Hypernetwork,
  ModelType.AestheticGradient,
  ModelType.MotionModule,
  ModelType.Poses,
  ModelType.Detection,
  ModelType.ComfyWorkflows,
  ModelType.CLIP,
  ModelType.CLIPVision,
  ModelType.LLM,
  ModelType.VisionLanguage,
] as const satisfies readonly ModelType[];

type SelectableModelType = (typeof modelTypeGroups)[number]['types'][number];
type UncategorisedModelType = Exclude<
  ModelType,
  SelectableModelType | (typeof retiredModelTypes)[number]
>;

/**
 * Both lists are written out rather than one being the other's complement, so that a ModelType added
 * later is a compile error here instead of silently becoming unpickable.
 */
const _everyModelTypeIsCategorised: [UncategorisedModelType] extends [never]
  ? true
  : { error: 'Add it to modelTypeGroups or retiredModelTypes'; missing: UncategorisedModelType } =
  true;
void _everyModelTypeIsCategorised;

const selectableModelTypeSet = new Set<string>(selectableModelTypes);

export const currentlySelectedGroupLabel = 'Currently selected';

type ModelTypeSelectItem = { value: ModelType; label: string; group: string };

const toItem = (type: ModelType, group: string): ModelTypeSelectItem => ({
  value: type,
  label: getDisplayName(type),
  group,
});

/**
 * `currentType` must be the saved type of an existing model, never the live form value: re-deriving
 * it from the form would drop the grandfathered option the moment the user clicked another type,
 * making the original unrecoverable. Passing it for a new model (a template seeds one) would let a
 * retired type be minted afresh.
 *
 * Returns flat items carrying a `group`, which is what SelectWrapper collapses into Mantine's
 * grouped data.
 */
export function getModelTypeSelectData(
  currentType?: ModelType | string | null
): ModelTypeSelectItem[] {
  const offered = modelTypeGroups.flatMap(({ group, types }) =>
    types.map((type) => toItem(type, group))
  );

  if (!currentType || selectableModelTypeSet.has(currentType)) return offered;

  return [toItem(currentType as ModelType, currentlySelectedGroupLabel), ...offered];
}
