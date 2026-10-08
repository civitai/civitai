import { Badge } from '@mantine/core';
import { IconPhoto, IconVideo } from '@tabler/icons-react';
import clsx from 'clsx';
import { CrucibleContentLevelBadges } from '~/components/Crucible/CrucibleContentLevelBadges';
import { MediaType } from '~/shared/utils/prisma/enums';

type Props = {
  contentType: MediaType;
  nsfwLevel: number;
  className?: string;
};

/** The media type badge plus the content levels a crucible allows. */
export function CrucibleContentBadges({ contentType, nsfwLevel, className }: Props) {
  const isVideo = contentType === MediaType.video;
  return (
    <div className={clsx('flex flex-wrap items-center gap-1', className)}>
      <Badge
        size="sm"
        variant="light"
        color="gray"
        leftSection={isVideo ? <IconVideo size={12} /> : <IconPhoto size={12} />}
      >
        {isVideo ? 'Videos' : 'Images'}
      </Badge>
      <CrucibleContentLevelBadges nsfwLevel={nsfwLevel} />
    </div>
  );
}
