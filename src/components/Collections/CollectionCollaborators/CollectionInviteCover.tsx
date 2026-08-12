import { IconPhoto } from '@tabler/icons-react';
import clsx from 'clsx';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MediaType } from '~/shared/utils/prisma/enums';
import type { CollectionMyInvite } from '~/types/router';

export function CollectionInviteCover({
  collection,
  className,
  size = 32,
}: {
  collection: CollectionMyInvite['collection'];
  className?: string;
  size?: number;
}) {
  const { image } = collection;
  const frame = clsx(
    'shrink-0 rounded-sm border border-gray-3 bg-gray-1 dark:border-dark-4 dark:bg-dark-6',
    className
  );

  if (!image)
    return (
      <div
        className={clsx(frame, 'flex items-center justify-center')}
        style={{ width: size, height: size }}
      >
        <IconPhoto size={Math.round(size / 2)} className="text-gray-6 dark:text-dark-2" />
      </div>
    );

  return (
    <div className={clsx(frame, 'relative overflow-hidden')} style={{ width: size, height: size }}>
      <ImageGuard2 image={image} explain={false} connectType="collection" connectId={collection.id}>
        {(show) =>
          show ? (
            // A video cover goes through EdgeVideo, whose 80px play-button overlay swallows a
            // small tile. Request the transcoded still and render it as a plain image instead.
            <EdgeMedia
              src={image.url}
              type="image"
              transcode={image.type === MediaType.video}
              anim={false}
              width={size * 2}
              alt=""
              className="size-full object-cover"
              placeholder="empty"
              loading="lazy"
            />
          ) : (
            <MediaHash {...image} />
          )
        }
      </ImageGuard2>
    </div>
  );
}
