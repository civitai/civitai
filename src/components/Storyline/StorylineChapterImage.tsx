import { IconEyeOff } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { MediaType } from '~/shared/utils/prisma/enums';

/**
 * A chapter's first image as the storyline reads return it on each row (`firstImage`), already
 * limited to what the reader may see.
 */
export type StorylineCoverImage = {
  id: number;
  url: string;
  type: MediaType;
  width: number | null;
  height: number | null;
  nsfwLevel: number;
  hash: string | null;
  userId: number;
  minor?: boolean;
  poi?: boolean;
};

/**
 * Portrait chapter art: the cover through the normal image guard, or a striped placeholder for a
 * chapter the reader cannot open. The overlay (a rank chip) shows on both.
 */
export function StorylineChapterImage({
  image,
  hidden,
  hiddenLabel,
  className,
  overlay,
}: {
  image: StorylineCoverImage | null | undefined;
  hidden: boolean;
  hiddenLabel?: string;
  className: string;
  overlay?: ReactNode;
}) {
  if (hidden)
    return (
      <div
        className={clsx(
          'relative flex flex-col items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed border-gray-4 p-3 text-center text-gray-6 dark:border-dark-3 dark:text-dark-2',
          'bg-[repeating-linear-gradient(135deg,var(--mantine-color-gray-1)_0_8px,var(--mantine-color-gray-0)_8px_16px)]',
          'dark:bg-[repeating-linear-gradient(135deg,var(--mantine-color-dark-6)_0_8px,var(--mantine-color-dark-5)_8px_16px)]',
          className
        )}
        data-testid="storyline-chapter-image-hidden"
      >
        <IconEyeOff size={22} />
        {hiddenLabel && (
          <span className="text-xs leading-snug" data-testid="storyline-chapter-image-hidden-label">
            {hiddenLabel}
          </span>
        )}
        {overlay}
      </div>
    );
  return (
    <div
      className={clsx('relative overflow-hidden rounded-lg bg-gray-1 dark:bg-dark-5', className)}
    >
      {image && (
        <ImageGuard2 image={image}>
          {(safe) => (
            <>
              {safe ? (
                <EdgeMedia
                  src={image.url}
                  type={image.type}
                  width={450}
                  loading="lazy"
                  className="size-full object-cover object-[50%_20%]"
                  data-testid="storyline-chapter-image"
                />
              ) : (
                <MediaHash {...image} />
              )}
              <div className="absolute right-2 top-2 z-10">
                <ImageGuard2.BlurToggle radius="xl" />
              </div>
            </>
          )}
        </ImageGuard2>
      )}
      {overlay}
    </div>
  );
}
