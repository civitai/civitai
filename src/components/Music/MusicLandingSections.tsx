import { Title } from '@mantine/core';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import {
  FeedSongPlayButton,
  FeedSongsProvider,
  SongListNameProvider,
  useFeedSongCover,
} from '~/components/Music/FeedSongList';
import { SongCard, UNTITLED_SONG } from '~/components/Music/SongCard';
import { useSongList } from '~/components/Music/useSongList';
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
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { useMusicPlayerStore } from '~/store/music-player.store';
import { trpc } from '~/utils/trpc';

// Pencil `CnGl0`: one large tile and six.
const RISING_TILES = 7;
// Enough ranked ids to fill the tiles after the feed drops the ones the viewer may not see; with a
// genre picked every id is read, since the genre filters after.
const RISING_READ_WITHOUT_GENRE = 25;
const RECENT_CARD_HEIGHT =
  Math.round(MUSIC_FEED_COLUMN_WIDTH * SONG_COVER_RATIO) + SONG_CARD_TEXT_HEIGHT;

/** `ids` read through the image feed, which drops songs the viewer may not see; the rest keep the order of `ids`, at most `max`. */
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
  const browsingLevel = useBrowsingLevelDebounced();
  const { songs: images, isLoading } = useSongList(
    {
      ids,
      tags,
      period: MetricTimeframe.AllTime,
      sort: ImageSort.Newest,
      limit: ids.length,
      withMeta: false,
      browsingLevel,
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

/** The viewer's last songs started in this browser, newest first. */
export function RecentlyPlayedSection() {
  const features = useFeatureFlags();
  const live = useMusicPlayerStore((s) => s.recentlyPlayed);
  // The order as the section first had it: a song played from here moves to the front of the
  // live list, which would reorder the row under the pointer. New plays show on the next visit.
  const [ids, setIds] = useState(live);
  if (!ids.length && live.length) setIds(live);
  const { songs } = useSongsInOrder({ ids, max: ids.length, enabled: !!features.music });
  if (!songs.length) return null;
  return (
    <SongSection title="Recently played" songs={songs}>
      {/* Pencil `sOs9H` */}
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

// Pencil `CnGl0` (1440): the large tile spans both rows. With fewer than six small tiles the
// columns and spans change so no cell is left empty.
const RISING_DESKTOP_COLUMNS: Record<number, string> = {
  0: '1fr',
  1: '440fr 900fr',
  2: '440fr 900fr',
  3: '440fr 450fr 450fr',
  4: '440fr 450fr 450fr',
  5: '440fr 210fr 150fr 210fr 270fr',
  6: '440fr 210fr 150fr 210fr 270fr',
};
// By small-tile count, the wide (two-column) small tiles at desktop width.
const RISING_DESKTOP_WIDE: Record<number, number[]> = { 3: [2], 5: [0, 3, 4], 6: [0, 4] };
// Pencil `P5rvz` (390): the large tile, two square small tiles and a wide one under them.
const RISING_PHONE_TILES = 4;

/**
 * Each tile's grid placement (phone, then `md:`) for `count` songs, filling every cell. Phone: four
 * square columns, the large tile on two of them; past the fourth, tiles show from `md` only.
 */
export function risingTilePlacement(count: number): string[] {
  const small = count - 1;
  const phoneSmall = Math.min(small, RISING_PHONE_TILES - 1);
  return Array.from({ length: count }, (_, index) => {
    if (index === 0)
      return small === 0
        ? 'row-span-2 w-[calc(50cqw-4px)] md:w-[440px]'
        : 'col-span-2 row-span-2 md:col-span-1';
    const i = index - 1;
    const desktopWide = RISING_DESKTOP_WIDE[small]?.includes(i) ?? false;
    // One small tile takes the right half; two stack as wide tiles; three put the wide one last.
    const phoneWide = phoneSmall < 3 || i === 2;
    return clsx(
      i >= phoneSmall && 'max-md:hidden',
      small === 1 && 'row-span-2',
      phoneWide && 'col-span-2',
      desktopWide && 'md:col-span-2',
      phoneWide && !desktopWide && 'md:col-span-1'
    );
  });
}

/** The songs with the most plays this week. */
export function RisingSection({ tags }: { tags?: number[] }) {
  const features = useFeatureFlags();
  const { data: rising = [] } = trpc.image.getRisingSongs.useQuery(undefined, {
    enabled: !!features.music,
  });
  const ids = useMemo(
    () => (tags?.length ? rising : rising.slice(0, RISING_READ_WITHOUT_GENRE)),
    [rising, tags?.length]
  );
  const { songs } = useSongsInOrder({ ids, tags, max: RISING_TILES, enabled: !!features.music });
  const placement = risingTilePlacement(songs.length);
  if (!songs.length) return null;
  const lone = songs.length === 1;
  return (
    <SongSection title="Rising this week" songs={songs}>
      {/* The phone rows are as tall as a column is wide (`cqw` reads this wrapper's width). */}
      <div className="[container-type:inline-size]">
        <div
          className={clsx(
            'grid auto-rows-[calc(25cqw-6px)] gap-2 md:grid-rows-[210px_210px] md:gap-5 md:[grid-template-columns:var(--rising-columns)]',
            lone ? 'w-fit grid-cols-1' : 'grid-cols-4'
          )}
          style={{ '--rising-columns': RISING_DESKTOP_COLUMNS[songs.length - 1] } as CSSProperties}
        >
          {songs.map((song, index) => (
            <RisingTile
              key={song.id}
              song={song}
              large={index === 0}
              className={placement[index]}
            />
          ))}
        </div>
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
          gradient
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
          // Pencil `P5rvz`: small phone tiles are cover only.
          !large && 'max-md:hidden',
          large
            ? 'inset-x-2.5 bottom-2.5 md:inset-x-6 md:bottom-7 md:gap-2'
            : 'inset-x-2.5 bottom-2.5 gap-0.5 md:inset-x-3.5 md:bottom-[21px]'
        )}
      >
        <span
          className={clsx(
            'truncate font-bold text-white',
            large
              ? 'text-[15px] leading-[18px] md:text-4xl md:leading-[43px]'
              : 'text-[17px] leading-5'
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
          'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 hover:scale-105 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
          // Always shown on touch, so smaller on a phone's small tiles (inline size: `!`).
          !large && 'max-md:!size-10 max-md:[&_svg]:size-4',
          playing ? 'opacity-100' : 'opacity-0'
        )}
      />
    </div>
  );
}
