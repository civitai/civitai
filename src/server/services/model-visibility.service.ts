import { dbRead } from '~/server/db/client';
import { canViewOwnerOnly, canViewPoiModel } from '~/server/utils/poi-model-visibility';
import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';

type Viewer = { id?: number | null; isModerator?: boolean | null } | null | undefined;

type ModelVisibilityRow = { status: ModelStatus; userId: number; poi: boolean };
const modelVisibilitySelect = { status: true, userId: true, poi: true } as const;

/**
 * Published or the viewer's own, and not `poi` unless theirs: `getModelHandler`'s rule without its
 * owner-block check. The caller lets moderators through.
 */
const isModelVisibleTo = (model: ModelVisibilityRow, viewer?: Viewer) =>
  (model.status === ModelStatus.Published || model.userId === viewer?.id) &&
  canViewPoiModel(model.poi, model.userId, viewer);

/**
 * Null unless `viewer` may see the model (`isModelVisibleTo`). A moderator sees every model, with
 * no read, so `userId` (the owner) is null for them.
 */
export async function getModelVisibleToViewer(
  modelId: number,
  viewer?: Viewer
): Promise<{ userId: number | null } | null> {
  if (viewer?.isModerator) return { userId: null };
  const model = await dbRead.model.findUnique({
    where: { id: modelId },
    select: modelVisibilitySelect,
  });
  if (!model || !isModelVisibleTo(model, viewer)) return null;
  return { userId: model.userId };
}

/**
 * Whether `viewer` may open the model as its page does: `getModelVisibleToViewer`, and not when its
 * owner has blocked the viewer (`getModelHandler`'s owner-block check). Moderators always may.
 */
export async function canViewerOpenModel(modelId: number, viewer?: Viewer): Promise<boolean> {
  if (viewer?.isModerator) return true;
  const model = await getModelVisibleToViewer(modelId, viewer);
  if (!model) return false;
  if (!viewer?.id || !model.userId || model.userId === viewer.id) return true;
  // Dynamic import: avoids an import cycle (user.service → image.service → post.service → tag.service).
  const { amIBlockedByUser } = await import('~/server/services/user.service');
  return !(await amIBlockedByUser({ userId: viewer.id, targetUserId: model.userId }));
}

/** The ids among `modelIds` that `viewer` may see (`isModelVisibleTo`); every id for a moderator. */
export async function getModelIdsVisibleToViewer(modelIds: number[], viewer?: Viewer) {
  const ids = [...new Set(modelIds)];
  if (viewer?.isModerator) return new Set(ids);
  if (!ids.length) return new Set<number>();
  const models = await dbRead.model.findMany({
    where: { id: { in: ids } },
    select: { id: true, ...modelVisibilitySelect },
  });
  return new Set(models.filter((model) => isModelVisibleTo(model, viewer)).map((m) => m.id));
}

/**
 * The ids among `modelIds` that are `poi` and not the viewer's (`canViewPoiModel`). Only the poi
 * rule, unlike `getModelIdsVisibleToViewer`: it serves `getHiddenModelVersionIds`, which adds the
 * Private rule and does not test publish status.
 */
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
