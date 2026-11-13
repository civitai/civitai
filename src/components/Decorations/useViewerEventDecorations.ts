import { useMemo } from 'react';
import type { HydratableEntity } from '~/components/Reaction/useHydratedImageReactions';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { GetViewerEventDecorationsInput } from '~/server/schema/cosmetic.schema';
import { VIEWER_EVENT_DECORATION_LIMIT } from '~/server/schema/cosmetic.schema';
import type { EventDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getPreviewEventDecoration } from '~/shared/constants/event-decoration.constants';
import { CosmeticEntity } from '~/shared/utils/prisma/enums';
import { chunkIds } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

const decoratedEntity: Partial<
  Record<HydratableEntity, GetViewerEventDecorationsInput['entityType']>
> = {
  image: CosmeticEntity.Image,
  model: CosmeticEntity.Model,
  article: CosmeticEntity.Article,
};

type Decoratable = { id: number; eventDecoration?: EventDecorationCosmetic | null };

/**
 * What to ask for this viewer's preview hats, or null to ask nothing.
 *
 * 🔴 Null for every viewer the event's flag is off for, not only the signed out: this runs once per
 * home-block section for all homepage traffic, and only flagged viewers can be shown anything. And
 * null from `startsAt`, when the shared block payload carries the hats itself. Whether the viewer
 * really may see them stays the server's call; the flag only spares everyone else the request.
 */
export function viewerEventDecorationQuery(
  ids: number[],
  {
    entity,
    userId,
    features,
    now = new Date(),
  }: { entity: HydratableEntity; userId?: number; features: Partial<FeatureAccess>; now?: Date }
) {
  const entityType = decoratedEntity[entity];
  if (!entityType || !userId || !ids.length) return null;
  const definition = getPreviewEventDecoration(entityType, now);
  if (!definition?.featureFlag || !features[definition.featureFlag]) return null;
  // Sorted so the key repeats across the block's per-mount shuffle (see reactionQueryChunks).
  const chunks = chunkIds(
    [...ids].sort((a, b) => a - b),
    VIEWER_EVENT_DECORATION_LIMIT
  );
  return { entityType, chunks };
}

/**
 * Give each item the viewer's hat where the shared payload has none. Never replaces one it has.
 * Returns the same array when nothing changes.
 */
export function mergeViewerEventDecorations<T extends Decoratable>(
  items: T[],
  byId: Record<number, EventDecorationCosmetic>
): T[] {
  let changed = false;
  const merged = items.map((item) => {
    const decoration = byId[item.id];
    if (item.eventDecoration || !decoration) return item;
    changed = true;
    return { ...item, eventDecoration: decoration };
  });
  return changed ? merged : items;
}

/**
 * The viewer's preview hats on a surface served from a cache every viewer shares (the home
 * blocks). That payload is fetched with no viewer, so before an event's start it carries no hats
 * at all; this adds the ones this viewer may see. Compose it like `useHydratedImageReactions`, on
 * the list you go on to render.
 */
export function useViewerEventDecorations<T extends Decoratable>(
  items: T[],
  { entity }: { entity: HydratableEntity }
): T[] {
  const userId = useCurrentUser()?.id;
  const features = useFeatureFlags();
  const idKey = items.map((item) => item.id).join(',');

  const query = useMemo(
    () =>
      viewerEventDecorationQuery(
        items.map((item) => item.id),
        { entity, userId, features }
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idKey, entity, userId, features]
  );

  const queries = trpc.useQueries((t) =>
    (query?.chunks ?? []).map((ids) =>
      t.cosmetic.getViewerEventDecorations(
        { entityType: query!.entityType, ids },
        { staleTime: 60_000 }
      )
    )
  );

  const byId = useMemo(
    () => Object.assign({}, ...queries.map((x) => x.data ?? {})),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queries.map((x) => x.dataUpdatedAt).join(',')]
  ) as Record<number, EventDecorationCosmetic>;

  return useMemo(() => mergeViewerEventDecorations(items, byId), [items, byId]);
}
