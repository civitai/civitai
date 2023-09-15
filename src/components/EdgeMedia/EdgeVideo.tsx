import { ActionIcon, createStyles } from '@mantine/core';
import { IconVolume, IconVolumeOff } from '@tabler/icons-react';
import React, { useEffect, useRef, useState } from 'react';

type VideoProps = React.DetailedHTMLProps<
  React.VideoHTMLAttributes<HTMLVideoElement>,
  HTMLVideoElement
>;

export function EdgeVideo({
  src,
  muted: initialMuted = true,
  controls,
  style,
  ...props
}: VideoProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [muted, setMuted] = useState(initialMuted);
  const [showAudioControl, setShowAudioControl] = useState(false);
  const { classes } = useStyles();

  useEffect(() => {
    // Hard set the src for Safari because it doesn't support autoplay webm
    const inSafari = typeof navigator !== 'undefined' && navigator.userAgent.match(/safari/i);
    if (inSafari && ref.current && src) {
      ref.current.src = src;
    }
  }, [src]);

  return (
    // extra div wrapper to prevent positioning errors of parent components that make their child absolute
    <div>
      <div style={{ position: 'relative' }}>
        <video
          ref={ref}
          muted={muted}
          autoPlay
          loop
          playsInline
          style={{ display: 'block', ...style }}
          onLoadedData={controls ? (e) => setShowAudioControl(hasAudio(e.target)) : undefined}
          {...props}
        >
          <source src={src?.replace('.mp4', '.webm')} type="video/webm" />
          <source src={src} type="video/mp4" />
        </video>
        {controls && (
          <div className={classes.controls}>
            {showAudioControl && (
              <ActionIcon onClick={() => setMuted((muted) => !muted)} variant="light" size="lg">
                {!muted ? <IconVolume /> : <IconVolumeOff />}
              </ActionIcon>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

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
}));
