import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { EdgeAudio } from '~/components/EdgeMedia/EdgeAudio';
import { formatPlaybackTime } from '~/utils/audio-player';

const SEEK_STEP_SECONDS = 5;

/** Play/pause, a seekable progress bar and the length of a stored song. */
export function SongPreviewPlayer({
  src,
  duration: storedDuration,
}: {
  src: string;
  duration?: number;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(storedDuration ?? 0);
  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => undefined);
    else audio.pause();
  };

  const seekTo = (time: number) => {
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;
    const next = Math.max(0, Math.min(duration, time));
    audio.currentTime = next;
    setCurrentTime(next);
  };

  const seekFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seekTo(((e.clientX - rect.left) / rect.width) * duration);
  };

  return (
    <div className="flex w-full items-center gap-2.5 rounded-lg bg-black/5 px-2.5 py-2 dark:bg-black/35">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <EdgeAudio
        ref={audioRef}
        src={src}
        controls={false}
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          if (isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
        }}
      />
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#E64980] text-white transition-transform hover:scale-105"
      >
        {playing ? <IconPlayerPauseFilled size={14} /> : <IconPlayerPlayFilled size={14} />}
      </button>
      <div
        className="group flex h-7 min-w-0 flex-1 cursor-pointer touch-none items-center"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seekFromPointer(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') seekTo(currentTime + SEEK_STEP_SECONDS);
          else if (e.key === 'ArrowLeft') seekTo(currentTime - SEEK_STEP_SECONDS);
          else return;
          e.preventDefault();
        }}
        role="slider"
        tabIndex={0}
        aria-label="Song progress"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={`${formatPlaybackTime(currentTime)} of ${formatPlaybackTime(duration)}`}
      >
        <div className="h-1 w-full overflow-hidden rounded-full bg-black/15 transition-[height] group-hover:h-1.5 dark:bg-white/35">
          <div className="h-full bg-[#E64980]" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <span className="shrink-0 text-xs text-gray-6 dark:text-dark-2">
        {formatPlaybackTime(duration)}
      </span>
    </div>
  );
}
