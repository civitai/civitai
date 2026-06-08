import type { BoxProps } from '@mantine/core';
import { Box } from '@mantine/core';
import clsx from 'clsx';
import { ConsentBlockedEmbed } from '~/components/Consent/ConsentBlockedEmbed';
import { useThirdPartyConsent } from '~/components/Consent/consent.context';

export const YoutubeEmbed = ({
  videoId,
  autoPlay,
  className,
  ...props
}: { videoId: string; autoPlay?: boolean } & BoxProps) => {
  const { allowed } = useThirdPartyConsent();
  if (!allowed) {
    return (
      <Box {...props} className={clsx('relative h-0 overflow-hidden pb-[56.25%]', className)}>
        <div className="absolute left-0 top-0 size-full">
          <ConsentBlockedEmbed kind="youtube" />
        </div>
      </Box>
    );
  }
  return (
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
};
