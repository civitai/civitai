import { useMemo } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { isViewingOwnImages, useFeedImageItems } from '~/components/Image/image.utils';
import type { SongImage } from '~/components/MusicPlayer/PostSong';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { ImageSort } from '~/server/common/enums';
import { MediaType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

const MORE_FROM_LIMIT = 6;

/**
 * The creator's other songs for a song's detail view, newest first, and the card's title. The image
 * feed's read, with the feed's addon filters and hidden preferences, but one page and not through
 * `useQueryImages`: that hook aborts its request whenever its last subscriber unmounts mid-request,
 * which the detail view's first render does, and logged an aborted query on every song.
 * The viewer's own level, not the page's, which is scoped to the song's rating.
 */
export function useMoreFromCreator(song: SongImage, { enabled = true } = {}) {
  const currentUser = useCurrentUser();
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const { settings } = useBrowsingSettingsAddons();
  const userId = song.user.id;
  const ownSongs = isViewingOwnImages(currentUser, { userId });
  const { data, isLoading } = trpc.image.getInfinite.useQuery(
    {
      types: [MediaType.audio],
      userId,
      sort: ImageSort.Newest,
      limit: MORE_FROM_LIMIT + 1,
      browsingLevel,
      excludedTagIds: ownSongs ? [] : settings.excludedTagIds ?? [],
      disablePoi: settings.disablePoi,
      disableMinor: settings.disableMinor,
    },
    { enabled, trpc: { context: { skipBatch: true } } }
  );
  const pages = useMemo(() => (data ? [data] : undefined), [data]);
  const { items } = useFeedImageItems(pages, {});
  const songs = useMemo(
    () =>
      items
        .filter((image) => image.id !== song.id && image.type === MediaType.audio)
        .slice(0, MORE_FROM_LIMIT) as SongImage[],
    [items, song.id]
  );
  const name = `More from ${song.user.username || 'this creator'}`;
  return { songs, name, isLoading };
}
