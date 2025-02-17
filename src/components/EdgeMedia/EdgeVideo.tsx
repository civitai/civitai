import { ActionIcon, createStyles, ThemeIcon } from '@mantine/core';
import {
  IconMaximize,
  IconMinimize,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react';
import React, {
  forwardRef,
  MouseEventHandler,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { YoutubeEmbed } from '~/components/YoutubeEmbed/YoutubeEmbed';
import { VimeoEmbed } from '../VimeoEmbed/VimeoEmbed';
import { fadeInOut } from '~/libs/animations';
import { useLocalStorage, useTimeout } from '@mantine/hooks';
import { EdgeUrlProps, useEdgeUrl } from '~/client-utils/cf-images-utils';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import clsx from 'clsx';

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
  threshold?: number | null;
  disableWebm?: boolean;
  disablePoster?: boolean;
};

export type EdgeVideoRef = {
  stop: () => void;
};

type State = {
  loaded: boolean;
  muted: boolean;
  isPlaying: boolean;
  showPlayIndicator: boolean;
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
      ...props
    },
    forwardedRef
  ) => {
    const ref = useRef<HTMLVideoElement | null>(null);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const [state, setState] = useState<State>({
      loaded: false,
      muted: initialMuted,
      isPlaying: false,
      showPlayIndicator: false,
    });
    const [volume, setVolume] = useLocalStorage({
      key: 'global-volume',
      defaultValue: state.muted ? 0 : 0.5,
    });

    const { classes, cx } = useStyles();

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

        setState((current) => ({ ...current, showPlayIndicator: true }));
        setTimeout(() => setState((current) => ({ ...current, showPlayIndicator: false })), 500);
      }
    }, [controls, html5Controls]);

    const handleToggleFullscreen = useCallback(() => {
      const container = containerRef.current;
      if (!container) return;

      if (!document.fullscreenElement) {
        container.requestFullscreen().catch((err) => {
          console.error(`Error attempting to enable fullscreen mode: ${err.message}`);
        });
      } else {
        document.exitFullscreen();
      }
    }, []);

    const handleLoadedData = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
      setState((current) => ({ ...current, loaded: true }));
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

    const showCustomControls = state.loaded && controls && !html5Controls;
    const enableAudioControl = ref.current && hasAudio(ref.current);

    if (!initialMuted && state.loaded && ref.current) ref.current.volume = volume;

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
    const observerRef = useRef<IntersectionObserver>();

    useEffect(() => {
      const videoElem = ref.current;
      if (!videoElem || threshold === null) return;
      if (!observerRef.current) {
        observerRef.current = new IntersectionObserver(
          ([{ isIntersecting, intersectionRatio, target }]) => {
            const elem = target as HTMLVideoElement;
            if (!options?.anim) return;
            if (isIntersecting && intersectionRatio >= threshold) {
              elem.play().catch(console.error);
            } else if (!isIntersecting || (isIntersecting && intersectionRatio < threshold)) {
              elem.pause();
            }
          },
          { root: node?.current, threshold: [threshold, 1 - threshold] }
        );
      }
      observerRef.current.observe(videoElem);
      return () => {
        observerRef.current?.unobserve(videoElem);
      };
    }, [threshold, options?.anim]);

    const [mouseOver, setMouseOver] = useState(false);

    const { start: handleMouseEnter, clear } = useTimeout(
      (e: [React.MouseEvent<HTMLVideoElement>]) => {
        const [event] = e;
        (event.target as HTMLVideoElement).play();
        setMouseOver(true);
      },
      1000
    );

    const handleMouseLeave: MouseEventHandler<HTMLVideoElement> = (e) => {
      e.currentTarget.pause();
      clear();
      setMouseOver(false);
    };

    const defaultPlayer = (
      // extra div wrapper to prevent positioning errors of parent components that make their child absolute
      <div
        ref={containerRef}
        className={cx(
          classes.iosScroll,
          wrapperProps?.className,
          'overflow-hidden relative flex items-center justify-center h-full'
        )}
        {...wrapperProps}
      >
        <video
          ref={ref}
          className={clsx(`block cursor-pointer ${contain ? 'h-full' : 'h-auto'}`)}
          muted={state.muted}
          style={style}
          onLoadedData={handleLoadedData}
          controls={html5Controls}
          onClick={handleTogglePlayPause}
          onPlaying={() => setState((current) => ({ ...current, isPlaying: true }))}
          onPause={() => setState((current) => ({ ...current, isPlaying: false }))}
          onVolumeChange={(e) => {
            !initialMuted ? handleVolumeChange(e.currentTarget.volume) : undefined;
          }}
          playsInline
          onMouseOver={!options?.anim ? handleMouseEnter : undefined}
          onMouseLeave={!options?.anim ? handleMouseLeave : undefined}
          autoPlay={options?.anim}
          loop
          poster={!disablePoster ? coverUrl : undefined}
          disablePictureInPicture
          preload="none"
          {...props}
        >
          {!disableWebm && <source src={videoUrl?.replace('.mp4', '.webm')} type="video/webm" />}
          <source src={videoUrl} type="video/mp4" />
        </video>
        {!options?.anim && !showCustomControls && !html5Controls && !mouseOver && (
          <IconPlayerPlayFilled
            className={cx(classes.playButton, 'absolute-center pointer-events-none')}
          />
        )}
        {showCustomControls && (
          <div className={classes.controls}>
            <ActionIcon
              onClick={handleTogglePlayPause}
              className="z-10"
              variant="light"
              size="lg"
              radius="xl"
            >
              {state.isPlaying ? (
                <IconPlayerPauseFilled size={16} />
              ) : (
                <IconPlayerPlayFilled size={16} />
              )}
            </ActionIcon>
            <div className="flex flex-nowrap gap-4">
              {enableAudioControl && (
                <div className={classes.volumeControl}>
                  <div className={classes.volumeSlider}>
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
                  <ActionIcon
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
                  </ActionIcon>
                </div>
              )}
              <ActionIcon
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
              </ActionIcon>
            </div>
          </div>
        )}
        {state.showPlayIndicator && (
          <ThemeIcon className={classes.playIndicator} size={64} radius="xl" color="dark">
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

const useStyles = createStyles((theme, _, getRef) => ({
  controls: {
    position: 'absolute',
    display: 'flex',
    gap: 8,
    flexWrap: 'nowrap',
    padding: theme.spacing.xs,
    width: '100%',
    justifyContent: 'space-between',
    bottom: 0,
  },
  iosScroll: {
    [theme.fn.smallerThan('md')]: {
      '&::after': {
        position: 'absolute',
        top: '0px',
        right: '0px',
        bottom: '0px',
        left: '0px',
        content: '""',
        pointerEvents: 'none',
      },
    },
  },
  playIndicator: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    color: theme.white,
    opacity: 0,
    animation: `${fadeInOut} .5s`,
    pointerEvents: 'none',
  },

  volumeControl: {
    zIndex: 10,
    display: 'flex',
    position: 'relative',
    flexDirection: 'column',
    gap: 8,

    '&:hover': {
      [`& .${getRef('volumeSlider')}`]: {
        display: 'block',
      },
    },
  },

  volumeSlider: {
    ref: getRef('volumeSlider'),

    display: 'none',
    position: 'absolute',
    lineHeight: 1,
    padding: theme.spacing.xs,
    top: 0,
    left: 0,
    transform: 'translate(-33%, -170%) rotate(270deg)',
    zIndex: 10,
  },
  playButton: {
    width: 80,
    height: 80,
    color: theme.white,
    backgroundColor: 'rgba(0,0,0,.6)',
    padding: 20,
    borderRadius: '50%',
    boxShadow: `0 2px 2px 1px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.2)`,
    transition: 'background-color 200ms ease',
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
  },
}));
