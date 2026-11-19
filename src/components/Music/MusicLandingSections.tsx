import { Title } from '@mantine/core';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import {
  FeedSongPlayButton,
  FeedSongsProvider,
  SongListNameProvider,
  useFeedSongCover,
} from '~/components/Music/FeedSongList';
import { SongCard, UNTITLED_SONG } from '~/components/Music/SongCard';
import {
  MUSIC_FEED_COLUMN_WIDTH,
  SONG_CARD_TEXT_HEIGHT,
  SONG_COVER_RATIO,
} from '~/components/Music/song-card.constants';
import { songTextBright } from '~/components/Music/song-styles';
import { SongArt, songCreatorHref } from '~/components/MusicPlayer/MusicPlayerParts';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import { NextLink } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ImageSort } from '~/server/common/enums';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { useMusicPlayerStore } from '~/store/music-player.store';
import { trpc } from '~/utils/trpc';

export const RISING_LIST_NAME = 'Rising this week';
export const RECENTLY_PLAYED_LIST_NAME = 'Recently played';
// Pencil `CnGl0`: one large tile and six.
const RISING_TILES = 7;
const RECENT_CARD_HEIGHT =
  Math.round(MUSIC_FEED_COLUMN_WIDTH * SONG_COVER_RATIO) + SONG_CARD_TEXT_HEIGHT;

/**
 * `ids` read through the image feed, so a song the viewer may not see (removed, blocked, held,
 * outside their browsing level, by a hidden user or with a hidden tag) drops out; the rest keep
 * the order of `ids`, at most `max` of them.
 */
function useSongsInOrder({
  ids,
  tags,
  max,
  enabled,
}: {
  ids: number[];
  tags?: number[];
  max: number;
  enabled: boolean;
}) {
  const { images, isLoading } = useQueryImages(
    {
      ids,
      tags,
      types: [MediaType.audio],
      period: MetricTimeframe.AllTime,
      sort: ImageSort.Newest,
      limit: ids.length,
      withMeta: false,
    },
    { enabled: enabled && ids.length > 0 }
  );
  const songs = useMemo(() => {
    const byId = new Map(images.map((image) => [image.id, image]));
    return ids.flatMap((id) => byId.get(id) ?? []).slice(0, max) as ImagesInfiniteModel[];
  }, [ids, images, max]);
  return { songs, isLoading };
}

/** A landing section: its heading, and its songs as the list they play from. */
function SongSection({
  title,
  songs,
  children,
}: {
  title: string;
  songs: ImagesInfiniteModel[];
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 sm:gap-[18px]">
      <Title order={2} className={clsx('text-xl font-bold sm:text-3xl', songTextBright)}>
        {title}
      </Title>
      <SongListNameProvider name={title}>
        <FeedSongsProvider images={songs}>
          <ImagesProvider images={songs} hideHatTurf>
            {children}
          </ImagesProvider>
        </FeedSongsProvider>
      </SongListNameProvider>
    </section>
  );
}

/** The viewer's last songs started in this browser, newest first; hidden when there are none. */
export function RecentlyPlayedSection() {
  const features = useFeatureFlags();
  const ids = useMusicPlayerStore((s) => s.recentlyPlayed);
  const { songs } = useSongsInOrder({ ids, max: ids.length, enabled: !!features.music });
  if (!songs.length) return null;
  return (
    <SongSection title={RECENTLY_PLAYED_LIST_NAME} songs={songs}>
      {/* Pencil `sOs9H`, as Song Cards: one row, scrolling sideways. */}
      <div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-1">
        {songs.map((song) => (
          <div key={song.id} className="shrink-0" style={{ width: MUSIC_FEED_COLUMN_WIDTH }}>
            <SongCard data={song} height={RECENT_CARD_HEIGHT} />
          </div>
        ))}
      </div>
    </SongSection>
  );
}

// Pencil `CnGl0` (1440): the large tile spans both rows; the six beside it fill two rows of
// 380/210/270 and 210/380/270 (columns 210 + 150 + 210 + 270). `hiEzh` (390): two columns, the
// large tile two rows tall.
const TILE_PLACEMENT = ['row-span-2', 'md:col-span-2', '', '', '', 'md:col-span-2', ''];

/** The songs with the most plays this week; hidden when none was played. */
export function RisingSection({ tags }: { tags?: number[] }) {
  const features = useFeatureFlags();
  const { data: ids = [] } = trpc.image.getRisingSongs.useQuery(undefined, {
    enabled: !!features.music,
  });
  const { songs } = useSongsInOrder({ ids, tags, max: RISING_TILES, enabled: !!features.music });
  if (!songs.length) return null;
  return (
    <SongSection title={RISING_LIST_NAME} songs={songs}>
      <div className="grid auto-rows-[84px] grid-cols-2 gap-2 md:grid-cols-[440fr_210fr_150fr_210fr_270fr] md:grid-rows-[210px_210px] md:gap-5">
        {songs.map((song, index) => (
          <RisingTile
            key={song.id}
            song={song}
            large={index === 0}
            className={TILE_PLACEMENT[index]}
          />
        ))}
      </div>
    </SongSection>
  );
}

function RisingTile({
  song,
  large,
  className,
}: {
  song: ImagesInfiniteModel;
  large: boolean;
  className?: string;
}) {
  const track = songTrack(song);
  const title = track.title || UNTITLED_SONG;
  const cover = useFeedSongCover(song.id);
  const playing = useMusicPlayerStore((s) => s.current?.id === song.id && s.playing);
  return (
    <div
      className={clsx(
        'group relative min-w-0 overflow-hidden rounded-[14px] md:rounded-2xl',
        large && 'md:rounded-[20px]',
        className
      )}
    >
      <RoutedDialogLink
        name="imageDetail"
        state={{ imageId: song.id }}
        className="absolute inset-0"
        aria-label={`Open ${title}`}
      >
        <SongArt
          url={cover?.url}
          width={large ? 440 : 380}
          iconSize={large ? 64 : 32}
          className="size-full"
        />
      </RoutedDialogLink>
      <div
        className={clsx(
          'pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-b from-transparent to-black/75',
          large ? 'h-1/2' : 'h-[46%]'
        )}
      />
      <div
        className={clsx(
          'pointer-events-none absolute flex min-w-0 flex-col',
          large
            ? 'inset-x-2.5 bottom-2.5 md:inset-x-6 md:bottom-7 md:gap-2'
            : 'inset-x-2.5 bottom-2.5 gap-0.5 md:inset-x-3.5 md:bottom-[21px]'
        )}
      >
        <span
          className={clsx(
            'truncate font-bold text-white',
            large ? 'text-[17px] leading-5 md:text-4xl md:leading-[43px]' : 'text-[17px] leading-5'
          )}
        >
          {title}
        </span>
        {song.user.username && (
          <NextLink
            href={songCreatorHref(song.user.username)}
            className={clsx(
              'pointer-events-auto truncate text-white/85 hover:underline',
              large ? 'text-xs md:text-sm' : 'text-xs'
            )}
          >
            {song.user.username}
          </NextLink>
        )}
      </div>
      <FeedSongPlayButton
        song={song}
        title={title}
        size={56}
        iconSize={22}
        variant="disc"
        className={clsx(
          'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 hover:scale-105 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
          playing ? 'opacity-100' : 'opacity-0'
        )}
      />
    </div>
  );
}
