import { ActionIcon, createStyles } from '@mantine/core';
import { IconVolume, IconVolumeOff } from '@tabler/icons-react';
import React, { useRef, useState } from 'react';

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

  // const showAudioControl = ref.current ? hasAudio(ref.current) : false;
  // console.log({ video: ref.current, showAudioControl });

  return (
    <div style={{ position: 'relative' }}>
      <video
        ref={ref}
        muted={muted}
        autoPlay
        loop
        playsInline
        style={{ display: 'block', ...style }}
        onLoadedMetadata={
          controls
            ? (e) => {
                setTimeout(() => {
                  // doesn't work without timeout
                  setShowAudioControl(hasAudio(e.target));
                }, 100);
              }
            : undefined
        }
        {...props}
      >
        <source src={src} type="video/webm" />
      </video>
      {controls && (
        <div className={classes.controls}>
          {showAudioControl && (
            <ActionIcon onClick={() => setMuted((muted) => !muted)} variant="light" size="lg">
              {muted ? <IconVolume /> : <IconVolumeOff />}
            </ActionIcon>
          )}
        </div>
      )}
    </div>
  );
}

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
