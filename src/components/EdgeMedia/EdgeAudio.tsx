import { ActionIcon, Alert, Center, Group, GroupProps } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import { WavesurferProps, useWavesurfer } from '@wavesurfer/react';
import { memo, useEffect, useRef, useState } from 'react';
import { WaveSurferOptions } from 'wavesurfer.js';
import { AUDIO_SAMPLE_RATE } from '~/server/common/constants';

const wavesurferOptions: Partial<WaveSurferOptions> = {
  waveColor: '#D9D9D9',
  progressColor: '#44A1FA',
  height: 40,
  barGap: 4,
  barWidth: 2,
  barRadius: 4,
  cursorWidth: 0,
  sampleRate: AUDIO_SAMPLE_RATE,
  width: '100%',
  normalize: true,
  interact: false,
  hideScrollbar: true,
};

function _EdgeAudio({
  src,
  wrapperProps,
  name,
  onPlay,
  onReady,
  onAudioprocess,
  ...props
}: EdgeAudioProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const alreadyPlayed = useRef(false);

  const [volume] = useLocalStorage({ key: 'player-volume', defaultValue: 1 });

  const { wavesurfer } = useWavesurfer({
    ...wavesurferOptions,
    container: containerRef,
    url: src,
    ...props,
  });

  const [playing, setPlaying] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const handleTogglePlay: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    e.preventDefault();

    if (!wavesurfer) return;
    wavesurfer.playPause();
  };

  // Initialize wavesurfer when the container mounts
  // or any of the props change
  useEffect(() => {
    if (!wavesurfer) return;

    const getPlayerParams = () => ({
      media: wavesurfer.getMediaElement(),
      peaks: props.peaks as number[][],
      duration: wavesurfer.getDuration(),
      name,
      src,
    });

    const subscriptions = [
      wavesurfer.on('ready', () => {
        if (onReady) onReady(getPlayerParams());
        setPlaying(wavesurfer.isPlaying());
        wavesurfer.setVolume(volume);
      }),
      wavesurfer.on('error', (error) => {
        console.error(error);
        setLoadError(true);
      }),
      wavesurfer.on('play', () => {
        if (onPlay) onPlay(getPlayerParams());

        wavesurfer.setVolume(volume);
        setPlaying(true);
      }),
      wavesurfer.on('pause', () => setPlaying(false)),
      wavesurfer.on('audioprocess', (currentTime) => {
        if (wavesurfer.isPlaying() && currentTime > 5 && !alreadyPlayed.current && onAudioprocess) {
          onAudioprocess();
          alreadyPlayed.current = true;
        }
      }),
    ];

    return () => {
      subscriptions.forEach((unsub) => unsub());
    };
  }, [wavesurfer, onPlay, onReady, onAudioprocess]);

  useEffect(() => {
    if (wavesurfer) wavesurfer.setVolume(volume);
  }, [volume, wavesurfer]);

  // if (loadError)
  //   return (
  //     <Alert w="100%" color="red" radius="md">
  //       <Center>Failed to load audio</Center>
  //     </Alert>
  //   );

  return (
    <Group spacing="sm" w="100%" pos="relative" noWrap {...wrapperProps}>
      <ActionIcon size={40} radius="xl" variant="filled" color="blue" onClick={handleTogglePlay}>
        {playing ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
      </ActionIcon>
      <div ref={containerRef} style={{ overflow: 'hidden', flexGrow: 1 }} />
    </Group>
  );
}

export const EdgeAudio = memo(_EdgeAudio);

export type EdgeAudioProps = Omit<WavesurferProps, 'onPlay' | 'onReady' | 'onAudioprocess'> & {
  src?: string;
  wrapperProps?: GroupProps;
  onReady?: (params: Track) => void;
  onPlay?: (track: Track | null) => void;
  onAudioprocess?: () => void;
  name?: string | null;
};
