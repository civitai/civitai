import type { BoxProps } from '@mantine/core';
import { Box, Loader } from '@mantine/core';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { trpc } from '~/utils/trpc';
import styles from './VimeoEmbed.module.scss';

export const VimeoEmbed = ({
  videoId,
  autoplay,
  fallbackContent,
  sx,
  className,
  ...props
}: { videoId: string; autoplay?: boolean; fallbackContent?: React.ReactNode } & BoxProps) => {
  const { data, isLoading } = trpc.vimeo.checkVideoAvailable.useQuery({
    id: videoId,
  });
  const [useFallbackContent, setUseFallbackContent] = useState(false);

  useEffect(() => {
    if (!data && !isLoading) {
      setUseFallbackContent(true);
      return;
    }
  }, [data, isLoading]);

  if (useFallbackContent && fallbackContent) {
    return <>{fallbackContent}</>;
  }

  if (isLoading) {
    return (
      <Box {...props}>
        <Loader m="auto" />
      </Box>
    );
  }

  return (
    <Box
      {...props}
      sx={{
        overflow: 'hidden',
        position: 'relative',
        iframe: {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',

          body: {
            background: '#000',
          },
        },
      }}
      id={videoId}
      data-vimeo-id={videoId}
      className={clsx(className, styles.vimeoWrapper)}
    >
      {data && (
        <iframe
          src={`${data}&autoplay=1&transparent=0`}
          allowFullScreen
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        />
      )}
    </Box>
  );
};
