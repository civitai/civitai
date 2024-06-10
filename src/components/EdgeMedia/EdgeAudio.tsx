import { ActionIcon, Alert, Center, Group, GroupProps } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import { WavesurferProps, useWavesurfer } from '@wavesurfer/react';
import { memo, useEffect, useRef, useState } from 'react';
import { WaveSurferOptions } from 'wavesurfer.js';
import { useUniversalPlayerContext } from '~/components/Player/Player';
import { AUDIO_SAMPLE_RATE } from '~/server/common/constants';

function _EdgeAudio({
  src,
  wrapperProps,
  name,
  duration,
  peaks,
  media,
  onPlay,
  onReady,
  onAudioprocess,
  ...props
}: EdgeAudioProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const alreadyPlayed = useRef(false);

  const [volume] = useLocalStorage({ key: 'player-volume', defaultValue: 1 });

  const { wavesurfer } = useWavesurfer({
    container: containerRef,
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
    url: !media ? src : undefined,
    duration,
    peaks,
    media,
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

    const subscriptions = [
      wavesurfer.on('ready', () => {
        if (onReady) onReady({ name, duration, src, peaks });
        setPlaying(wavesurfer.isPlaying());
        // wavesurfer.setVolume(volume);
      }),
      wavesurfer.on('error', (error) => {
        console.error(error);
        setLoadError(true);
      }),
      wavesurfer.on('play', () => {
        console.log('playing');
        if (onPlay) {
          onPlay({ name, duration, src, peaks });
        }

        // wavesurfer.setVolume(volume);
        setPlaying(true);
      }),
      wavesurfer.on('pause', () => {
        console.log('pausing');
        setPlaying(false);
      }),
      wavesurfer.on('audioprocess', (currentTime) => {
        if (wavesurfer.isPlaying() && currentTime > 5 && !alreadyPlayed.current && onAudioprocess) {
          onAudioprocess();
          alreadyPlayed.current = true;
        }
      }),
    ];
  }, [duration, name, onAudioprocess, onPlay, onReady, peaks, src, volume, wavesurfer]);

  useEffect(() => {
    if (wavesurfer) wavesurfer.setVolume(volume);
  }, [volume, wavesurfer]);

  useEffect(() => {
    return () => {
      wavesurfer?.unAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loadError)
    return (
      <Alert w="100%" color="red" radius="md">
        <Center>Failed to load audio</Center>
      </Alert>
    );

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
  onReady?: (params: Partial<Track>) => void;
  onPlay?: (params: Partial<Track>) => void;
  onAudioprocess?: () => void;
  name?: string | null;
};
