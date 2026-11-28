import { useMemo } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useSongList } from '~/components/Music/useSongList';
import type { SongImage } from '~/components/MusicPlayer/PostSong';
import { ImageSort } from '~/server/common/enums';
import { MediaType } from '~/shared/utils/prisma/enums';

const MORE_FROM_LIMIT = 6;

/**
 * The creator's other songs for a song's detail view, newest first, and the card's title. The
 * viewer's own level, not the page's, which is scoped to the song's rating.
 */
export function useMoreFromCreator(song: SongImage, { enabled = true } = {}) {
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const { songs: items, isLoading } = useSongList(
    { userId: song.user.id, sort: ImageSort.Newest, limit: MORE_FROM_LIMIT + 1, browsingLevel },
    { enabled }
  );
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
