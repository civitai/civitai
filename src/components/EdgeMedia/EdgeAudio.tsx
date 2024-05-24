import { ActionIcon, Group, useMantineTheme } from '@mantine/core';
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import { useWavesurfer, WavesurferProps } from '@wavesurfer/react';
import { useEffect, useRef } from 'react';
import { Player, usePlayerStore } from '~/store/player.store';

export function EdgeAudio({ src, wrapperProps, onPlay, onReady, ...props }: Props) {
  const theme = useMantineTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const { wavesurfer, isPlaying, isReady } = useWavesurfer({
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

  const playerStore = usePlayerStore();

  const handleTogglePlay: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    e.preventDefault();

    wavesurfer && wavesurfer.playPause();
  };

  // Initialize wavesurfer when the container mounts
  // or any of the props change
  useEffect(() => {
    if (!wavesurfer) return;

    const getPlayerParams = () => ({
      media: wavesurfer.getMediaElement(),
      peaks: wavesurfer.exportPeaks(),
    });

    const subscriptions = [
      wavesurfer.on('ready', () => {
        onReady && onReady(getPlayerParams());
      }),
      wavesurfer.on('play', () => {
        onPlay &&
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

        playerStore.play();
      }),
      wavesurfer.on('pause', () => playerStore.pause()),
    ];

    return () => {
      subscriptions.forEach((unsub) => unsub());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wavesurfer, onPlay, onReady]);

  return (
    <Group spacing="sm" w="100%" pos="relative" noWrap {...wrapperProps}>
      <ActionIcon size={40} radius="xl" variant="filled" color="blue" onClick={handleTogglePlay}>
        {isPlaying ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
      </ActionIcon>
      <div
        ref={containerRef}
        style={{ display: isReady ? 'block' : 'none', overflow: 'hidden', flexGrow: 1 }}
      />
    </Group>
  );
}

type Props = WavesurferProps & {
  src?: string;
  wrapperProps?: React.ComponentPropsWithoutRef<'div'>;
  onReady?: (params: Player) => void;
  onPlay?: (callback: (prev: Player) => Player) => void;
};
