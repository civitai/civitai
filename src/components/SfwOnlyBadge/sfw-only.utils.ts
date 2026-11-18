import { baseModelRecords, isMatureRestricted } from '~/shared/constants/basemodel.constants';

export const SFW_ONLY_TOOLTIP = "Mature content can't be posted with this base model.";

export function isBaseModelSfwOnly(baseModel?: string | null): boolean {
  return isMatureRestricted(baseModel, 'images');
}

// The generator picker lists ecosystems, not bases, so an ecosystem is marked only when every
// base in it is SFW only: SDXL holds SDXL Turbo but is not restricted.
export function isEcosystemNsfwRestricted(ecosystemId: number): boolean {
  const bases = baseModelRecords.filter((record) => record.ecosystemId === ecosystemId);
  return bases.length > 0 && bases.every((record) => isBaseModelSfwOnly(record.name));
}

export const SFW_ONLY_RESOURCE_TOOLTIP = 'This resource cannot be used to generate mature content';

// The generator's resource shield. A resource whose base caps generation, or that is sfwOnly or
// minor, can't generate mature content; one marked only for posting gets the posting copy.
export function getResourceSfwOnlyMessage(resource: {
  baseModel?: string | null;
  model: { sfwOnly?: boolean | null; minor?: boolean | null };
}): string | undefined {
  if (
    resource.model.sfwOnly ||
    resource.model.minor ||
    isMatureRestricted(resource.baseModel, 'generation')
  )
    return SFW_ONLY_RESOURCE_TOOLTIP;
  if (isBaseModelSfwOnly(resource.baseModel)) return SFW_ONLY_TOOLTIP;
  return undefined;
}
