import {
  IconHeadphones,
  IconPlayerPauseFilled,
  IconPlayerPlay,
  IconPlayerPlayFilled,
  IconPlayerTrackNext,
  IconPlaylistAdd,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useRef } from 'react';
import { useEdgeUrl } from '~/client-utils/cf-images-utils';
import { useAudioPeaks } from '~/components/Audio/useAudioPeaks';
import { Menu, Tooltip } from '~/components/MantineOverlays';
import { ACCENT_FILL } from '~/components/MusicPlayer/music-accent';
import { seekMusicPlayer } from '~/components/MusicPlayer/MusicPlayerAudio';
import { accentAt, dimmed, SongArt } from '~/components/MusicPlayer/MusicPlayerParts';
import { SONG_WAVEFORM_PEAKS, SongWaveform } from '~/components/MusicPlayer/SongWaveform';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { useSongListPlays } from '~/components/Music/useSongPlays';
import { useMusicPlayerCovers } from '~/components/MusicPlayer/useMusicPlayerCover';
import type { MusicTrack } from '~/store/music-player.store';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import {
  clampPlaybackTime,
  formatPlaybackTime,
  playbackProgress,
  timeFromPointer,
} from '~/utils/audio-player';
import { abbreviateNumber } from '~/utils/number-helpers';

/** The fields of a song's Image row the player needs. */
export type SongImage = {
  id: number;
  url: string;
  metadata?: unknown;
  user: { id: number; username?: string | null };
};

/**
 * The list play was pressed in and its name: the songs after the played one become Up next, then,
 * with `wrap` (a post's few songs), the ones before it.
 */
export type SongList = { name: string; songs: SongImage[]; wrap?: boolean };

/** A post's songs as the list play is pressed in: few and closed, so Up next wraps. */
export function postSongList(postTitle: string | null | undefined, songs: SongImage[]): SongList {
  return { name: postTitle || 'this post', songs, wrap: true };
}

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

/** Play now, from `startAtSec` when given, with the songs after it in `list` as Up next. */
export function playSongFromList(song: SongImage, list: SongList, startAtSec?: number) {
  const index = list.songs.findIndex((s) => s.id === song.id);
  if (index < 0) return store().playTrack(songTrack(song));
  const songs = list.wrap
    ? [...list.songs.slice(index), ...list.songs.slice(0, index)]
    : list.songs;
  store().playFromList({
    name: list.name,
    tracks: songs.map(songTrack),
    index: list.wrap ? 0 : index,
    startAtSec,
  });
}

const SEEK_STEP_SECONDS = 5;

/**
 * A song on the post page (Pencil `WgLlp`): its cover, title and length, a play button (Civitai
 * primary, not the global player's accent) and a waveform of the song that shows and seeks the
 * global player's progress while this song is the one playing.
 */
export function PostSongTile({
  song,
  list,
  songIds,
}: {
  song: SongImage;
  list: SongList;
  /** Every song id on the page: each card asks for the same ids, so they share one read. */
  songIds: number[];
}) {
  const cover = useMusicPlayerCovers(songIds).get(song.id);
  const plays = useSongListPlays(songIds)[song.id];
  return <PostSongCard song={song} list={list} coverUrl={cover?.url} plays={plays} />;
}

