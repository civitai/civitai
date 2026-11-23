import { useMemo } from 'react';
import { isViewingOwnImages, useFeedImageItems } from '~/components/Image/image.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import type { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { MediaType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

/**
 * Songs read through the image feed: one page of `filters`, with the feed's addon filters (no
 * excluded tags on the viewer's own songs) and the viewer's hidden preferences. The caller picks
 * the browsing level. One page and not `useQueryImages`: that hook aborts its request whenever its
 * last subscriber unmounts mid-request, which a song detail view's first render does, and logged
 * an aborted query on every song.
 */
export function useSongList(
  filters: Omit<GetInfiniteImagesInput, 'types' | 'browsingLevel'> & { browsingLevel: number },
  { enabled = true } = {}
) {
  const currentUser = useCurrentUser();
  const { settings } = useBrowsingSettingsAddons();
  const ownSongs = isViewingOwnImages(currentUser, filters);
  const { data, isLoading } = trpc.image.getInfinite.useQuery(
    {
      ...filters,
      types: [MediaType.audio],
      excludedTagIds: ownSongs ? [] : settings.excludedTagIds ?? [],
      disablePoi: settings.disablePoi,
      disableMinor: settings.disableMinor,
    },
    { enabled, trpc: { context: { skipBatch: true } } }
  );
  const pages = useMemo(() => (data ? [data] : undefined), [data]);
  const { items } = useFeedImageItems(pages, {});
  return { songs: items, isLoading };
}
