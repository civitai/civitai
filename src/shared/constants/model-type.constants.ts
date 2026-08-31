import { ModelType } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';

export type ModelTypeGroup = { group: string; types: ModelType[] };

export const modelTypeGroups: ModelTypeGroup[] = [
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
];

export const selectableModelTypes = modelTypeGroups.flatMap(({ types }) => types);

/**
 * Types no longer offered when picking a type. They stay valid everywhere else: a model already set
 * to one keeps the value, keeps displaying it, and must keep it through an edit of any other field
 * — which is why the picker re-adds the current value rather than filtering it out.
 */
export const retiredModelTypes = Object.values(ModelType).filter(
  (type) => !selectableModelTypes.includes(type)
);

export const currentlySelectedGroupLabel = 'Currently selected';

type ModelTypeSelectItem = { value: ModelType; label: string; group: string };

const toItem = (type: ModelType, group: string): ModelTypeSelectItem => ({
  value: type,
  label: getDisplayName(type),
  group,
});

/**
 * Flat items carrying a `group`, which is the shape SelectWrapper collapses into Mantine's grouped
 * data — handing it pre-grouped `{ group, items }` objects instead produces options with no value.
 */
export function getModelTypeSelectData(
  currentType?: ModelType | string | null
): ModelTypeSelectItem[] {
  const offered = modelTypeGroups.flatMap(({ group, types }) =>
    types.map((type) => toItem(type, group))
  );

  if (!currentType || selectableModelTypes.includes(currentType as ModelType)) return offered;

  return [toItem(currentType as ModelType, currentlySelectedGroupLabel), ...offered];
}
