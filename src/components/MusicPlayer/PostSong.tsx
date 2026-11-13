import {
  IconPlayerPauseFilled,
  IconPlayerPlay,
  IconPlayerPlayFilled,
  IconPlayerTrackNext,
  IconPlaylistAdd,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { Menu } from '~/components/MantineOverlays';
import { dimmed, SongArt } from '~/components/MusicPlayer/MusicPlayerParts';
import { useMusicPlayerCovers } from '~/components/MusicPlayer/useMusicPlayerCover';
import type { MusicTrack } from '~/store/music-player.store';
import { useMusicPlayerStore } from '~/store/music-player.store';
import { formatPlaybackTime } from '~/utils/audio-player';
import { trpc } from '~/utils/trpc';

/** The fields of a song's Image row the player needs. */
export type SongImage = {
  id: number;
  url: string;
  metadata?: unknown;
  user: { id: number; username?: string | null };
};

/** Where play was pressed: the other songs of the post become Up next when there are any. */
export type SongList = { postId: number; songs: SongImage[] } | null;

export function songTrack(image: SongImage): MusicTrack {
  const metadata = (image.metadata ?? {}) as { title?: string; duration?: number };
  return {
    id: image.id,
    url: image.url,
    title: metadata.title ?? '',
    durationSec: metadata.duration ?? 0,
    creator: { id: image.user.id, username: image.user.username ?? '' },
  };
}

const store = useMusicPlayerStore.getState;

/** Play now, with the post's songs as the list named after the post. */
function usePlayNow(song: SongImage, list: SongList) {
  // Already loaded by the post page.
  const { data: post } = trpc.post.get.useQuery({ id: list?.postId ?? 0 }, { enabled: !!list });
  return () =>
    store().playTrack(
      songTrack(song),
      list
        ? { list: { name: post?.title || 'this post', tracks: list.songs.map(songTrack) } }
        : undefined
    );
}

/**
 * A song on the post page: its cover, title and length, and a play button (Civitai primary, not the
 * global player's accent) that plays it in the global player.
 */
export function PostSongTile({
  song,
  list,
  coverIds,
}: {
  song: SongImage;
  list: SongList;
  /** Every song id on the page, so the tiles share one cover read. */
  coverIds: number[];
}) {
  const track = songTrack(song);
  const title = track.title || 'Untitled song';
  const isCurrent = useMusicPlayerStore((s) => s.current?.id === song.id);
  const playing = useMusicPlayerStore((s) => s.current?.id === song.id && s.playing);
  const cover = useMusicPlayerCovers(coverIds).get(song.id);
  const playNow = usePlayNow(song, list);

  return (
    <div className="flex items-center gap-4 p-4 pr-14">
      <SongArt url={cover?.url} width={96} iconSize={40} className="size-24 rounded-xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-lg font-bold leading-tight text-black dark:text-white">
          {title}
        </span>
        <span className={clsx('text-sm', dimmed)}>{formatPlaybackTime(track.durationSec)}</span>
      </div>
      <button
        type="button"
        aria-label={`${playing ? 'Pause' : 'Play'} ${title}`}
        onClick={() => (isCurrent ? store().togglePlay() : playNow())}
        className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[var(--mantine-primary-color-filled)] text-[var(--mantine-primary-color-contrast)] transition-transform hover:scale-105"
      >
        {playing ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
      </button>
    </div>
  );
}

/** The song items of a card's ⋯ menu (Pencil `rUDmm`). */
export function SongMenuItems({ song, list }: { song: SongImage; list: SongList }) {
  const item = 'text-[13px]';
  const playNow = usePlayNow(song, list);
  return (
    <>
      <Menu.Item className={item} leftSection={<IconPlayerPlay size={16} />} onClick={playNow}>
        Play now
      </Menu.Item>
      <Menu.Item
        className={item}
        leftSection={<IconPlaylistAdd size={16} />}
        onClick={() => store().addToUpNext(songTrack(song))}
      >
        Add to up next
      </Menu.Item>
      <Menu.Item
        className={item}
        leftSection={<IconPlayerTrackNext size={16} />}
        onClick={() => store().playNext(songTrack(song))}
      >
        Play next
      </Menu.Item>
      <Menu.Divider />
    </>
  );
}
