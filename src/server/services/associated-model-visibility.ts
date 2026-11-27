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
} satisfies Prisma.ModelSelect;

export type AssociatedModelVisibility = {
  userId: number;
  nsfwLevel: number;
  status: string;
  availability: string;
  mode: string | null;
  poi: boolean;
};

/**
 * Whether a linked model is listed to `viewer` at `browsingLevel`: the model listing's rules
 * (getModelsRaw), except that its owner and moderators always see it.
 */
export function canListAssociatedModel(
  model: AssociatedModelVisibility,
  viewer: Viewer,
  browsingLevel: number
) {
  if (canViewOwnerOnly(model.userId, viewer)) return true;
  return (
    model.status === ModelStatus.Published &&
    model.availability !== Availability.Private &&
    !isModelDeletedOrTakenDown(model) &&
    canViewPoiModel(model.poi, model.userId, viewer) &&
    Flags.intersects(model.nsfwLevel, browsingLevel)
  );
}
