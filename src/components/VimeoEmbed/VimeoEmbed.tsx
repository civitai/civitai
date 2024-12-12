import { Box, BoxProps, Loader } from '@mantine/core';
import Player from '@vimeo/player';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '~/utils/trpc';

export const VimeoEmbed = ({
  videoId,
  autoplay,
  fallbackContent,
  sx,
  ...props
}: { videoId: string; autoplay?: boolean; fallbackContent?: React.ReactNode } & BoxProps) => {
  const ref = useRef<Player | null>(null);
  const { data, isLoading } = trpc.vimeo.checkVideoAvailable.useQuery({
    id: videoId,
  });
  const [useFallbackContent, setUseFallbackContent] = useState(false);

  useEffect(() => {
    if (!data) {
      return;
    }

    try {
      ref.current = new Player(videoId, {
        id: Number(videoId),
        autoplay,
      });

      ref.current.on('error', (...args) => {
        console.log(...args, 'THEREW WAS AN ERRORITO');
        setUseFallbackContent(true);
      });
    } catch (error) {
      console.log('error', error);
      setUseFallbackContent(true);
    }

    return () => {
      ref.current?.destroy();
    };
  }, [data, videoId, autoplay]);

  if (useFallbackContent && fallbackContent) {
    return <>{fallbackContent}</>;
  }

  if (isLoading) {
    return (
      <Box {...props}>
        {/* <Center> */}
        <Loader m="auto" />
        {/* </Center> */}
      </Box>
    );
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
      data-vimeo-id={videoId}
    ></Box>
  );
};
