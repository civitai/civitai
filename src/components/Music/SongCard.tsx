import { IconMessageCircle, IconThumbUp } from '@tabler/icons-react';
import clsx from 'clsx';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { FeedSongMenuItems, FeedSongPlayButton } from '~/components/Music/FeedSongList';
import { dimmed, SongArt, songCreatorHref } from '~/components/MusicPlayer/MusicPlayerParts';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import { useMusicPlayerCovers } from '~/components/MusicPlayer/useMusicPlayerCover';
import { NextLink } from '~/components/NextLink/NextLink';
import { TwCard } from '~/components/TwCard/TwCard';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { readSongGenre } from '~/shared/constants/song-genres';
import { formatPlaybackTime } from '~/utils/audio-player';
import { abbreviateNumber } from '~/utils/number-helpers';

export const UNTITLED_SONG = 'Untitled song';

function SongStat({ icon, count, label }: { icon: React.ReactNode; count: number; label: string }) {
  return (
    <span className="flex items-center gap-1" aria-label={`${count} ${label}`}>
      {icon}
      {abbreviateNumber(count)}
    </span>
  );
}

/** A song in an image feed (Pencil `AECSM`): cover, play, length, title, creator, genre, stats. */
export function SongCard({ data, height }: { data: ImagesInfiniteModel; height: number }) {
  const track = songTrack(data);
  const title = track.title || UNTITLED_SONG;
  const genre = readSongGenre(data.metadata);
  const cover = useMusicPlayerCovers([data.id]).get(data.id);
  return (
    <TwCard className="border" style={{ height }}>
      <div className="relative min-h-0 flex-1">
        <RoutedDialogLink
          name="imageDetail"
          state={{ imageId: data.id }}
          className="absolute inset-0"
          aria-label={`Open ${title}`}
        >
          <SongArt url={cover?.url} width={320} iconSize={48} className="size-full" />
        </RoutedDialogLink>
        <FeedSongPlayButton
          song={data}
          title={title}
          size={40}
          className="absolute bottom-2 left-2 z-[4] shadow-md"
        />
        <span className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-semibold text-white">
          {formatPlaybackTime(track.durationSec)}
        </span>
        <div className="absolute right-2 top-2 z-[4]">
          <ImageContextMenu image={data} leadingMenuItems={<FeedSongMenuItems song={data} />} />
        </div>
      </div>
      <div className="flex flex-col gap-0.5 p-3">
        <RoutedDialogLink
          name="imageDetail"
          state={{ imageId: data.id }}
          className="truncate text-[17px] font-bold leading-snug text-black dark:text-white"
        >
          {title}
        </RoutedDialogLink>
        {data.user.username && (
          <NextLink
            href={songCreatorHref(data.user.username)}
            className={clsx('truncate text-[13px] hover:underline', dimmed)}
          >
            {data.user.username}
          </NextLink>
        )}
        {genre && <span className={clsx('truncate text-xs', dimmed)}>{genre}</span>}
        <div className={clsx('mt-1 flex items-center gap-3 text-xs', dimmed)}>
          <SongStat
            icon={<IconThumbUp size={14} />}
            count={data.stats?.likeCountAllTime ?? 0}
            label="likes"
          />
          <SongStat
            icon={<IconMessageCircle size={14} />}
            count={data.stats?.commentCountAllTime ?? 0}
            label="comments"
          />
        </div>
      </div>
    </TwCard>
  );
}
