import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext } from 'react';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { Tooltip } from '~/components/MantineOverlays';
import type { SongImage, SongList } from '~/components/MusicPlayer/PostSong';
import { playSongFromList, SongMenuItems } from '~/components/MusicPlayer/PostSong';
import { useMusicPlayerStore } from '~/store/music-player.store';
import { MediaType } from '~/shared/utils/prisma/enums';

/** Up next's name for songs played from a mixed image feed (Audio picked in its filters). */
export const DEFAULT_FEED_SONG_LIST_NAME = 'Images';

const SongListNameContext = createContext<string | undefined>(undefined);

/** Names the list the songs of the feed below play from ("Next from <name>"). */
export function SongListNameProvider({ name, children }: { name?: string; children: ReactNode }) {
  return <SongListNameContext.Provider value={name}>{children}</SongListNameContext.Provider>;
}

/**
 * The list a feed song plays from: the feed's songs loaded so far, in display order. A getter, so
 * it is read when play is pressed and a page loaded later is not part of it.
 */
export function useFeedSongList() {
  const name = useContext(SongListNameContext) ?? DEFAULT_FEED_SONG_LIST_NAME;
  const { getImages } = useImagesContext();
  return useCallback(
    (): SongList => ({
      name,
      songs: (getImages() ?? []).filter((image) => image.type === MediaType.audio),
    }),
    [name, getImages]
  );
}

/** The play / pause control of a song in a feed (Civitai primary, as on the post page). */
export function FeedSongPlayButton({
  song,
  title,
  size,
  className,
}: {
  song: SongImage;
  title: string;
  size: number;
  className?: string;
}) {
  const getList = useFeedSongList();
  const isCurrent = useMusicPlayerStore((s) => s.current?.id === song.id);
  const playing = useMusicPlayerStore((s) => s.current?.id === song.id && s.playing);
  const label = playing ? 'Pause' : 'Play';
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={`${label} ${title}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isCurrent) useMusicPlayerStore.getState().togglePlay();
          else playSongFromList(song, getList());
        }}
        style={{ width: size, height: size }}
        className={clsx(
          'flex shrink-0 items-center justify-center rounded-full bg-[var(--mantine-primary-color-filled)] text-[var(--mantine-primary-color-contrast)] transition-transform hover:scale-105',
          className
        )}
      >
        {playing ? (
          <IconPlayerPauseFilled size={size / 2} />
        ) : (
          <IconPlayerPlayFilled size={size / 2} />
        )}
      </button>
    </Tooltip>
  );
}

/** The song items of a feed song's ⋯ menu; rendered when the menu opens, so the list is current. */
export function FeedSongMenuItems({ song }: { song: SongImage }) {
  const getList = useFeedSongList();
  return <SongMenuItems song={song} list={getList()} />;
}
