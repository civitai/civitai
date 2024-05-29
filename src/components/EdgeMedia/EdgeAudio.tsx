import { ActionIcon, Group, GroupProps, useMantineTheme } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import { useWavesurfer, WavesurferProps } from '@wavesurfer/react';
import { useEffect, useRef, useState } from 'react';
import { Track } from '~/store/player.store';

export function EdgeAudio({ src, wrapperProps, name, onPlay, onReady, ...props }: Props) {
  const theme = useMantineTheme();
  const containerRef = useRef<HTMLDivElement>(null);

  const [volume] = useLocalStorage({ key: 'player-volume', defaultValue: 1 });

  const { wavesurfer } = useWavesurfer({
    container: containerRef,
    url: src,
    waveColor: theme.colors.blue[0],
    progressColor: theme.colors.blue[7],
    height: 40,
    barGap: 4,
    barWidth: 2,
    barRadius: 4,
    cursorWidth: 0,
    width: '100%',
    normalize: true,
    interact: false,
    hideScrollbar: true,
    ...props,
  });

  const [playing, setPlaying] = useState(false);

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
      peaks: wavesurfer.exportPeaks(),
      duration: wavesurfer.getDuration(),
      name,
    });

    const subscriptions = [
      wavesurfer.on('ready', () => {
        if (onReady) onReady(getPlayerParams());
        setPlaying(wavesurfer.isPlaying());
        wavesurfer.setVolume(volume);
      }),
      wavesurfer.on('play', () => {
        if (onPlay) {
          onPlay((prev) => {
            const newParams = getPlayerParams();
            if (!prev || prev.media !== newParams.media) {
              if (prev) {
                prev.media.pause();
                prev.media.currentTime = 0;
              }
              return newParams;
            }
            return prev;
          });
        }

        wavesurfer.setVolume(volume);
        setPlaying(true);
      }),
      wavesurfer.on('pause', () => setPlaying(false)),
    ];

    return () => {
      subscriptions.forEach((unsub) => unsub());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wavesurfer]);

  return (
    <Group spacing="sm" w="100%" pos="relative" noWrap {...wrapperProps}>
      <ActionIcon size={40} radius="xl" variant="filled" color="blue" onClick={handleTogglePlay}>
        {playing ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
      </ActionIcon>
      <div ref={containerRef} style={{ overflow: 'hidden', flexGrow: 1 }} />
    </Group>
  );
}

type Props = Omit<WavesurferProps, 'onPlay' | 'onReady'> & {
  src?: string;
  wrapperProps?: GroupProps;
  onReady?: (params: Track) => void;
  onPlay?: (callback: (prev: Track | null) => Track | null) => void;
  name?: string | null;
};
