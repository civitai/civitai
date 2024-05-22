import { ActionIcon, Group, useMantineTheme } from '@mantine/core';
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import { useWavesurfer, WavesurferProps } from '@wavesurfer/react';
import { useRef } from 'react';

export function EdgeAudio({ src, wrapperProps, ...props }: Props) {
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
    dragToSeek: true,
    ...props,
  });

  const handleTogglePlay = () => {
    wavesurfer && wavesurfer.playPause();
  };

  return (
    <Group spacing={8} w="100%" pos="relative" noWrap {...wrapperProps}>
      <ActionIcon size={40} radius="xl" variant="filled" color="blue" onClick={handleTogglePlay}>
        {isPlaying ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
      </ActionIcon>
      <div ref={containerRef} style={{ flexGrow: 1, display: isReady ? 'block' : 'none' }} />
    </Group>
  );
}

type Props = WavesurferProps & {
  src: string;
  wrapperProps?: React.ComponentPropsWithoutRef<'div'>;
};
