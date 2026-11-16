import {
  IconPlayerPauseFilled,
  IconPlayerPlay,
  IconPlayerPlayFilled,
  IconPlayerTrackNext,
  IconPlaylistAdd,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { Menu, Tooltip } from '~/components/MantineOverlays';
import { dimmed, SongArt } from '~/components/MusicPlayer/MusicPlayerParts';
import { useMusicPlayerCovers } from '~/components/MusicPlayer/useMusicPlayerCover';
import type { MusicTrack } from '~/store/music-player.store';
import { useMusicPlayerStore } from '~/store/music-player.store';
import { formatPlaybackTime } from '~/utils/audio-player';

/** The fields of a song's Image row the player needs. */
export type SongImage = {
  id: number;
  url: string;
  metadata?: unknown;
  user: { id: number; username?: string | null };
};

/** The list play was pressed in and its name: the songs after the played one become Up next. */
export type SongList = { name: string; songs: SongImage[] };

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

/**
 * Starts `song`, from `startAtSec` when given, with the creator's other songs as Up next. Up next
 * reads "Next from <name>", so the list is named by the creator alone.
 */
export function playSongWithCreatorList(song: SongImage, moreFrom: SongList, startAtSec?: number) {
  store().playFromList({
    name: song.user.username || moreFrom.name,
    tracks: [song, ...moreFrom.songs].map(songTrack),
    index: 0,
    startAtSec,
  });
}

/** Play now, with the songs after it in `list` as Up next. */
function playNow(song: SongImage, list: SongList) {
  const index = list.songs.findIndex((s) => s.id === song.id);
  if (index < 0) return store().playTrack(songTrack(song));
  store().playFromList({ name: list.name, tracks: list.songs.map(songTrack), index });
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
  return (
    // Right padding clears the card's ⋯ button; under `sm` the cover shrinks so the title has room.
    <div className="flex items-center gap-3 p-4 pr-11 sm:gap-4 sm:pr-14">
      <SongArt
        url={cover?.url}
        width={96}
        iconSize={32}
        className="size-16 rounded-xl sm:size-24"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-lg font-bold leading-tight text-black dark:text-white">
          {title}
        </span>
        <span className={clsx('text-sm', dimmed)}>{formatPlaybackTime(track.durationSec)}</span>
      </div>
      <Tooltip label={playing ? 'Pause' : 'Play'}>
        <button
          type="button"
          aria-label={`${playing ? 'Pause' : 'Play'} ${title}`}
          onClick={() => (isCurrent ? store().togglePlay() : playNow(song, list))}
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[var(--mantine-primary-color-filled)] text-[var(--mantine-primary-color-contrast)] transition-transform hover:scale-105"
        >
          {playing ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
        </button>
      </Tooltip>
    </div>
  );
}

/** The song items of a card's ⋯ menu (Pencil `rUDmm`). */
export function SongMenuItems({ song, list }: { song: SongImage; list: SongList }) {
  return (
    <>
      <Menu.Item leftSection={<IconPlayerPlay size={16} />} onClick={() => playNow(song, list)}>
        Play now
      </Menu.Item>
      <Menu.Item
        leftSection={<IconPlaylistAdd size={16} />}
        onClick={() => store().addToUpNext(songTrack(song))}
      >
        Add to up next
      </Menu.Item>
      <Menu.Item
        leftSection={<IconPlayerTrackNext size={16} />}
        onClick={() => store().playNext(songTrack(song))}
      >
        Play next
      </Menu.Item>
      <Menu.Divider />
    </>
  );
}
