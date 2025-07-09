import { ActionIcon, ThemeIcon } from '@mantine/core';
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
};

export type EdgeVideoRef = {
  stop: () => void;
};

type State = {
  muted: boolean;
};

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
    const [volume, setVolume] = useLocalStorage({
      key: 'global-volume',
      defaultValue: state.muted ? 0 : 0.5,
    });

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

    const handleLoadedData = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
      onLoadedData?.(e);
      setLoaded(true);
      e.currentTarget.style.opacity = '1';
    }, []);

    const handleToggleMuted = useCallback(() => {
      const video = ref.current;
      if (!video) return;

      video.muted = !video.muted;
      setVolume(video.muted ? 0 : video.volume);
      setState((current) => ({ ...current, muted: video.muted }));
      onMutedChange?.(video.muted);
    }, [onMutedChange, setVolume]);

    const handleVolumeChange = useCallback(
      (value: number) => {
        const video = ref.current;
        if (!video) return;

        video.volume = value;
        setVolume(value);
        setState((current) => ({ ...current, muted: value === 0 }));
      },
      [setVolume]
    );

    const showCustomControls = loaded && controls && !html5Controls;
    const enableAudioControl = ref.current && hasAudio(ref.current);

    if (!initialMuted && loaded && ref.current) ref.current.volume = volume;

    useEffect(() => {
      // Hard set the width to 100% for Safari because it doesn't render in full size otherwise ¯\_(ツ)_/¯ -Manuel
      const inSafari =
        typeof navigator !== 'undefined' && /Version\/[\d.]+.*Safari/.test(navigator.userAgent);
      if (inSafari && ref.current) {
        ref.current.classList.add('w-full');
      }
      if (fadeIn && ref.current?.readyState === 4) ref.current.style.opacity = '1';
    }, [fadeIn]);

    const { url: videoUrl } = useEdgeUrl(src, { ...options, anim: true });
    const { url: coverUrl } = useEdgeUrl(thumbnailUrl ?? src, {
      width: options?.width,
      optimized: options?.optimized,
      skip: thumbnailUrl ? undefined : options?.skip,
      anim: thumbnailUrl ? undefined : false,
      transcode: thumbnailUrl ? undefined : true,
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
      };
    }, [threshold, options?.anim, loaded]);

    useEffect(() => {
      const videoElem = ref.current;
      if (!videoElem) return;
      if (isCurrentStack && (canPlay || props.autoPlay)) videoElem.play();
      else videoElem.pause();
    }, [canPlay, loaded, isCurrentStack]);

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
          className={clsx(`block cursor-pointer ${contain ? 'h-full' : 'h-auto'}`)}
          muted={state.muted}
          style={style}
          onLoadedData={handleLoadedData}
          onLoad={onLoad}
          controls={html5Controls}
          onClick={handleTogglePlayPause}
          onPlaying={() => setIsPlaying(true)}
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
          preload="none"
          onError={onError}
          {...props}
        >
          {!disableWebm && <source src={videoUrl?.replace('.mp4', '.webm')} type="video/webm" />}
          <source src={videoUrl} type="video/mp4" />
        </video>
        {!options?.anim && !showCustomControls && !html5Controls && !isPlaying && (
          <IconPlayerPlayFilled
            className={clsx(styles.playButton, 'pointer-events-none z-10 absolute-center')}
          />
        )}
        {showCustomControls && (
          <div className={styles.controls}>
            <LegacyActionIcon
              onClick={handleTogglePlayPause}
              className="z-10"
              variant="light"
              size="lg"
              radius="xl"
            >
              {isPlaying ? <IconPlayerPauseFilled size={16} /> : <IconPlayerPlayFilled size={16} />}
            </LegacyActionIcon>
            <div className="flex flex-nowrap gap-4">
              {enableAudioControl && (
                <div className={styles.volumeControl}>
                  <div className={styles.volumeSlider}>
                    <input
                      type="range"
                      className="w-20"
                      min="0"
                      max="1"
                      step="0.05"
                      value={volume}
                      onChange={(e) => handleVolumeChange(e.currentTarget.valueAsNumber)}
                    />
                  </div>
                  <LegacyActionIcon
                    onClick={handleToggleMuted}
                    className="z-10"
                    variant="light"
                    size="lg"
                    radius="xl"
                    disabled={!enableAudioControl}
                  >
                    {state.muted || volume === 0 || !enableAudioControl ? (
                      <IconVolumeOff size={16} />
                    ) : (
                      <IconVolume size={16} />
                    )}
                  </LegacyActionIcon>
                </div>
              )}
              <LegacyActionIcon
                onClick={handleToggleFullscreen}
                className="z-10"
                variant="light"
                size="lg"
                radius="xl"
              >
                {document.fullscreenElement ? (
                  <IconMinimize size={16} />
                ) : (
                  <IconMaximize size={16} />
                )}
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
