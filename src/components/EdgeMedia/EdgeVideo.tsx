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

// `fullscreenchange` is a document-level event (no JSX prop for it), so we subscribe via
// useSyncExternalStore instead of useEffect to read fullscreen state reactively.
function subscribeFullscreen(callback: () => void) {
  document.addEventListener('fullscreenchange', callback);
  return () => document.removeEventListener('fullscreenchange', callback);
}
const getFullscreenSnapshot = () => typeof document !== 'undefined' && !!document.fullscreenElement;
const getFullscreenServerSnapshot = () => false;

// Safari needs special handling (forced width, eager preload). userAgent is stable, so compute once.
const IN_SAFARI =
  typeof navigator !== 'undefined' && /Version\/[\d.]+.*Safari/.test(navigator.userAgent);

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
    const [muted, setMuted] = useState(initialMuted);
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
      defaultValue: muted ? 0 : 0.5,
    });

    // Re-sync muted when the forcing prop flips or the persisted volume resolves to 0 (volume
    // hydrates from localStorage after mount). Render-phase adjust replaces a prop-sync effect;
    // `video.muted` follows via the JSX `muted={muted}` binding, so no imperative write is needed.
    // Does not clobber a manual "mute but remember level" (muted=true while volume>0).
    const shouldForceMute = initialMuted || volume === 0;
    const [lastForceMute, setLastForceMute] = useState(shouldForceMute);
    if (lastForceMute !== shouldForceMute) {
      setLastForceMute(shouldForceMute);
      setMuted(shouldForceMute);
    }

    // React only controls the muted *attribute* (the initial default), not the live `.muted`
    // *property* — so a persisted unmute won't reach the element on its own, and autoplay/refresh
    // can leave the video stuck muted. Sync the property imperatively whenever muted changes.
    useEffect(() => {
      if (ref.current) ref.current.muted = muted;
    }, [muted]);

    useImperativeHandle(forwardedRef, () => ({
      stop: () => {
        if (ref.current) {
          ref.current.pause();
          ref.current.currentTime = 0;
        }
      },
    }));

    // mantine useTimeout auto-clears on unmount, so the indicator timer needs no cleanup effect.
    const { start: startHideIndicator, clear: clearHideIndicator } = useTimeout(
      () => setShowPlayIndicator(false),
      500
    );

    const handleTogglePlayPause = useCallback(() => {
      if (controls && !html5Controls && ref.current) {
        if (ref.current.paused) {
          ref.current.play();
        } else {
          ref.current.pause();
        }

        setShowPlayIndicator(true);
        // clear() then start() restarts the hide timer on rapid re-toggles.
        clearHideIndicator();
        startHideIndicator();
      }
    }, [controls, html5Controls, startHideIndicator, clearHideIndicator]);

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
        // Opacity is now driven declaratively by `loaded` (see the <video> style prop).
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
      setMuted(nextMuted);
      onMutedChange?.(nextMuted);
    }, [onMutedChange, setVolume, volume]);

    const handleVolumeChange = useCallback(
      (value: number) => {
        const video = ref.current;
        if (!video) return;

        video.volume = value;
        // Raising the slider must also unmute, otherwise scrubbing does nothing audible.
        const nextMuted = value === 0;
        video.muted = nextMuted;
        setVolume(value);
        setMuted(nextMuted);
        // Notify parent so the external mute toggle stays in sync when the slider crosses 0.
        onMutedChange?.(nextMuted);
      },
      [onMutedChange, setVolume]
    );

    const showCustomControls = loaded && controls && !html5Controls;
    // Drag-to-add is for control-less previews. Any controls (custom or native) take over pointer
    // interaction — disable drag so scrubbing/volume don't get hijacked into a video drag.
    const draggableEnabled = !!imageId && !controls && !html5Controls;

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
          // Drag is only enabled when no controls are shown (see draggableEnabled), so scrubbing/
          // volume on custom or native controls can never get hijacked into a video drag.
          draggable={draggableEnabled}
          onDragStart={
            draggableEnabled
              ? (e) => {
                  e.dataTransfer.setData('text/uri-list', videoUrl);
                  e.dataTransfer.setData('application/x-civitai-media-id', String(imageId));
                  e.dataTransfer.setData('application/x-civitai-media-type', 'video');
                }
              : undefined
          }
          className={clsx(`block cursor-pointer ${contain ? 'h-full' : 'h-auto'}`)}
          muted={muted}
          style={{
            ...style,
            // Safari won't render full size without an explicit width ¯\_(ツ)_/¯ -Manuel
            ...(IN_SAFARI ? { width: '100%' } : {}),
            // fadeIn videos start transparent (the .fadeIn class supplies the transition) and
            // reveal once loaded — declarative replacement for the old imperative opacity writes.
            ...(fadeIn ? { opacity: loaded ? 1 : 0 } : {}),
          }}
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
            // Native controls own the element's volume/mute here (custom slider/toggle update state
            // directly, so forwarding them would double-fire). Mirror BOTH volume and muted from the
            // element — deriving muted from volume alone fights the native mute button, which mutes
            // while keeping volume > 0.
            if (!html5Controls || initialMuted) return;
            const video = e.currentTarget;
            const nextMuted = video.muted || video.volume === 0;
            if (video.volume > 0) setVolume(video.volume); // remember level across mute
            setMuted(nextMuted);
            onMutedChange?.(nextMuted);
          }}
          playsInline
          onMouseOver={!options?.anim ? handleMouseEnter : undefined}
          onMouseLeave={!options?.anim ? handleMouseLeave : undefined}
          autoPlay={!!(options?.anim && disablePoster)}
          loop
          poster={!disablePoster ? coverUrl : undefined}
          disablePictureInPicture
          preload={IN_SAFARI ? 'auto' : controls && !html5Controls ? 'metadata' : 'none'}
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
                      {muted || volume === 0 ? (
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
                      aria-label="Volume"
                      aria-orientation="vertical"
                      className={styles.volumeSlider}
                      min="0"
                      max="1"
                      step="0.05"
                      value={muted ? 0 : volume}
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
            {!isPlaying ? <IconPlayerPauseFilled /> : <IconPlayerPlayFilled />}
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
