import { useMemo } from 'react';
import { mergeViewerEventDecorations } from '~/components/Decorations/useViewerEventDecorations';
import { SEARCH_HITS_PER_PAGE } from '~/components/Search/search.constants';
import type { GetSearchEventDecorationsInput } from '~/server/schema/cosmetic.schema';
import type { EventDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getReleasedEventDecoration } from '~/shared/constants/event-decoration.constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

type SearchEntity = GetSearchEventDecorationsInput['entityType'];
type Decoratable = { id: number; eventDecoration?: EventDecorationCosmetic | null };

/**
 * What to ask for the hats on a search grid, or null to ask nothing. One request per page of hits.
 *
 * Unlike the home blocks' gate, this one stays on after `startsAt`: the index carries no hats, so
 * from launch every viewer asks, and the server answers them all from the edge. Before launch only
 * a viewer the event's flag is on for asks. Whether they may see the hats stays the server's call.
 */
export function searchEventDecorationQuery(
  hitIds: number[],
  {
    entity,
    features,
    now = new Date(),
  }: { entity: SearchEntity; features: Partial<FeatureAccess>; now?: Date }
) {
  if (!hitIds.length) return null;
  const definition = getReleasedEventDecoration(entity, now);
  if (!definition) return null;
  const flagged = !!definition.featureFlag && !!features[definition.featureFlag];
  if (now < definition.startsAt && !flagged) return null;
  // Pages in hit order, so loading more never changes an earlier page's key; each page sorted and
  // deduped, which is the one spelling the server accepts and the edge caches. Not `chunkIds`: it
  // dedupes across the whole list, so a repeated hit would shift every later page's boundary.
  const pages: number[][] = [];
  for (let i = 0; i < hitIds.length; i += SEARCH_HITS_PER_PAGE)
    pages.push([...new Set(hitIds.slice(i, i + SEARCH_HITS_PER_PAGE))].sort((a, b) => a - b));
  return { entityType: entity, pages };
}

/**
 * Hats for the cards on a search grid. `hits` is the infinite list as the index returned it, which
 * fixes the page boundaries; the hats are merged onto `items`, the list you go on to render.
 */
export function useSearchEventDecorations<T extends Decoratable>(
  hits: { id: number }[],
  items: T[],
  { entity }: { entity: SearchEntity }
): T[] {
  const features = useFeatureFlags();
  const idKey = hits.map((hit) => hit.id).join(',');

  const query = useMemo(
    () =>
      searchEventDecorationQuery(
        hits.map((hit) => hit.id),
        { entity, features }
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idKey, entity, features]
  );

  const queries = trpc.useQueries((t) =>
    (query?.pages ?? []).map((ids) =>
      t.cosmetic.getEventDecorationsForSearch(
        { entityType: query!.entityType, ids },
        { staleTime: 60_000, trpc: { context: { skipBatch: true } } }
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
