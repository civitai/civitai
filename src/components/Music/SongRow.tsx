import clsx from 'clsx';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import {
  FeedSongMenuItems,
  FeedSongPlayButton,
  useFeedSongCover,
} from '~/components/Music/FeedSongList';
import { UNTITLED_SONG } from '~/components/Music/SongCard';
import {
  dimmed,
  Equalizer,
  SongArt,
  songCreatorHref,
} from '~/components/MusicPlayer/MusicPlayerParts';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import { NextLink } from '~/components/NextLink/NextLink';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { readSongGenre } from '~/shared/constants/song-genres';
import { useMusicPlayerStore } from '~/store/music-player.store';
import { formatPlaybackTime } from '~/utils/audio-player';

/** A song in the list view of a feed (Pencil `VQ3N0`); `index` is its 0-based place in the list. */
export function SongRow({ data, index }: { data: ImagesInfiniteModel; index: number }) {
  const track = songTrack(data);
  const title = track.title || UNTITLED_SONG;
  const genre = readSongGenre(data.metadata);
  const cover = useFeedSongCover(data.id);
  const isCurrent = useMusicPlayerStore((s) => s.current?.id === data.id);
  const playing = useMusicPlayerStore((s) => s.current?.id === data.id && s.playing);
  return (
    <div className="group flex items-center gap-3 rounded-md p-2 hover:bg-gray-1 dark:hover:bg-dark-6">
      <span className={clsx('flex w-6 shrink-0 justify-center text-sm tabular-nums', dimmed)}>
        {isCurrent ? <Equalizer playing={playing} /> : index + 1}
      </span>
      <div className="relative shrink-0">
        <SongArt url={cover?.url} width={48} iconSize={20} className="size-12 rounded-md" />
        <FeedSongPlayButton
          song={data}
          title={title}
          size={32}
          className="absolute inset-2 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <RoutedDialogLink
          name="imageDetail"
          state={{ imageId: data.id }}
          className="truncate text-sm font-semibold text-black dark:text-white"
        >
          {title}
        </RoutedDialogLink>
        <span className={clsx('truncate text-xs', dimmed)}>
          {data.user.username && (
            <NextLink href={songCreatorHref(data.user.username)} className="hover:underline">
              {data.user.username}
            </NextLink>
          )}
          {genre && ` · ${genre}`}
        </span>
      </div>
      <span className={clsx('shrink-0 text-xs tabular-nums', dimmed)}>
        {formatPlaybackTime(track.durationSec)}
      </span>
      <ImageContextMenu image={data} leadingMenuItems={<FeedSongMenuItems song={data} />} />
    </div>
  );
}
