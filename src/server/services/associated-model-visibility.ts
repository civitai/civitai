import type { Prisma } from '@prisma/client';
import { isModelDeletedOrTakenDown } from '~/server/utils/model-withheld';
import { canViewOwnerOnly, canViewPoiModel } from '~/server/utils/poi-model-visibility';
import { Flags } from '~/shared/utils/flags';
import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';

type Viewer = { id?: number | null; isModerator?: boolean | null } | null | undefined;

export const associatedModelVisibilitySelect = {
  userId: true,
  nsfwLevel: true,
  status: true,
  availability: true,
  mode: true,
  poi: true,
  minor: true,
} satisfies Prisma.ModelSelect;

export type AssociatedModelVisibility = {
  userId: number;
  nsfwLevel: number;
  status: string;
  availability: string;
  mode: string | null;
  poi: boolean;
  minor: boolean;
};

/**
 * Mirrors getModelsRaw's status, availability, takedown, POI, browsing-level and `disableMinor`
 * rules. The owner and moderators skip status, availability, takedown and POI, and also see an
 * unrated (nsfwLevel 0) model; the browsing level binds them like everyone else. `disableMinor`
 * spares only the owner. Not mirrored: blocked browsing tags and `excludedTagIds`.
 */
export function canListAssociatedModel(
  model: AssociatedModelVisibility,
  viewer: Viewer,
  browsingLevel: number,
  disableMinor?: boolean
) {
  const privileged = canViewOwnerOnly(model.userId, viewer);
  const ownsModel = !!viewer?.id && viewer.id === model.userId;
  if (disableMinor && model.minor && !ownsModel) return false;
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

export type AssociatedModelAddons = { disableMinor?: boolean };
