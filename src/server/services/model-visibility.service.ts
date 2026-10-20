import { dbRead } from '~/server/db/client';
import { canViewPoiModel } from '~/server/utils/poi-model-visibility';

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
