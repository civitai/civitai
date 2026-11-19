import { IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext } from 'react';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { Tooltip } from '~/components/MantineOverlays';
import type { SongImage, SongList } from '~/components/MusicPlayer/PostSong';
import { playSongFromList, SongMenuItems } from '~/components/MusicPlayer/PostSong';
import {
  useMusicPlayerCovers,
  useSongListCovers,
} from '~/components/MusicPlayer/useMusicPlayerCover';
import type { PlayerSongCover } from '~/server/services/post.service';
import { useMusicPlayerStore } from '~/store/music-player.store';
import { MediaType } from '~/shared/utils/prisma/enums';

/** Up next's name for songs played from a mixed image feed (Audio picked in its filters). */
const DEFAULT_FEED_SONG_LIST_NAME = 'Images';

const SongListNameContext = createContext<string | undefined>(undefined);

/** Names the list the songs of the feed below play from ("Next from <name>"). */
export function SongListNameProvider({ name, children }: { name?: string; children: ReactNode }) {
  return <SongListNameContext.Provider value={name}>{children}</SongListNameContext.Provider>;
}

const SongCoversContext = createContext<Map<number, PlayerSongCover> | null>(null);

/** Reads the covers of every song in `images` at once, for the feed's Song Cards and Rows. */
export function FeedSongCoversProvider({
  images,
  children,
}: {
  images: { id: number; type: string }[];
  children: ReactNode;
}) {
  const covers = useSongListCovers(
    images.filter((image) => image.type === MediaType.audio).map((image) => image.id)
  );
  return <SongCoversContext.Provider value={covers}>{children}</SongCoversContext.Provider>;
}

/** A feed song's cover: from the feed's shared read, or its own read outside a feed. */
export function useFeedSongCover(songId: number) {
  const feedCovers = useContext(SongCoversContext);
  const ownCovers = useMusicPlayerCovers(feedCovers ? [] : [songId]);
  return (feedCovers ?? ownCovers).get(songId);
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

/**
 * The play / pause control of a song in a feed: a white disc with a dark icon on the Song Card
 * (Pencil `AECSM`), a bare white icon over the dimmed cover in a Song Row (`VQ3N0`).
 */
export function FeedSongPlayButton({
  song,
  title,
  size,
  iconSize,
  variant,
  className,
}: {
  song: SongImage;
  title: string;
  size: number;
  iconSize: number;
  variant: 'disc' | 'bare';
  className?: string;
}) {
  const getList = useFeedSongList();
  const isCurrent = useMusicPlayerStore((s) => s.current?.id === song.id);
  const playing = useMusicPlayerStore((s) => s.current?.id === song.id && s.playing);
  const label = playing ? 'Pause' : 'Play';
  const Icon = playing ? IconPlayerPause : IconPlayerPlay;
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
          'flex shrink-0 items-center justify-center',
          variant === 'disc'
            ? 'rounded-full bg-white text-dark-8 transition-transform hover:scale-105'
            : 'rounded bg-black/50 text-white',
          className
        )}
      >
        <Icon size={iconSize} />
      </button>
    </Tooltip>
  );
}

/** The song items of a feed song's ⋯ menu; rendered when the menu opens, so the list is current. */
export function FeedSongMenuItems({ song }: { song: SongImage }) {
  const getList = useFeedSongList();
  return <SongMenuItems song={song} list={getList()} />;
}
