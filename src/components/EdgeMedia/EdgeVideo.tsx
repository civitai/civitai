import { HoverCard, ThemeIcon } from '@mantine/core';
import {
  IconMaximize,
  IconMinimize,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react';
import type { MouseEventHandler } from 'react';
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { YoutubeEmbed } from '~/components/YoutubeEmbed/YoutubeEmbed';
import { VimeoEmbed } from '../VimeoEmbed/VimeoEmbed';
import { useLocalStorage, useTimeout } from '@mantine/hooks';
import type { EdgeUrlProps } from '~/client-utils/cf-images-utils';
import { useEdgeUrl } from '~/client-utils/cf-images-utils';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import clsx from 'clsx';
import styles from './EdgeVideo.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useDialogStore } from '~/components/Dialog/dialogStore';

type VideoProps = Omit<
  React.DetailedHTMLProps<React.VideoHTMLAttributes<HTMLVideoElement>, HTMLVideoElement>,
  'height' | 'width' | 'src'
> & {
  src: string;
  thumbnailUrl?: string | null;
  wrapperProps?: React.ComponentPropsWithoutRef<'div'>;
  contain?: boolean;
  fadeIn?: boolean;
  html5Controls?: boolean;
  onMutedChange?: (muted: boolean) => void;
  youtubeVideoId?: string;
  vimeoVideoId?: string;
  options?: Omit<EdgeUrlProps, 'src'>;
  threshold?: number;
  disableWebm?: boolean;
  disablePoster?: boolean;
  /** Database image ID — included in drag data so drop targets can look up metadata server-side */
  imageId?: number;
};

export type EdgeVideoRef = {
  stop: () => void;
};

type State = {
  muted: boolean;
};

// `fullscreenchange` is a document-level event (no JSX prop for it), so we subscribe via
// useSyncExternalStore instead of useEffect to read fullscreen state reactively.
function subscribeFullscreen(callback: () => void) {
  document.addEventListener('fullscreenchange', callback);
  return () => document.removeEventListener('fullscreenchange', callback);
}
const getFullscreenSnapshot = () => typeof document !== 'undefined' && !!document.fullscreenElement;
const getFullscreenServerSnapshot = () => false;

export const EdgeVideo = forwardRef<EdgeVideoRef, VideoProps>(
  (
    {
      src,
      options,
      muted: initialMuted = true,
      controls,
      style,
      wrapperProps,
      contain,
      fadeIn,
      html5Controls = false,
      onMutedChange,
      youtubeVideoId,
      vimeoVideoId,
      threshold = 0.25,
      thumbnailUrl,
      disableWebm,
      disablePoster,
      imageId,
      onLoad,
      onError,
      onLoadedData,
      ...props
    },
    forwardedRef
  ) => {
    const ref = useRef<HTMLVideoElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [state, setState] = useState<State>({
      muted: initialMuted,
    });
    const [loaded, setLoaded] = useState(false);
    const [showPlayIndicator, setShowPlayIndicator] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [autoplayFailed, setAutoplayFailed] = useState(false);
    // hide the audio control for videos with no audio track. Detected reactively from
    // the video's load/play events (hasAudio populates as metadata/decoded bytes become available).
    const [hasAudioState, setHasAudioState] = useState(false);
    const isFullscreen = useSyncExternalStore(
      subscribeFullscreen,
      getFullscreenSnapshot,
      getFullscreenServerSnapshot
    );
    const [volume, setVolume] = useLocalStorage({
      key: 'global-volume',
      defaultValue: state.muted ? 0 : 0.5,
    });

    useEffect(() => {
      const video = ref.current;
      if (!video) return;
      // When prop forces mute, always mute. When prop allows audio, respect user's volume preference.
      const shouldMute = initialMuted || volume === 0;
      video.muted = shouldMute;
      setState((current) => ({ ...current, muted: shouldMute }));
    }, [initialMuted]); // eslint-disable-line react-hooks/exhaustive-deps

    useImperativeHandle(forwardedRef, () => ({
      stop: () => {
        if (ref.current) {
          ref.current.pause();
          ref.current.currentTime = 0;
        }
      },
    }));

    const handleTogglePlayPause = useCallback(() => {
      if (controls && !html5Controls && ref.current) {
        if (ref.current.paused) {
          ref.current.play();
        } else {
          ref.current.pause();
        }

        setShowPlayIndicator(true);
        setTimeout(() => setShowPlayIndicator(false), 500);
      }
    }, [controls, html5Controls]);

    const handleToggleFullscreen = useCallback(() => {
      const container = containerRef.current;
      if (!container) return;

      if (!document.fullscreenElement) {
        container.requestFullscreen().catch((err: Error) => {
          console.error(`Error attempting to enable fullscreen mode: ${err.message}`);
        });
      } else {
        document.exitFullscreen();
      }
    }, []);

    const detectAudio = useCallback(() => {
      const video = ref.current;
      if (!video) return;
      // hasAudio() is monotonic per element (decoded byte count only grows, track list is stable),
      // so re-running it across load/play events lets the control appear once audio is confirmed.
      setHasAudioState(hasAudio(video));
    }, []);

    // Runs from the video's own load events (onLoadedMetadata/onLoadedData/onCanPlay/onPlaying).
    // No effect needed: this component renders the <video>, so React hands us the events as props.
    const markVideoReady = useCallback(() => {
      const video = ref.current;
      if (!video) return;
      setLoaded(true);
      detectAudio();
      // Apply persisted volume on load for non-muted videos (replaces the old render-body write).
      if (!initialMuted) video.volume = volume;
    }, [detectAudio, initialMuted, volume]);

    const handleLoadedData = useCallback(
      (e: React.SyntheticEvent<HTMLVideoElement>) => {
        onLoadedData?.(e);
        e.currentTarget.style.opacity = '1';
        markVideoReady();
      },
      [onLoadedData, markVideoReady]
    );

    const handleToggleMuted = useCallback(() => {
      const video = ref.current;
      if (!video) return;

      const nextMuted = !video.muted;
      video.muted = nextMuted;
      // Muting keeps the persisted level (the slider shows 0 via the muted-aware binding below).
      // Unmuting restores it — bumped off 0 so there's actually something to hear.
      if (!nextMuted) {
        const restored = volume > 0 ? volume : 0.5;
        video.volume = restored;
        setVolume(restored);
      }
      setState((current) => ({ ...current, muted: nextMuted }));
      onMutedChange?.(nextMuted);
    }, [onMutedChange, setVolume, volume]);

    const handleVolumeChange = useCallback(
      (value: number) => {
        const video = ref.current;
        if (!video) return;

        video.volume = value;
        // Raising the slider must also unmute, otherwise scrubbing does nothing audible.
        video.muted = value === 0;
        setVolume(value);
        setState((current) => ({ ...current, muted: value === 0 }));
      },
      [setVolume]
    );

    const showCustomControls = loaded && controls && !html5Controls;
    const inSafari =
      typeof navigator !== 'undefined' && /Version\/[\d.]+.*Safari/.test(navigator.userAgent);

    useEffect(() => {
      // Hard set the width to 100% for Safari because it doesn't render in full size otherwise ¯\_(ツ)_/¯ -Manuel
      if (inSafari && ref.current) {
        ref.current.classList.add('w-full');
      }
      if (fadeIn && ref.current?.readyState === 4) ref.current.style.opacity = '1';
    }, [fadeIn, inSafari]);

    const { url: videoUrl } = useEdgeUrl(src, { ...options, anim: true });
    const { url: coverUrl } = useEdgeUrl(thumbnailUrl ?? src, {
      width: options?.width,
      optimized: options?.optimized,
      skip: thumbnailUrl ? undefined : options?.skip,
      anim: thumbnailUrl ? undefined : false,
      transcode: thumbnailUrl ? undefined : true,
      original: thumbnailUrl ? undefined : false,
    });

    const node = useScrollAreaRef();

    // ensure that video only plays when it is in the current view/dialog
    const dialogCount = useDialogStore((state) => state.dialogs.length);
    const stackRef = useRef<number | null>(null);
    if (stackRef.current === null) stackRef.current = dialogCount;
    const isCurrentStack = stackRef.current === dialogCount;

    const [canPlay, setCanPlay] = useState(false);
    useEffect(() => {
      const videoElem = ref.current;
      if (!videoElem || !options?.anim || props.autoPlay) return;
      const observer = new IntersectionObserver(
        ([{ intersectionRatio }]) => {
          setCanPlay(intersectionRatio >= threshold);
        },
        { root: node?.current, threshold: [threshold, 1 - threshold] }
      );
      observer.observe(videoElem);
      return () => {
        observer.unobserve(videoElem);
        observer.disconnect();
      };
    }, [threshold, options?.anim, loaded, props.autoPlay]);

    useEffect(() => {
      const videoElem = ref.current;
      if (!videoElem) return;
      if (isCurrentStack && (canPlay || props.autoPlay)) {
        videoElem.play().catch(() => {
          // Autoplay failed, user interaction required
          setAutoplayFailed(true);
        });
      } else {
        videoElem.pause();
      }
    }, [canPlay, isCurrentStack, props.autoPlay]);

    const { start: handleMouseEnter, clear } = useTimeout(
      (e: [React.MouseEvent<HTMLVideoElement>]) => {
        const [event] = e;
        (event.target as HTMLVideoElement).play();
      },
      1000
    );

    const handleMouseLeave: MouseEventHandler<HTMLVideoElement> = (e) => {
      e.currentTarget.pause();
      clear();
    };

    // Dark translucent buttons + white icons so the controls stay legible over bright media.
    const controlButtonClass = 'z-10 border-0 !bg-black/50 !text-white hover:!bg-black/70';

    const defaultPlayer = (
      // extra div wrapper to prevent positioning errors of parent components that make their child absolute
      <div
        ref={containerRef}
        {...wrapperProps}
        className={clsx(
          styles.iosScroll,
          wrapperProps?.className ? wrapperProps?.className : 'h-full',
          'relative flex flex-col items-center justify-center overflow-hidden'
        )}
      >
        <video
          key={videoUrl}
          ref={ref}
          // Drag source lives on the video body only. If it were on the container, the browser
          // would walk up from the volume slider to the draggable ancestor and start a drag while
          // scrubbing — draggable={false} on the controls does NOT block that ancestor walk-up.
          draggable={!!imageId}
          onDragStart={
            imageId
              ? (e) => {
                  e.dataTransfer.setData('text/uri-list', videoUrl);
                  e.dataTransfer.setData('application/x-civitai-media-id', String(imageId));
                  e.dataTransfer.setData('application/x-civitai-media-type', 'video');
                }
              : undefined
          }
          className={clsx(`block cursor-pointer ${contain ? 'h-full' : 'h-auto'}`)}
          muted={state.muted}
          style={style}
          onLoadedMetadata={markVideoReady}
          onLoadedData={handleLoadedData}
          onCanPlay={markVideoReady}
          onLoad={onLoad}
          controls={html5Controls}
          onClick={handleTogglePlayPause}
          onPlaying={() => {
            setIsPlaying(true);
            setAutoplayFailed(false);
            detectAudio();
          }}
          onPause={() => setIsPlaying(false)}
          onVolumeChange={(e) => {
            !initialMuted ? handleVolumeChange(e.currentTarget.volume) : undefined;
          }}
          playsInline
          onMouseOver={!options?.anim ? handleMouseEnter : undefined}
          onMouseLeave={!options?.anim ? handleMouseLeave : undefined}
          autoPlay={!!(options?.anim && disablePoster)}
          loop
          poster={!disablePoster ? coverUrl : undefined}
          disablePictureInPicture
          preload={inSafari ? 'auto' : controls && !html5Controls ? 'metadata' : 'none'}
          onError={onError}
          {...props}
        >
          {!disableWebm && <source src={videoUrl?.replace('.mp4', '.webm')} type="video/webm" />}
          <source src={videoUrl} type="video/mp4" />
        </video>
        {((!options?.anim && !showCustomControls && !html5Controls && !isPlaying) ||
          autoplayFailed) && (
          <IconPlayerPlayFilled
            className={clsx(styles.playButton, 'pointer-events-none z-10 absolute-center')}
          />
        )}
        {showCustomControls && (
          <div className={styles.controls}>
            <LegacyActionIcon
              onClick={handleTogglePlayPause}
              className={controlButtonClass}
              variant="light"
              size="lg"
              radius="xl"
            >
              {isPlaying ? <IconPlayerPauseFilled size={16} /> : <IconPlayerPlayFilled size={16} />}
            </LegacyActionIcon>
            <div className="flex flex-nowrap gap-4">
              {hasAudioState && (
                <HoverCard
                  position="top"
                  offset={2}
                  openDelay={0}
                  closeDelay={100}
                  withinPortal={false}
                >
                  <HoverCard.Target>
                    <LegacyActionIcon
                      onClick={handleToggleMuted}
                      className={controlButtonClass}
                      variant="light"
                      size="lg"
                      radius="xl"
                    >
                      {state.muted || volume === 0 ? (
                        <IconVolumeOff size={16} />
                      ) : (
                        <IconVolume size={16} />
                      )}
                    </LegacyActionIcon>
                  </HoverCard.Target>
                  <HoverCard.Dropdown
                    className={styles.volumeDropdown}
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <input
                      type="range"
                      className={styles.volumeSlider}
                      min="0"
                      max="1"
                      step="0.05"
                      value={state.muted ? 0 : volume}
                      onChange={(e) => handleVolumeChange(e.currentTarget.valueAsNumber)}
                    />
                  </HoverCard.Dropdown>
                </HoverCard>
              )}
              <LegacyActionIcon
                onClick={handleToggleFullscreen}
                className={controlButtonClass}
                variant="light"
                size="lg"
                radius="xl"
              >
                {isFullscreen ? <IconMinimize size={16} /> : <IconMaximize size={16} />}
              </LegacyActionIcon>
            </div>
          </div>
        )}
        {showPlayIndicator && (
          <ThemeIcon className={styles.playIndicator} size={64} radius="xl" color="dark">
            {ref.current?.paused ? <IconPlayerPauseFilled /> : <IconPlayerPlayFilled />}
          </ThemeIcon>
        )}
      </div>
    );

    if (youtubeVideoId) {
      return (
        <YoutubeEmbed className="block size-full" style={style} videoId={youtubeVideoId} autoPlay />
      );
    }

    if (vimeoVideoId) {
      return (
        <VimeoEmbed
          className="block size-full"
          style={style}
          videoId={vimeoVideoId}
          autoplay
          fallbackContent={defaultPlayer}
        />
      );
    }

    return defaultPlayer;
  }
);

EdgeVideo.displayName = 'EdgeVideo';

// Using `any` here because mozHasAudio, webkitAudioDecodedByteCount, and audioTracks are not
// standardized on the HTMLVideoElement type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hasAudio = (video: any): boolean => {
  return (
    video.mozHasAudio ||
    Boolean(video.webkitAudioDecodedByteCount) ||
    Boolean(video.audioTracks && video.audioTracks.length)
  );
};
