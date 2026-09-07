import { ModelType } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';

export const modelTypeGroups = [
  { group: 'Adapters', types: [ModelType.LORA, ModelType.LoCon, ModelType.DoRA] },
  {
    group: 'Component replacements',
    types: [ModelType.VAE, ModelType.TextEncoder, ModelType.UNet, ModelType.Upscaler],
  },
  {
    group: 'Workflow additives',
    types: [ModelType.Workflows, ModelType.Wildcards, ModelType.Controlnet],
  },
] as const satisfies readonly { group: string; types: readonly ModelType[] }[];

/**
 * Offered under no heading — a group of one repeats its own name as a header. Two lists because
 * Checkpoint leads the picker and Other trails it, either side of the groups.
 */
export const leadingUngroupedModelTypes = [
  ModelType.Checkpoint,
] as const satisfies readonly ModelType[];
export const trailingUngroupedModelTypes = [
  ModelType.Other,
] as const satisfies readonly ModelType[];

export const selectableModelTypes = [
  ...leadingUngroupedModelTypes,
  ...modelTypeGroups.flatMap(({ types }) => types),
  ...trailingUngroupedModelTypes,
] as ModelType[];

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

type SelectableModelType =
  | (typeof leadingUngroupedModelTypes)[number]
  | (typeof modelTypeGroups)[number]['types'][number]
  | (typeof trailingUngroupedModelTypes)[number];
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
  : {
      error: 'Add it to modelTypeGroups, one of the ungrouped lists, or retiredModelTypes';
      missing: UncategorisedModelType;
    } = true;
void _everyModelTypeIsCategorised;

const selectableModelTypeSet = new Set<string>(selectableModelTypes);

export const currentlySelectedGroupLabel = 'Currently selected';

type ModelTypeSelectItem = { value: ModelType; label: string; group?: string };

const toItem = (type: ModelType, group?: string): ModelTypeSelectItem => ({
  value: type,
  label: getDisplayName(type),
  ...(group ? { group } : {}),
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
  const offered = [
    ...leadingUngroupedModelTypes.map((type) => toItem(type)),
    ...modelTypeGroups.flatMap(({ group, types }) => types.map((type) => toItem(type, group))),
    ...trailingUngroupedModelTypes.map((type) => toItem(type)),
  ];

  if (!currentType || selectableModelTypeSet.has(currentType)) return offered;

  return [toItem(currentType as ModelType, currentlySelectedGroupLabel), ...offered];
}

type ModelTypeSeed = { id?: number | null; type?: ModelType | string | null } | null | undefined;

/** What a form with nothing to go on starts on. */
export const defaultModelType = ModelType.Checkpoint;

/**
 * Splits what the form starts on from what the picker has to keep offering. Both must come from one
 * call: a value the form holds that the picker will not render is a blank required input over a live
 * value, which submits.
 *
 * A saved model keeps its type whatever it is, retired or not, and the picker re-offers it. A
 * template or bounty seeds a NEW model, so a retired type there falls back to `Other`, the one
 * selectable type that claims nothing about the model. `replacedType` names what was dropped, so the
 * form can say so rather than substituting silently.
 */
export function resolveModelTypeDefaults(model: ModelTypeSeed) {
  const seeded = (model?.type ?? null) as ModelType | null;
  const isSaved = !!model?.id;

  if (isSaved && seeded)
    return { grandfatheredType: seeded, initialType: seeded, replacedType: null };
  if (!seeded)
    return { grandfatheredType: null, initialType: defaultModelType, replacedType: null };
  if (selectableModelTypeSet.has(seeded))
    return { grandfatheredType: null, initialType: seeded, replacedType: null };

  return { grandfatheredType: null, initialType: ModelType.Other, replacedType: seeded };
}
