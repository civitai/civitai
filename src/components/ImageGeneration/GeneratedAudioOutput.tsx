import {
  IconMusic,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react';
import { useRef, useState } from 'react';

import type { AudioBlob, VideoBlob } from '~/shared/orchestrator/workflow-data';

function formatTime(seconds: number) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function GeneratedAudioOutput({
  image,
  isLightbox,
  onClick,
}: {
  image: AudioBlob | VideoBlob;
  isLightbox?: boolean;
  onClick?: () => void;
}) {
  const mediaRef = useRef<HTMLMediaElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(('duration' in image ? image.duration : 0) ?? 0);

  const hasCover = image.type === 'video';
  const titleParam = image.workflow.metadata?.params?.title;
  const title = typeof titleParam === 'string' && titleParam ? titleParam : undefined;
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const togglePlay = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) media.play().catch(() => undefined);
    else media.pause();
  };

  const toggleMute = () => {
    const media = mediaRef.current;
    if (!media) return;
    media.muted = !media.muted;
    setMuted(media.muted);
  };

  const seekFromPointer = (clientX: number, rect: DOMRect) => {
    const media = mediaRef.current;
    if (!media || duration <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const newTime = ratio * duration;
    media.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handleScrubStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromPointer(e.clientX, e.currentTarget.getBoundingClientRect());
  };

  const handleScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    seekFromPointer(e.clientX, e.currentTarget.getBoundingClientRect());
  };

  const mediaEventHandlers = {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) =>
      setCurrentTime(e.currentTarget.currentTime),
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      if (!isNaN(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
    },
  };

  return (
    <div
      className={`relative size-full overflow-hidden${
        !isLightbox && onClick ? ' cursor-pointer' : ''
      }`}
      onClick={!isLightbox ? onClick : undefined}
      style={
        hasCover
          ? { background: '#1a1b1e' }
          : { background: 'linear-gradient(135deg, #7950f2 0%, #f06595 40%, #ff922b 100%)' }
      }
    >
      {hasCover ? (
        <video
          ref={mediaRef as React.Ref<HTMLVideoElement>}
          src={image.url}
          preload="metadata"
          playsInline
          className="pointer-events-none absolute inset-0 size-full object-cover"
          {...mediaEventHandlers}
        />
      ) : (
        <>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio
            ref={mediaRef as React.Ref<HTMLAudioElement>}
            src={image.url}
            preload="metadata"
            className="hidden"
            {...mediaEventHandlers}
          />
          <IconMusic
            size={180}
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/[0.08]"
          />
        </>
      )}

      <div
        className="absolute inset-x-0 bottom-0 flex cursor-default flex-col gap-2 px-3 pb-3 pt-12"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0.85))',
        }}
      >
        <div
          className="group -my-2 cursor-pointer touch-none py-2"
          onPointerDown={handleScrubStart}
          onPointerMove={handleScrubMove}
          role="slider"
          tabIndex={0}
          aria-label="Audio progress"
          aria-valuemin={0}
          aria-valuemax={Math.max(duration, 0)}
          aria-valuenow={currentTime}
        >
          <div className="h-0.5 w-full overflow-hidden rounded-full bg-white/20 transition-[height] group-hover:h-1">
            <div className="h-full bg-blue-5" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? 'Pause' : 'Play'}
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-white/95 text-dark-7 transition-transform hover:scale-105 hover:bg-white"
          >
            {playing ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
          </button>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {title && (
              <div className="truncate text-sm font-bold text-white" title={title}>
                {title}
              </div>
            )}
            <div className="text-xs font-medium text-white/70">{formatTime(duration)}</div>
          </div>

          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? 'Unmute' : 'Mute'}
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/[0.12] text-white transition-colors hover:bg-white/20"
          >
            {muted ? <IconVolumeOff size={14} /> : <IconVolume size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
