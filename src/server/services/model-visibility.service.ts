import { dbRead } from '~/server/db/client';
import { canViewOwnerOnly, canViewPoiModel } from '~/server/utils/poi-model-visibility';
import { Availability } from '~/shared/utils/prisma/enums';

type Viewer = { id?: number | null; isModerator?: boolean | null } | null | undefined;

/** The ids among `modelIds` that `viewer` may not see (see `canViewPoiModel`). */
export async function getHiddenModelIds(modelIds: number[], viewer?: Viewer) {
  const ids = [...new Set(modelIds)];
  if (!ids.length || viewer?.isModerator) return new Set<number>();

  const flagged = await dbRead.model.findMany({
    where: { id: { in: ids }, poi: true },
    select: { id: true, userId: true },
  });
  return new Set(
    flagged.filter((model) => !canViewPoiModel(true, model.userId, viewer)).map((m) => m.id)
  );
}

type VersionVisibility = {
  id: number;
  modelId: number;
  availability?: Availability | null;
  model: { poi?: boolean | null; availability?: Availability | null; userId?: number | null };
};

/**
 * A version is Private when it or its model is. A missing availability reads as Private, so a
 * query that stops selecting it hides the version rather than serving it.
 */
export function isPrivateModelVersion(version: VersionVisibility) {
  return (
    version.availability == null ||
    version.model.availability == null ||
    version.availability === Availability.Private ||
    version.model.availability === Availability.Private
  );
}

/**
 * The ids among `versions` that the viewer may not see: a version of a `poi` model, or a Private
 * one, unless the viewer owns the model or is a moderator. `getViewer` is only called when some
 * version is flagged or Private, so a public lookup pays for no session resolve.
 */
export async function getHiddenModelVersionIds(
  versions: VersionVisibility[],
  getViewer: () => Promise<Viewer>
) {
  const restricted = versions.filter((v) => v.model.poi || isPrivateModelVersion(v));
  if (!restricted.length) return new Set<number>();

  const viewer = await getViewer();
  const hiddenModelIds = await getHiddenModelIds(
    restricted.filter((v) => v.model.poi).map((v) => v.modelId),
    viewer
  );
  return new Set(
    restricted
      .filter(
        (v) =>
          hiddenModelIds.has(v.modelId) ||
          (isPrivateModelVersion(v) && !canViewOwnerOnly(v.model.userId, viewer))
      )
      .map((v) => v.id)
  );
}
