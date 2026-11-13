import { useMemo } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useQueryImages } from '~/components/Image/image.utils';
import type { SongImage } from '~/components/MusicPlayer/PostSong';
import { ImageSort } from '~/server/common/enums';
import { MediaType } from '~/shared/utils/prisma/enums';

const MORE_FROM_LIMIT = 6;

/**
 * The creator's other songs for a song's detail view, newest first, and the list name play uses for
 * them. The viewer's own browsing level, not the page's: the detail view scopes its tree to the
 * song's rating, which would drop the creator's other songs rated differently.
 */
export function useMoreFromCreator(song: SongImage, { enabled = true } = {}) {
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const { images, isLoading } = useQueryImages(
    {
      types: [MediaType.audio],
      userId: song.user.id,
      sort: ImageSort.Newest,
      limit: MORE_FROM_LIMIT + 1,
      browsingLevel,
    },
    { enabled }
  );
  const songs = useMemo(
    () =>
      (images ?? [])
        .filter((image) => image.id !== song.id && image.type === MediaType.audio)
        .slice(0, MORE_FROM_LIMIT) as SongImage[],
    [images, song.id]
  );
  const name = `More from ${song.user.username || 'this creator'}`;
  return { songs, name, isLoading };
}
