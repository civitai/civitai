import { ActionIcon, Alert, Center, Group, GroupProps } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import { WavesurferProps, useWavesurfer } from '@wavesurfer/react';
import { debounce, set, throttle } from 'lodash-es';
import { memo, useEffect, useRef, useState } from 'react';
import WaveSurfer, { WaveSurferOptions } from 'wavesurfer.js';
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

  const { wavesurfer, isPlaying, isReady, currentTime } = useWs({
    container: containerRef.current as HTMLDivElement,
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

    if (!isPlaying && onPlay) onPlay({ name, duration, src, peaks });
  };

  // Initialize wavesurfer when the container mounts
  // or any of the props change
  // useEffect(() => {
  //   if (!wavesurfer) return;

  //   const subscriptions = [
  //     wavesurfer.on('ready', () => {
  //       if (onReady) onReady({ name, duration, src, peaks });
  //       setPlaying(wavesurfer.isPlaying());
  //       // wavesurfer.setVolume(volume);
  //     }),
  //     wavesurfer.on('error', (error) => {
  //       console.error(error);
  //       setLoadError(true);
  //     }),
  //     wavesurfer.on('play', () => {
  //       console.log('playing');
  //       if (onPlay) {
  //         onPlay({ name, duration, src, peaks });
  //       }

  //       // wavesurfer.setVolume(volume);
  //       setPlaying(true);
  //     }),
  //     wavesurfer.on('pause', () => {
  //       console.log('pausing');
  //       setPlaying(false);
  //     }),
  //     wavesurfer.on('audioprocess', (currentTime) => {
  //       if (wavesurfer.isPlaying() && currentTime > 5 && !alreadyPlayed.current && onAudioprocess) {
  //         onAudioprocess();
  //         alreadyPlayed.current = true;
  //       }
  //     }),
  //   ];
  // }, [duration, name, onAudioprocess, onPlay, onReady, peaks, src, volume, wavesurfer]);

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
        {isPlaying ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
      </ActionIcon>
      <div ref={containerRef} style={{ overflow: 'hidden', flexGrow: 1 }} />
    </Group>
  );
}

export const EdgeAudio = memo(_EdgeAudio);

export type EdgeAudioProps = Omit<WaveSurferOptions, 'container'> & {
  src?: string;
  wrapperProps?: GroupProps;
  onReady?: (params: Partial<Track>) => void;
  onPlay?: (params: Partial<Track>) => void;
  onAudioprocess?: () => void;
  name?: string | null;
};

type WavesurferState = {
  isPlaying: boolean;
  isReady: boolean;
  currentTime: number;
  error: unknown | null;
};

const useWs = ({ container, media, ...props }: WaveSurferOptions) => {
  const { globalAudio } = useUniversalPlayerContext();
  const [wavesurfer, setWavesurfer] = useState<WaveSurfer | null>(null);
  const [state, setState] = useState<WavesurferState>({
    isPlaying: false,
    isReady: false,
    currentTime: 0,
    error: null,
  });
  const stringifiedProps = JSON.stringify(props);

  const debouncedTimeUpdate = throttle(
    (time: number) => setState((prev) => ({ ...prev, currentTime: Math.floor(time) })),
    1000,
    { trailing: false }
  );

  useEffect(() => {
    if (!container) return;

    const ws = WaveSurfer.create({ ...props, container, media });
    setWavesurfer(ws);

    return () => {
      if (globalAudio !== ws.getMediaElement()) ws.destroy();
    };
  }, [container, stringifiedProps]);

  useEffect(() => {
    if (!wavesurfer) return;

    const subscriptions = [
      wavesurfer.on('load', () => {
        console.log('loaded');
        setState({ isPlaying: true, isReady: true, error: null, currentTime: 0 });
      }),

      wavesurfer.on('ready', () => {
        console.log('readied');
        setState((prev) => ({ ...prev, isPlaying: wavesurfer.isPlaying(), isReady: true }));
      }),

      wavesurfer.on('play', () => {
        setState((prev) => ({ ...prev, isPlaying: true }));
      }),

      wavesurfer.on('pause', () => {
        setState((prev) => ({ ...prev, isPlaying: false }));
      }),

      wavesurfer.on('audioprocess', debouncedTimeUpdate),

      wavesurfer.on('destroy', () => {
        console.log('destroyed');
        setState({ isPlaying: false, isReady: true, error: null, currentTime: 0 });
      }),

      wavesurfer.on('error', (error) => {
        if (error) setState((prev) => ({ ...prev, error }));
      }),
    ];

    return () => {
      subscriptions.forEach((unsub) => unsub());
    };
  }, [wavesurfer]);

  return { wavesurfer, ...state };
};
