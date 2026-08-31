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
 * later is caught instead of silently becoming unpickable. Dropping `as const` above widens
 * `types` and makes this check pass vacuously, so the runtime test that the two lists cover the enum
 * is the durable half of the pair, not this.
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
 * `currentType` must come from {@link resolveModelTypeDefaults}, never from the live form value:
 * re-deriving it from the form would drop the grandfathered option the moment the user clicked
 * another type, making the original unrecoverable.
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

type ModelTypeSeed = { id?: number | null; type?: ModelType | string | null } | null | undefined;

/**
 * Splits what the form starts on from what the picker has to keep offering.
 *
 * A saved model keeps its type whatever it is, retired or not, and the picker re-offers it. A model
 * being seeded from someone's template or bounty is a NEW model, so it may only start on a type that
 * is still offered: leaving a retired one in place renders a blank required field while the form
 * still holds the retired value, and the submit then creates a model on it.
 */
export function resolveModelTypeDefaults(model: ModelTypeSeed) {
  const seeded = (model?.type ?? null) as ModelType | null;
  const isSaved = !!model?.id;
  const seededIsOffered = !!seeded && selectableModelTypeSet.has(seeded);

  return {
    grandfatheredType: isSaved ? seeded : null,
    initialType: isSaved || seededIsOffered ? seeded : null,
  };
}
