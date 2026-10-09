import { Badge } from '@mantine/core';
import { IconPhoto, IconVideo } from '@tabler/icons-react';
import clsx from 'clsx';
import { CrucibleContentLevelBadges } from '~/components/Crucible/CrucibleContentLevelBadges';
import { MediaType } from '~/shared/utils/prisma/enums';

type Props = {
  contentType: MediaType;
  nsfwLevel: number;
  /** Smaller badges, the media type as an icon and the levels as one range — for phone headers. */
  compact?: boolean;
  className?: string;
};

/** The media type badge plus the content levels a crucible allows. */
export function CrucibleContentBadges({ contentType, nsfwLevel, compact, className }: Props) {
  const isVideo = contentType === MediaType.video;
  const mediaLabel = isVideo ? 'Videos' : 'Images';
  const MediaIcon = isVideo ? IconVideo : IconPhoto;
  return (
    <div
      className={clsx(
        'flex items-center',
        compact ? 'flex-nowrap gap-0.5' : 'flex-wrap gap-1',
        className
      )}
    >
      {compact ? (
        <Badge
          size="xs"
          variant="light"
          color="gray"
          px={4}
          aria-label={mediaLabel}
          title={mediaLabel}
        >
          <MediaIcon size={10} className="block" />
        </Badge>
      ) : (
        <Badge size="sm" variant="light" color="gray" leftSection={<MediaIcon size={12} />}>
          {mediaLabel}
        </Badge>
      )}
      <CrucibleContentLevelBadges
        nsfwLevel={nsfwLevel}
        size={compact ? 'xs' : 'sm'}
        compact={compact}
        className={compact ? 'contents' : undefined}
      />
    </div>
  );
}
