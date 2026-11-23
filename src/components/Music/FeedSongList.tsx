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
import { useSongListPlays } from '~/components/Music/useSongPlays';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { PlayerSongCover } from '~/server/services/post.service';
import type { SongGenreTagIds } from '~/server/services/song-genre.service';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import { songGenreFromTagIds } from '~/shared/constants/song-genres';
import { MediaType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

/** Up next's name for songs played from a mixed image feed (Audio picked in its filters). */
const DEFAULT_FEED_SONG_LIST_NAME = 'Images';

const SongListNameContext = createContext<string | undefined>(undefined);

/** Names the list the songs of the feed below play from ("Next from <name>"). */
export function SongListNameProvider({ name, children }: { name?: string; children: ReactNode }) {
  return <SongListNameContext.Provider value={name}>{children}</SongListNameContext.Provider>;
}

const SongCoversContext = createContext<Map<number, PlayerSongCover> | null>(null);
const SongPlaysContext = createContext<Record<number, number> | null>(null);
const SongGenreTagIdsContext = createContext<SongGenreTagIds | undefined>(undefined);

/**
 * Reads covers and play counts once for the songs in `images`, and the genre-to-tag map their
 * genres are read through (one cached read, the one the genre chips make).
 */
export function FeedSongsProvider({
  images,
  children,
}: {
  images: { id: number; type: string }[];
  children: ReactNode;
}) {
  const features = useFeatureFlags();
  const songIds = images.filter((image) => image.type === MediaType.audio).map((image) => image.id);
  const covers = useSongListCovers(songIds);
  const plays = useSongListPlays(songIds);
  // `!!`: an off flag is absent from FeatureAccess, and `enabled: undefined` reads as enabled.
  const { data: genreTagIds } = trpc.image.getSongGenreTags.useQuery(undefined, {
    enabled: !!features.music && songIds.length > 0,
  });
  return (
    <SongCoversContext.Provider value={covers}>
      <SongPlaysContext.Provider value={plays}>
        <FeedSongGenresProvider genreTagIds={genreTagIds}>{children}</FeedSongGenresProvider>
      </SongPlaysContext.Provider>
    </SongCoversContext.Provider>
  );
}

/** The genre-to-tag map the songs below read their genres through (`useFeedSongGenre`). */
export function FeedSongGenresProvider({
  genreTagIds,
  children,
}: {
  genreTagIds: SongGenreTagIds | undefined;
  children: ReactNode;
}) {
  return (
    <SongGenreTagIdsContext.Provider value={genreTagIds}>
      {children}
    </SongGenreTagIdsContext.Provider>
  );
}

export function useFeedSongCover(songId: number) {
  const feedCovers = useContext(SongCoversContext);
  const ownCovers = useMusicPlayerCovers(feedCovers ? [] : [songId]);
  return (feedCovers ?? ownCovers).get(songId);
}

/**
 * A feed song's genre, from the tag ids its feed item carries (`image.getInfinite` always sends
 * them): the genre's tag is its mirror. Outside a `FeedSongsProvider` no genre is known.
 */
export function useFeedSongGenre(song: { tagIds?: number[] }) {
  return songGenreFromTagIds(song.tagIds, useContext(SongGenreTagIdsContext));
}

/** The song's play count; undefined until it is known. */
export function useFeedSongPlays(songId: number): number | undefined {
  const feedPlays = useContext(SongPlaysContext);
  const ownPlays = useSongListPlays(feedPlays ? [] : [songId]);
  return (feedPlays ?? ownPlays)[songId];
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
 * Pauses the song when it is playing, resumes it when it is paused in this same list, and
 * otherwise plays it from this list: a song loaded paused after a reload, or left by another list,
 * would resume with no Up next or with that other list's.
 */
function pressFeedSongPlay(song: SongImage, list: SongList) {
  const player = useMusicPlayerStore.getState();
  const isCurrent = player.current?.id === song.id;
  if (isCurrent && (player.playing || player.listName === list.name)) return player.togglePlay();
  const resumeAt = isCurrent ? useMusicPlayheadStore.getState().currentTime : undefined;
  playSongFromList(song, list, resumeAt);
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
          pressFeedSongPlay(song, getList());
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
