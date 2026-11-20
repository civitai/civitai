import {
  IconMusic,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react';

import { useMediaPlayback } from '~/components/Audio/useMediaPlayback';
import type { AudioBlob, VideoBlob } from '~/shared/orchestrator/workflow-data';
import { formatPlaybackTime } from '~/utils/audio-player';

export function GeneratedAudioOutput({
  image,
  isLightbox,
  onClick,
}: {
  image: AudioBlob | VideoBlob;
  isLightbox?: boolean;
  onClick?: () => void;
}) {
  const {
    mediaRef,
    playing,
    muted,
    currentTime,
    duration,
    progress,
    togglePlay,
    toggleMute,
    scrubHandlers,
    mediaEvents,
  } = useMediaPlayback(('duration' in image ? image.duration : 0) ?? 0);

  const hasCover = image.type === 'video';
  const titleParam = image.workflow.metadata?.params?.title;
  const title = typeof titleParam === 'string' && titleParam ? titleParam : undefined;

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
          {...mediaEvents}
        />
      ) : (
        <>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio
            ref={mediaRef as React.Ref<HTMLAudioElement>}
            src={image.url}
            preload="metadata"
            className="hidden"
            {...mediaEvents}
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
          {...scrubHandlers}
          role="slider"
          tabIndex={0}
          aria-label="Audio progress"
          aria-valuemin={0}
          aria-valuemax={Math.max(duration, 0)}
          aria-valuenow={currentTime}
        >
          <div className="h-0.5 w-full overflow-hidden rounded-full bg-white/20 transition-[height] group-hover:h-1">
            <div className="h-full bg-blue-5" style={{ width: `${progress * 100}%` }} />
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
            <div className="text-xs font-medium text-white/70">{formatPlaybackTime(duration)}</div>
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
