import clsx from 'clsx';
import { useEffect, useMemo, useRef } from 'react';
import {
  currentLyricIndex,
  isSyncedLyrics,
  toLyricRows,
} from '~/components/Music/SongDetail/song-lyrics';
import { seekMusicPlayer } from '~/components/MusicPlayer/MusicPlayerAudio';
import { ACCENT } from '~/components/MusicPlayer/MusicPlayerParts';
import type { LyricLine } from '~/server/schema/media.schema';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import { formatPlaybackTime } from '~/utils/audio-player';

const store = useMusicPlayerStore.getState;

// Pencil `bgZ7u`: synced lines at 40px, plain lyrics at 31px; 20px on a phone (`dVjl0`).
const syncedLine = 'text-xl font-semibold leading-[1.15] @md:text-[40px]';
const plainLine = 'text-xl font-semibold leading-[1.15] text-white/85 @md:text-[31px]';

/** The nearest scroll container that actually scrolls: the lyrics column, or on a phone the stage. */
function scrollParentOf(element: HTMLElement) {
  let node = element.parentElement?.closest<HTMLElement>('[data-lyrics-scroll]');
  while (node && node.scrollHeight <= node.clientHeight)
    node = node.parentElement?.closest<HTMLElement>('[data-lyrics-scroll]');
  return node ?? null;
}

/**
 * A song's lyrics on its detail view (Pencil `bgZ7u`, variant b for plain lyrics). Timed lines
 * follow the global player while this song is the current one, and a click on one seeks there,
 * starting the song with `play` first when another one is current. Without any times the lyrics
 * are plain text: no highlight and nothing to click.
 */
export function SongLyrics({
  songId,
  lines,
  play,
}: {
  songId: number;
  lines: LyricLine[];
  /** Starts this song in the global player. */
  play: () => void;
}) {
  const rows = useMemo(() => toLyricRows(lines), [lines]);
  const synced = useMemo(() => isSyncedLyrics(lines), [lines]);
  const isCurrent = useMusicPlayerStore((s) => s.current?.id === songId);
  const current = useMusicPlayheadStore((s) =>
    synced && isCurrent ? currentLyricIndex(lines, s.currentTime * 1000) : -1
  );
  const currentRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const line = currentRef.current;
    if (current < 0 || !line) return;
    const parent = scrollParentOf(line);
    if (!parent) return;
    const offset =
      line.getBoundingClientRect().top -
      parent.getBoundingClientRect().top -
      parent.clientHeight / 3;
    parent.scrollTo({ top: parent.scrollTop + offset, behavior: 'smooth' });
  }, [current]);

  const seek = (t: number) => {
    if (!isCurrent) play();
    else if (!store().playing) store().resume();
    seekMusicPlayer(t / 1000);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="song-lyrics">
      {rows.map((row, i) => {
        if (row.kind === 'section')
          return (
            <span
              key={i}
              className={clsx('text-[13px] font-medium text-white/55', synced && '@md:pl-[21px]')}
            >
              {row.label}
            </span>
          );
        if (!synced)
          return (
            <p key={i} className={clsx(plainLine, 'm-0')}>
              {row.text}
            </p>
          );

        const isActive = row.index === current;
        const tone = isActive
          ? 'font-bold text-white'
          : current >= 0 && row.index < current
          ? 'text-white/45 group-hover:text-white/80'
          : 'text-white/70 group-hover:text-white';
        const marker = (
          <span
            aria-hidden
            className={clsx(
              'hidden w-[5px] shrink-0 self-stretch rounded-[3px] @md:block',
              !isActive && 'bg-transparent'
            )}
            style={isActive ? { backgroundColor: ACCENT } : undefined}
          />
        );
        if (row.t == null)
          return (
            <div key={i} className="flex gap-4">
              {marker}
              <p className={clsx(syncedLine, tone, 'm-0 min-w-0 flex-1')}>{row.text}</p>
            </div>
          );
        const t = row.t;
        return (
          <button
            key={i}
            ref={isActive ? currentRef : undefined}
            type="button"
            aria-current={isActive || undefined}
            title={`Play from ${formatPlaybackTime(t / 1000)}`}
            onClick={() => seek(t)}
            className="group flex gap-4 rounded-md text-left [&_span]:transition-colors [&_span]:duration-200"
          >
            {marker}
            <span className={clsx(syncedLine, tone, 'min-w-0 flex-1')}>{row.text}</span>
          </button>
        );
      })}
    </div>
  );
}