export function PostSongCard({
  song,
  list,
  coverUrl,
  plays,
}: {
  song: SongImage;
  list: SongList;
  coverUrl?: string;
  /** Undefined until known. */
  plays?: number;
}) {
  const track = songTrack(song);
  const title = track.title || 'Untitled song';
  const isCurrent = useMusicPlayerStore((s) => s.current?.id === song.id);
  const playing = useMusicPlayerStore((s) => s.current?.id === song.id && s.playing);
  const togglePlay = () => (isCurrent ? store().togglePlay() : playSongFromList(song, list));
  return (
    // Under `sm` the play button sits below the card's ⋯ button and the waveform takes the full
    // width under the cover; from `sm` the header's right padding clears the ⋯ button.
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 p-3 sm:grid-cols-[152px_minmax(0,1fr)] sm:gap-x-5 sm:p-4">
      {/* 96px, not 88: the guard's rating toggle ("PG | MINOR") must fit on it. */}
      <RoutedDialogLink
        name="imageDetail"
        state={{ imageId: song.id }}
        aria-label={`Open ${title}`}
        className="size-24 sm:row-span-2 sm:size-[152px]"
      >
        <SongArt url={coverUrl} width={152} iconSize={48} className="size-full rounded-lg" />
      </RoutedDialogLink>
      <div className="flex min-w-0 items-start gap-3 sm:pr-10">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* No equalizer: the pause button and the filling waveform already say it is playing. */}
          <RoutedDialogLink
            name="imageDetail"
            state={{ imageId: song.id }}
            className="truncate text-lg font-bold leading-tight text-black hover:underline sm:text-2xl dark:text-white"
          >
            {title}
          </RoutedDialogLink>
          <span className={clsx('flex items-center gap-3 text-xs tabular-nums sm:text-sm', dimmed)}>
            {formatPlaybackTime(track.durationSec)}
            {plays !== undefined && (
              <span className="flex items-center gap-1" aria-label={`${plays} plays`}>
                <IconHeadphones size={14} aria-hidden />
                {abbreviateNumber(plays)}
              </span>
            )}
          </span>
        </div>
        <Tooltip label={playing ? 'Pause' : 'Play'}>
          <button
            type="button"
            aria-label={`${playing ? 'Pause' : 'Play'} ${title}`}
            onClick={togglePlay}
            className="mt-9 flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--mantine-primary-color-filled)] text-[var(--mantine-primary-color-contrast)] transition-transform hover:scale-105 sm:mt-0 sm:size-14"
          >
            {playing ? <IconPlayerPauseFilled size={22} /> : <IconPlayerPlayFilled size={22} />}
          </button>
        </Tooltip>
      </div>
      <PostSongWaveform
        song={song}
        list={list}
        title={title}
        isCurrent={isCurrent}
        playing={playing}
        durationSec={track.durationSec}
        className="col-span-2 self-end sm:col-span-1 sm:col-start-2"
      />
    </div>
  );
}

/**
 * The song's waveform with its played part, and the time played of its length. Decoded once it nears
 * the viewport; until then, or when decoding fails, a plain progress bar stands in. Seeking a song
 * that is not playing starts it from there.
 */
function PostSongWaveform({
  song,
  list,
  title,
  isCurrent,
  playing,
  durationSec,
  className,
}: {
  song: SongImage;
  list: SongList;
  title: string;
  isCurrent: boolean;
  playing: boolean;
  durationSec: number;
  className?: string;
}) {
  const sliderRef = useRef<HTMLDivElement>(null);
  const { url } = useEdgeUrl(song.url, { type: 'audio' });
  const peaks = useAudioPeaks(url, SONG_WAVEFORM_PEAKS, sliderRef);
  const currentTime = useMusicPlayheadStore((s) => (isCurrent ? s.currentTime : 0));
  const progress = playbackProgress(currentTime, durationSec);

  const seekTo = (time: number) => {
    const next = clampPlaybackTime(time, durationSec);
    if (isCurrent) seekMusicPlayer(next);
    else playSongFromList(song, list, next);
  };

  return (
    <div className={clsx('flex min-w-0 flex-col gap-1', className)}>
      <div
        ref={sliderRef}
        role="slider"
        tabIndex={0}
        aria-label={`${title} progress`}
        aria-valuemin={0}
        aria-valuemax={Math.round(durationSec)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={`${formatPlaybackTime(currentTime)} of ${formatPlaybackTime(durationSec)}`}
        className="group flex h-9 cursor-pointer items-center sm:h-11"
        onClick={(e) =>
          seekTo(timeFromPointer(e.clientX, e.currentTarget.getBoundingClientRect(), durationSec))
        }
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') seekTo(currentTime + SEEK_STEP_SECONDS);
          else if (e.key === 'ArrowLeft') seekTo(currentTime - SEEK_STEP_SECONDS);
          else return;
          e.preventDefault();
        }}
      >
        <SongWaveform
          peaks={peaks}
          progress={progress}
          played={playing ? ACCENT_FILL : accentAt(50)}
        />
      </div>
      <div className={clsx('flex justify-between text-xs font-medium tabular-nums', dimmed)}>
        <span className={clsx(isCurrent && 'text-black dark:text-white')}>
          {formatPlaybackTime(currentTime)}
        </span>
        <span>{formatPlaybackTime(durationSec)}</span>
      </div>
    </div>
  );
}

/** The song items of a card's ⋯ menu (Pencil `rUDmm`). */
export function SongMenuItems({ song, list }: { song: SongImage; list: SongList }) {
  return (
    <>
      <Menu.Item
        leftSection={<IconPlayerPlay size={16} />}
        onClick={() => playSongFromList(song, list)}
      >
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
