import { getRestrictedNsfwLevelsForBaseModel } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import { baseModelRecords } from '~/shared/constants/basemodel.constants';

export const SFW_ONLY_TOOLTIP = "Mature content can't be posted with this base model.";

const MATURE_LEVELS = [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX];

// "SFW only" is true only when every mature level is restricted. A licence restricting some
// levels (say XXX alone) still lands in `nsfwRestrictedBaseModels` but needs its own wording.
// Read at call time from the licence table, so flagging a licence marks its bases with no UI edit.
export function isBaseModelSfwOnly(baseModel?: string | null): boolean {
  if (!baseModel) return false;
  const restricted = getRestrictedNsfwLevelsForBaseModel(baseModel);
  return MATURE_LEVELS.every((level) => restricted.includes(level));
}

// The generator picker lists ecosystems, not bases, so an ecosystem is marked only when every
// base in it is SFW only: SDXL holds SDXL Turbo but is not restricted.
export function isEcosystemNsfwRestricted(ecosystemId: number): boolean {
  const bases = baseModelRecords.filter((record) => record.ecosystemId === ecosystemId);
  return bases.length > 0 && bases.every((record) => isBaseModelSfwOnly(record.name));
}

export const SFW_ONLY_RESOURCE_TOOLTIP = 'This resource cannot be used to generate mature content';

// The generator's resource shield. An sfwOnly or minor resource keeps its own, stronger claim;
// a resource marked only by its base gets the posting copy, because generation itself is not
// refused for these bases.
export function getResourceSfwOnlyMessage(resource: {
  baseModel?: string | null;
  model: { sfwOnly?: boolean | null; minor?: boolean | null };
}): string | undefined {
  if (resource.model.sfwOnly || resource.model.minor) return SFW_ONLY_RESOURCE_TOOLTIP;
  if (isBaseModelSfwOnly(resource.baseModel)) return SFW_ONLY_TOOLTIP;
  return undefined;
}
