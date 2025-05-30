import type { BoxProps } from '@mantine/core';
import { Box } from '@mantine/core';
import clsx from 'clsx';

export const YoutubeEmbed = ({
  videoId,
  autoPlay,
  className,
  ...props
}: { videoId: string; autoPlay?: boolean } & BoxProps) => (
  <Box {...props} className={clsx('relative h-0 overflow-hidden pb-[56.25%]', className)}>
    <iframe
      className="absolute left-0 top-0 size-full"
      width="853"
      height="480"
      src={`https://www.youtube.com/embed/${videoId}?autoplay=${autoPlay ? 1 : 0}`}
      frameBorder="0"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
      title="Embedded youtube"
    />
  </Box>
);
