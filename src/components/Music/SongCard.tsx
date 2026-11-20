import { IconHeadphones, IconMessage, IconThumbUp } from '@tabler/icons-react';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import {
  FeedSongMenuItems,
  FeedSongPlayButton,
  useFeedSongCover,
  useFeedSongPlays,
} from '~/components/Music/FeedSongList';
import { songTextBright, songTextDimmed } from '~/components/Music/song-styles';
import { SongArt, songCreatorHref } from '~/components/MusicPlayer/MusicPlayerParts';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import { NextLink } from '~/components/NextLink/NextLink';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { readSongGenre } from '~/shared/constants/song-genres';
import { formatPlaybackTime } from '~/utils/audio-player';
import { abbreviateNumber } from '~/utils/number-helpers';
import clsx from 'clsx';

export const UNTITLED_SONG = 'Untitled song';

export function SongStat({
  icon,
  count,
  label,
}: {
  icon: React.ReactNode;
  count: number;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1" aria-label={`${count} ${label}`}>
      {icon}
      {abbreviateNumber(count)}
    </span>
  );
}

export function SongCard({ data, height }: { data: ImagesInfiniteModel; height: number }) {
  const track = songTrack(data);
  const title = track.title || UNTITLED_SONG;
  const genre = readSongGenre(data.metadata);
  const cover = useFeedSongCover(data.id);
  const plays = useFeedSongPlays(data.id);
  return (
    <div className="flex flex-col gap-2" style={{ height }}>
      <div className="relative min-h-0 w-full flex-1 overflow-hidden rounded-[14px]">
        <RoutedDialogLink
          name="imageDetail"
          state={{ imageId: data.id }}
          className="absolute inset-0"
          aria-label={`Open ${title}`}
        >
          <SongArt url={cover?.url} width={320} iconSize={48} className="size-full" />
        </RoutedDialogLink>
        <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-center justify-between">
          <FeedSongPlayButton
            song={data}
            title={title}
            size={40}
            iconSize={18}
            variant="disc"
            className="pointer-events-auto"
          />
          <span className="rounded-[10px] bg-black/60 px-2 py-[3px] text-[11px] font-semibold leading-[13px] text-white">
            {formatPlaybackTime(track.durationSec)}
          </span>
        </div>
        {/* Inset as the duration badge is, so the two share a right edge. */}
        <div className="absolute right-3 top-3 z-[4]">
          <ImageContextMenu
            image={data}
            leadingMenuItems={<FeedSongMenuItems song={data} />}
            size={26}
            // A dark round under the white ⋯, so it reads on a light cover too; the shared trigger's
            // 26px icon would fill it, so the ⋯ is the 16px of the design's other menus.
            className="rounded-full bg-black/60 hover:bg-black/70 [&_svg]:size-4"
          />
        </div>
      </div>
      <RoutedDialogLink
        name="imageDetail"
        state={{ imageId: data.id }}
        className={clsx('shrink-0 truncate text-[17px] font-bold leading-5', songTextBright)}
      >
        {title}
      </RoutedDialogLink>
      <span className="min-h-4 shrink-0 truncate text-[13px] leading-4">
        {data.user.username && (
          <NextLink
            href={songCreatorHref(data.user.username)}
            className={clsx('hover:underline', songTextDimmed)}
          >
            {data.user.username}
          </NextLink>
        )}
      </span>
      <span
        className={clsx(
          'min-h-[15px] shrink-0 truncate text-xs italic leading-[15px]',
          songTextDimmed
        )}
      >
        {genre ?? ''}
      </span>
      <div
        className={clsx(
          'flex shrink-0 items-center gap-2.5 text-xs leading-[15px]',
          songTextDimmed
        )}
      >
        {plays !== undefined && (
          <SongStat icon={<IconHeadphones size={12} />} count={plays} label="plays" />
        )}
        <SongStat
          icon={<IconThumbUp size={12} />}
          count={data.stats?.likeCountAllTime ?? 0}
          label="likes"
        />
        <SongStat
          icon={<IconMessage size={12} />}
          count={data.stats?.commentCountAllTime ?? 0}
          label="comments"
        />
      </div>
    </div>
  );
}
