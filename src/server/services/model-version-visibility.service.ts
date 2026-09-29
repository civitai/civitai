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

type Viewer = { id: number; isModerator?: boolean | null };

const isPrivate = (version: VisibilityRow) =>
  version.model.availability === Availability.Private ||
  version.availability === Availability.Private;

/**
 * The versions in `versions` the viewer may see, in input order. `checkGrants: false` refuses a
 * private version that would need an access grant instead of looking the grant up, for callers
 * inside a transaction.
 */
export async function filterViewableModelVersions<T extends VisibilityRow>(
  versions: T[],
  viewer: Viewer,
  { checkGrants = true }: { checkGrants?: boolean } = {}
): Promise<T[]> {
  const viewable = new Set<T>();
  const needGrant: T[] = [];
  for (const version of versions) {
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
      continue;
    if (viewer.isModerator || viewer.id === ownerId || !isPrivate(version)) viewable.add(version);
    else needGrant.push(version);
  }

  // Only private rows reach this: hasEntityAccess also refuses paid-gated versions to
  // non-purchasers, which is a usage gate, not a visibility one.
  if (needGrant.length && checkGrants) {
    const access = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: needGrant.map((v) => v.id),
      userId: viewer.id,
      isModerator: !!viewer.isModerator,
    });
    const granted = new Set(access.filter((a) => a.hasAccess).map((a) => a.entityId));
    for (const version of needGrant) if (granted.has(version.id)) viewable.add(version);
  }

  return versions.filter((v) => viewable.has(v));
}

export async function canViewModelVersion(version: VisibilityRow, viewer: Viewer) {
  return (await filterViewableModelVersions([version], viewer)).length > 0;
}
