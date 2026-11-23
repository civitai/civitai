import { useMemo } from 'react';
import { useFeedAddonFilters, useFeedImageItems } from '~/components/Image/image.utils';
import type { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { MediaType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

/**
 * Songs read through the image feed: one page of `filters`, with the feed's addon filters (no
 * excluded tags on the viewer's own songs) and the viewer's hidden preferences. One page and not
 * `useQueryImages`: that hook aborts its request whenever its
 * last subscriber unmounts mid-request, which a song detail view's first render does, and logged
 * an aborted query on every song.
 */
type SongListFilters = Omit<
  GetInfiniteImagesInput,
  'types' | 'browsingLevel' | 'excludedTagIds' | 'disablePoi' | 'disableMinor' | 'hidden'
> & { browsingLevel: number };

/** What a song list asks the image feed for: songs only, with the viewer's addon filters. */
export function songListInput(
  filters: SongListFilters,
  addonFilters: ReturnType<typeof useFeedAddonFilters>
) {
  return { ...filters, types: [MediaType.audio], ...addonFilters };
}

export function useSongList(filters: SongListFilters, { enabled = true } = {}) {
  const addonFilters = useFeedAddonFilters(filters);
  const { data, isLoading } = trpc.image.getInfinite.useQuery(
    songListInput(filters, addonFilters),
    { enabled, trpc: { context: { skipBatch: true } } }
  );
  const pages = useMemo(() => (data ? [data] : undefined), [data]);
  const { items } = useFeedImageItems(pages, {});
  return { songs: items, isLoading };
}
