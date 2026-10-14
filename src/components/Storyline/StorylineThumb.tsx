import { Skeleton } from '@mantine/core';
import { IconPhoto } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { MediaType } from '~/shared/utils/prisma/enums';

export type StorylineThumbImage = {
  id: number;
  url: string;
  type: MediaType;
  nsfwLevel: number;
  hash?: string | null;
  width?: number | null;
  height?: number | null;
  userId?: number;
};

/**
 * A portrait thumb, 3:4 unless `ratio` says 4:5, cropped near the top so faces survive.
 * `undefined` while the image is loading, `null` when there is none to show (or none this viewer
 * may see).
 */
export function StorylineThumb({
  image,
  width,
  ratio = '3/4',
  fluid,
  dimmed,
  className,
  children,
}: {
  image: StorylineThumbImage | null | undefined;
  /** Rendered width in px; also sizes the image request. */
  width: number;
  ratio?: '3/4' | '4/5';
  /** Fill the parent's width instead; `width` then only sizes the image request. */
  fluid?: boolean;
  /** Fades the picture, not what is laid over it. */
  dimmed?: boolean;
  className?: string;
  /** Laid over the image, e.g. a chip. */
  children?: ReactNode;
}) {
  return (
    <div
      className={clsx(
        'relative overflow-hidden rounded-md',
        ratio === '4/5' ? 'aspect-[4/5]' : 'aspect-[3/4]',
        fluid && 'w-full',
        className
      )}
      style={fluid ? undefined : { width }}
    >
      <div className={clsx('absolute inset-0', dimmed && 'opacity-50')}>
        {image === undefined ? (
          <Skeleton className="absolute inset-0" />
        ) : image === null ? (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-1 text-gray-5 dark:bg-dark-5 dark:text-dark-2">
            <IconPhoto size={Math.min(28, Math.round(width / 3))} stroke={1.5} />
          </div>
        ) : (
          // No explainer: its Show button cannot sit inside a tile button, nor fit 48px.
          <ImageGuard2 image={image} explain={false}>
            {(safe) =>
              safe ? (
                <EdgeMedia
                  src={image.url}
                  type={image.type}
                  width={width * 2}
                  className="absolute inset-0 size-full object-cover object-[50%_20%]"
                  loading="lazy"
                />
              ) : (
                <MediaHash {...image} className="absolute inset-0" cropFocus="top" />
              )
            }
          </ImageGuard2>
        )}
      </div>
      {children}
    </div>
  );
}
