import { Box, BoxProps, Loader } from '@mantine/core';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { trpc } from '~/utils/trpc';
import styles from './VimeoEmbed.module.scss';

export const VimeoEmbed = ({
  videoId,
  autoplay,
  fallbackContent,
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
      id={videoId}
      data-vimeo-id={videoId}
      className={clsx(styles.vimeoWrapper, className)}
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
