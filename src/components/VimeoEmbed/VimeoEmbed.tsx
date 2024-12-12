import { Box, BoxProps } from '@mantine/core';
import Player from '@vimeo/player';
import { useEffect, useRef, useState } from 'react';

export const VimeoEmbed = ({
  videoId,
  autoplay,
  fallbackContent,
  sx,
  ...props
}: { videoId: string; autoplay?: boolean; fallbackContent?: React.ReactNode } & BoxProps) => {
  const ref = useRef<Player | null>(null);
  const [useFallbackContent, setUseFallbackContent] = useState(false);

  useEffect(() => {
    ref.current = new Player(videoId, {
      id: Number(videoId),
      autoplay,
    });

    ref.current.on('error', () => {
      setUseFallbackContent(true);
    });
  }, [videoId]);

  if (useFallbackContent && fallbackContent) {
    return <>{fallbackContent}</>;
  }

  return (
    <Box
      {...props}
      sx={{
        overflow: 'hidden',
        position: 'relative',
        height: 0,
        paddingBottom: '56.25%',
        iframe: {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
        },
      }}
      id={videoId}
    ></Box>
  );
};
