import { ActionIcon, createStyles } from '@mantine/core';
import { IconVolume, IconVolumeOff } from '@tabler/icons-react';
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { YoutubeEmbed } from '~/components/YoutubeEmbed/YoutubeEmbed';
import { VimeoEmbed } from '../VimeoEmbed/VimeoEmbed';

type VideoProps = React.DetailedHTMLProps<
  React.VideoHTMLAttributes<HTMLVideoElement>,
  HTMLVideoElement
> & {
  wrapperProps?: React.ComponentPropsWithoutRef<'div'>;
  contain?: boolean;
  fadeIn?: boolean;
  html5Controls?: boolean;
  onMutedChange?: (muted: boolean) => void;
  youtubeVideoId?: string;
  vimeoVideoId?: string;
};

export type EdgeVideoRef = {
  stop: () => void;
};

export const EdgeVideo = forwardRef<EdgeVideoRef, VideoProps>(
  (
    {
      src,
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
      ...props
    },
    forwardedRef
  ) => {
    const ref = useRef<HTMLVideoElement | null>(null);
    const [muted, setMuted] = useState(initialMuted);
    const [showAudioControl, setShowAudioControl] = useState(false);

    const { classes, cx } = useStyles();

    useEffect(() => {
      // Hard set the src for Safari because it doesn't support autoplay webm
      const inSafari =
        typeof navigator !== 'undefined' && /Version\/[\d.]+.*Safari/.test(navigator.userAgent);
      if (inSafari && ref.current && src) {
        ref.current.src = src;
      }
      if (fadeIn && ref.current?.readyState === 4) ref.current.style.opacity = '1';
    }, [src]);

    useImperativeHandle(forwardedRef, () => ({
      stop: () => {
        if (ref.current) {
          ref.current.pause();
          ref.current.currentTime = 0;
        }
      },
    }));

    const defaultPlayer = (
      // extra div wrapper to prevent positioning errors of parent components that make their child absolute
      <div {...wrapperProps} className={cx(classes.iosScroll, wrapperProps?.className)}>
        <div
          style={{
            position: 'relative',
            height: contain ? '100%' : 'auto',
            width: contain ? '100%' : 'auto',
          }}
        >
          <video
            ref={ref}
            muted={muted}
            autoPlay
            loop
            playsInline
            style={{ display: 'block', ...style }}
            onLoadedData={
              controls
                ? (e) => {
                    setShowAudioControl(hasAudio(e.target));
                    e.currentTarget.style.opacity = '1';
                  }
                : (e) => (e.currentTarget.style.opacity = '1')
            }
            controls={html5Controls}
            onVolumeChange={
              html5Controls
                ? (e) => {
                    if (ref.current) {
                      onMutedChange?.(ref.current?.volume === 0 || ref.current?.muted);
                    }
                  }
                : undefined
            }
            {...props}
          >
            <source src={src?.replace('.mp4', '.webm')} type="video/webm" />
            <source src={src} type="video/mp4" />
          </video>
          {controls && !html5Controls && (
            <div className={classes.controls}>
              {showAudioControl && (
                <ActionIcon
                  onClick={() => {
                    setMuted((muted) => !muted);
                    onMutedChange?.(!muted);
                  }}
                  variant="light"
                  size="lg"
                  sx={{ zIndex: 10 }}
                >
                  {!muted ? <IconVolume /> : <IconVolumeOff />}
                </ActionIcon>
              )}
            </div>
          )}
        </div>
      </div>
    );

    if (youtubeVideoId) {
      return (
        <YoutubeEmbed
          style={{ display: 'block', width: '100%', height: 'auto', ...style }}
          videoId={youtubeVideoId}
          autoPlay
        />
      );
    }

    if (vimeoVideoId) {
      return (
        <VimeoEmbed
          style={{ display: 'block', width: '100%', height: 'auto', ...style }}
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

const useStyles = createStyles((theme) => ({
  controls: {
    position: 'absolute',
    bottom: theme.spacing.xs,
    right: theme.spacing.xs,
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
}));
