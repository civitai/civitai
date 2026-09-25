import type { Prisma } from '@prisma/client';
import { canViewModelVersionStatus } from '~/server/common/model-version-visibility';
import { hasEntityAccess } from '~/server/services/common.service';
import { Availability } from '~/shared/utils/prisma/enums';
import type { ModelStatus } from '~/shared/utils/prisma/enums';

// A version the caller may not see must be indistinguishable from one that does not exist.
export const MODEL_VERSION_NOT_FOUND = 'Model version not found.';

export const modelVersionVisibilitySelect = {
  id: true,
  status: true,
  publishedAt: true,
  availability: true,
  model: { select: { userId: true, status: true, availability: true } },
} satisfies Prisma.ModelVersionSelect;

type VisibilityRow = {
  id: number;
  status: ModelStatus;
  publishedAt: Date | null;
  availability: Availability;
  model: { userId: number; status: ModelStatus; availability: Availability };
};

export async function canViewModelVersion(
  version: VisibilityRow,
  viewer: { id: number; isModerator?: boolean | null }
) {
  const ownerId = version.model.userId;
  if (
    !canViewModelVersionStatus({
      viewer,
      ownerId,
      modelStatus: version.model.status,
      versionStatus: version.status,
      publishedAt: version.publishedAt,
    })
  )
    return false;
  if (viewer.isModerator || viewer.id === ownerId) return true;
  if (
    version.model.availability !== Availability.Private &&
    version.availability !== Availability.Private
  )
    return true;

  // Only private rows reach this: hasEntityAccess also refuses paid-gated versions to
  // non-purchasers, which is a usage gate, not a visibility one.
  const [access] = await hasEntityAccess({
    entityType: 'ModelVersion',
    entityIds: [version.id],
    userId: viewer.id,
    isModerator: !!viewer.isModerator,
  });
  return !!access?.hasAccess;
}
