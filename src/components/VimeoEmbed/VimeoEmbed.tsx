import type { BoxProps } from '@mantine/core';
import { Box, Loader } from '@mantine/core';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { ConsentBlockedEmbed } from '~/components/Consent/ConsentBlockedEmbed';
import { useThirdPartyConsent } from '~/components/Consent/consent.context';
import { trpc } from '~/utils/trpc';
import styles from './VimeoEmbed.module.scss';

export const VimeoEmbed = ({
  videoId,
  autoplay,
  fallbackContent,
  className,
  ...props
}: { videoId: string; autoplay?: boolean; fallbackContent?: React.ReactNode } & BoxProps) => {
  const { allowed } = useThirdPartyConsent();
  const { data, isLoading } = trpc.vimeo.checkVideoAvailable.useQuery(
    { id: videoId },
    { enabled: allowed }
  );
  const [useFallbackContent, setUseFallbackContent] = useState(false);

  useEffect(() => {
    // Don't latch fallback while the availability query is disabled (consent
    // rejected). Otherwise rejecting then later accepting consent leaves the
    // component stuck on fallback even after the iframe URL resolves.
    if (!allowed) {
      setUseFallbackContent(false);
      return;
    }
    if (!data && !isLoading) {
      setUseFallbackContent(true);
    }
  }, [allowed, data, isLoading]);

  if (!allowed) {
    return (
      <Box {...props} className={clsx(styles.vimeoWrapper, className)}>
        <ConsentBlockedEmbed kind="vimeo" />
      </Box>
    );
  }

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
