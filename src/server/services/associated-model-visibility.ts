import type { Prisma } from '@prisma/client';
import { isModelDeletedOrTakenDown } from '~/server/utils/model-withheld';
import { canViewOwnerOnly, canViewPoiModel } from '~/server/utils/poi-model-visibility';
import { Flags } from '~/shared/utils/flags';
import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';

type Viewer = { id?: number | null; isModerator?: boolean | null } | null | undefined;

export const associatedModelVisibilitySelect = {
  id: true,
  userId: true,
  nsfwLevel: true,
  status: true,
  availability: true,
  mode: true,
  poi: true,
  minor: true,
  tagsOnModels: { select: { tagId: true } },
} satisfies Prisma.ModelSelect;

export type AssociatedModelVisibility = {
  id: number;
  userId: number;
  nsfwLevel: number;
  status: string;
  availability: string;
  mode: string | null;
  poi: boolean;
  minor: boolean;
  tagsOnModels: { tagId: number }[];
};

export type AssociatedModelAddons = {
  disableMinor?: boolean;
  excludedTagIds?: number[];
  excludedUserIds?: number[];
  excludedModelIds?: number[];
};

/**
 * Mirrors the model listing's status, availability, takedown, POI, browsing-level, `disableMinor`,
 * excluded-tag and hidden user/model rules. The owner and moderators skip status, availability,
 * takedown and POI, and also see an unrated (nsfwLevel 0) model; the browsing level and the
 * viewer's hidden users and models bind them like everyone else. `disableMinor` and excluded tags
 * spare only the owner.
 */
export function canListAssociatedModel(
  model: AssociatedModelVisibility,
  viewer: Viewer,
  browsingLevel: number,
  addons: AssociatedModelAddons = {}
) {
  const { disableMinor, excludedTagIds, excludedUserIds, excludedModelIds } = addons;
  const privileged = canViewOwnerOnly(model.userId, viewer);
  const ownsModel = !!viewer?.id && viewer.id === model.userId;
  if (excludedModelIds?.includes(model.id) || excludedUserIds?.includes(model.userId)) return false;
  if (!ownsModel) {
    if (disableMinor && model.minor) return false;
    if (excludedTagIds?.length && model.tagsOnModels.some((t) => excludedTagIds.includes(t.tagId)))
      return false;
  }
  if (!Flags.intersects(model.nsfwLevel, browsingLevel) && !(privileged && model.nsfwLevel === 0))
    return false;
  if (privileged) return true;
  return (
    model.status === ModelStatus.Published &&
    model.availability !== Availability.Private &&
    !isModelDeletedOrTakenDown(model) &&
    canViewPoiModel(model.poi, model.userId, viewer)
  );
}
