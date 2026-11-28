import { IconHeadphones } from '@tabler/icons-react';
import clsx from 'clsx';
import { memo } from 'react';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { SongContextMenu } from '~/components/Music/SongContextMenu';
import {
  FeedSongMenuItems,
  FeedSongPlayButton,
  useFeedSongCover,
  useFeedSongGenre,
  useFeedSongPlays,
} from '~/components/Music/FeedSongList';
import { SongStat, UNTITLED_SONG } from '~/components/Music/SongCard';
import { songTextBright, songTextDimmed } from '~/components/Music/song-styles';
import { Equalizer, SongArt, songCreatorHref } from '~/components/MusicPlayer/MusicPlayerParts';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import { NextLink } from '~/components/NextLink/NextLink';
import { useTrackImpression } from '~/components/TrackView/useTrackImpression';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { useMusicPlayerStore } from '~/store/music-player.store';
import { formatPlaybackTime } from '~/utils/audio-player';

// Pencil `VQ3N0`.
export const SONG_ROW_HEIGHT = 64;

export const SongRow = memo(function SongRow({
  data,
  index,
}: {
  data: ImagesInfiniteModel;
  index: number;
}) {
  const track = songTrack(data);
  const title = track.title || UNTITLED_SONG;
  const genre = useFeedSongGenre(data);
  const cover = useFeedSongCover(data.id);
  const plays = useFeedSongPlays(data.id);
  const isCurrent = useMusicPlayerStore((s) => s.current?.id === data.id);
  const playing = useMusicPlayerStore((s) => s.current?.id === data.id && s.playing);
  const impressionRef = useTrackImpression([{ entityType: 'Image', entityId: data.id }]);
  return (
    <div
      ref={impressionRef}
      className="group flex h-16 items-center gap-3.5 rounded-lg px-3 py-2 hover:bg-gray-1 dark:hover:bg-dark-5"
    >
      <span
        className={clsx(
          'flex w-5 shrink-0 justify-center text-base font-bold tabular-nums',
          songTextDimmed
        )}
      >
        {isCurrent ? <Equalizer playing={playing} /> : index + 1}
      </span>
      <div className="relative size-12 shrink-0">
        <SongArt url={cover?.url} width={48} iconSize={20} className="size-12 rounded" />
        <FeedSongPlayButton
          song={data}
          title={title}
          size={48}
          iconSize={18}
          variant="bare"
          className="absolute inset-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <RoutedDialogLink
          name="imageDetail"
          state={{ imageId: data.id }}
          className={clsx('truncate text-sm font-semibold', songTextBright)}
        >
          {title}
        </RoutedDialogLink>
        <span className={clsx('truncate text-xs', songTextDimmed)}>
          {data.user.username && (
            <NextLink href={songCreatorHref(data.user.username)} className="hover:underline">
              {data.user.username}
            </NextLink>
          )}
          {genre && ` · ${genre}`}
        </span>
      </div>
      {/* The row's own gap between plays and duration. */}
      <span
        className={clsx('flex shrink-0 items-center gap-3.5 text-xs tabular-nums', songTextDimmed)}
      >
        {plays !== undefined && (
          <SongStat icon={<IconHeadphones size={14} />} count={plays} label="plays" />
        )}
        {formatPlaybackTime(track.durationSec)}
      </span>
      <SongContextMenu image={data} leadingMenuItems={<FeedSongMenuItems song={data} />} />
    </div>
  );
});
